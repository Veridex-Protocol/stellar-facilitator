/**
 * Veridex Bazaar Discovery Engine - P2P Libp2p GossipSub Mesh
 * License: Apache-2.0
 *
 * Implements federated catalog discovery using libp2p GossipSub:
 * - Active node heartbeat announcements
 * - Catalog resource gossip
 * - Peer discovery and connection management
 */

import { createLibp2p, Libp2p } from "libp2p";
import { tcp } from "@libp2p/tcp";
import { noise } from "@libp2p/noise";
import { mplex } from "@libp2p/mplex";
import { gossipsub } from "@libp2p/gossipsub";
import { fromString as uint8ArrayFromString } from "uint8arrays/from-string";
import { toString as uint8ArrayToString } from "uint8arrays/to-string";
import type { Message } from "@libp2p/interface";
import {
  type P2PMeshConfig,
  type HeartbeatPayload,
  type CatalogAnnouncement,
  type P2PMessage,
  type PeerStatus,
  MessageType,
  DEFAULT_P2P_CONFIG,
} from "./types.js";

export class BazaarP2PMesh {
  private node: Libp2p | null = null;
  private config: P2PMeshConfig;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private peers: Map<string, PeerStatus> = new Map();
  private onHeartbeatCallback?: (payload: HeartbeatPayload) => Promise<void>;
  private onCatalogAnnounceCallback?: (payload: CatalogAnnouncement) => Promise<void>;

  constructor(config: Partial<P2PMeshConfig> = {}) {
    this.config = { ...DEFAULT_P2P_CONFIG, ...config };
  }

  /**
   * Initialize and start the libp2p node
   */
  async start(): Promise<void> {
    console.log("[P2P Mesh] Initializing libp2p node...");

    this.node = await createLibp2p({
      addresses: {
        listen: this.config.listenAddrs,
      },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [mplex()],
      services: {
        pubsub: gossipsub({
          emitSelf: false,
          allowPublishToZeroTopicPeers: true,
        }),
      },
    });

    await this.node.start();
    console.log(`[P2P Mesh] Node started. PeerId: ${this.node.peerId.toString()}`);

    // Subscribe to GossipSub topics
    for (const topic of this.config.gossipSubTopics) {
      this.node.services.pubsub.subscribe(topic);
      console.log(`[P2P Mesh] Subscribed to topic: ${topic}`);
    }

    // Handle incoming messages
    this.node.services.pubsub.addEventListener("message", this.handleMessage.bind(this));

    // Handle peer connections
    this.node.addEventListener("peer:connect", (evt) => {
      const peerId = evt.detail.toString();
      console.log(`[P2P Mesh] Peer connected: ${peerId}`);
      this.peers.set(peerId, {
        peerId,
        connected: true,
        lastSeen: new Date(),
        messageCount: 0,
      });
    });

    this.node.addEventListener("peer:disconnect", (evt) => {
      const peerId = evt.detail.toString();
      console.log(`[P2P Mesh] Peer disconnected: ${peerId}`);
      const peer = this.peers.get(peerId);
      if (peer) {
        peer.connected = false;
      }
    });

    // Connect to bootstrap peers
    if (this.config.bootstrapPeers && this.config.bootstrapPeers.length > 0) {
      await this.connectToBootstrapPeers();
    }

    // Start heartbeat interval
    this.startHeartbeat();
  }

  /**
   * Stop the libp2p node
   */
  async stop(): Promise<void> {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.node) {
      await this.node.stop();
      console.log("[P2P Mesh] Node stopped");
      this.node = null;
    }
  }

  /**
   * Publish a heartbeat announcement to the mesh
   */
  async publishHeartbeat(payload: HeartbeatPayload): Promise<void> {
    const message: P2PMessage = {
      type: MessageType.HEARTBEAT,
      payload,
      timestamp: Date.now(),
      senderId: this.node?.peerId.toString() || "unknown",
    };

    await this.publish("/x402/bazaar/v1/announce", message);
  }

  /**
   * Publish a catalog announcement to the mesh
   */
  async publishCatalogAnnouncement(payload: CatalogAnnouncement): Promise<void> {
    const message: P2PMessage = {
      type: MessageType.CATALOG_ANNOUNCE,
      payload,
      timestamp: Date.now(),
      senderId: this.node?.peerId.toString() || "unknown",
    };

    await this.publish("/x402/bazaar/v1/announce", message);
  }

  /**
   * Set callback for heartbeat messages
   */
  onHeartbeat(callback: (payload: HeartbeatPayload) => Promise<void>): void {
    this.onHeartbeatCallback = callback;
  }

  /**
   * Set callback for catalog announcements
   */
  onCatalogAnnounce(callback: (payload: CatalogAnnouncement) => Promise<void>): void {
    this.onCatalogAnnounceCallback = callback;
  }

  /**
   * Get connected peers
   */
  getPeers(): PeerStatus[] {
    return Array.from(this.peers.values());
  }

  /**
   * Get peer count
   */
  getPeerCount(): number {
    return Array.from(this.peers.values()).filter(p => p.connected).length;
  }

  /**
   * Get node peer ID
   */
  getPeerId(): string {
    return this.node?.peerId.toString() || "";
  }

  /**
   * Private: Publish message to GossipSub topic
   */
  private async publish(topic: string, message: P2PMessage): Promise<void> {
    if (!this.node) {
      throw new Error("P2P node not initialized");
    }

    const data = uint8ArrayFromString(JSON.stringify(message));
    await this.node.services.pubsub.publish(topic, data);
  }

  /**
   * Private: Handle incoming GossipSub messages
   */
  private async handleMessage(evt: CustomEvent<Message>): Promise<void> {
    const { topic, data, from } = evt.detail;

    try {
      const messageStr = uint8ArrayToString(data);
      const message: P2PMessage = JSON.parse(messageStr);

      // Update peer stats
      const peerId = from.toString();
      const peer = this.peers.get(peerId);
      if (peer) {
        peer.lastSeen = new Date();
        peer.messageCount++;
      }

      // Route message by type
      switch (message.type) {
        case MessageType.HEARTBEAT:
          if (this.onHeartbeatCallback) {
            await this.onHeartbeatCallback(message.payload as HeartbeatPayload);
          }
          break;

        case MessageType.CATALOG_ANNOUNCE:
          if (this.onCatalogAnnounceCallback) {
            await this.onCatalogAnnounceCallback(message.payload as CatalogAnnouncement);
          }
          break;

        default:
          console.warn(`[P2P Mesh] Unknown message type: ${message.type}`);
      }
    } catch (error) {
      console.error("[P2P Mesh] Error handling message:", error);
    }
  }

  /**
   * Private: Connect to bootstrap peers
   */
  private async connectToBootstrapPeers(): Promise<void> {
    if (!this.node || !this.config.bootstrapPeers) {
      return;
    }

    for (const addr of this.config.bootstrapPeers) {
      try {
        console.log(`[P2P Mesh] Connecting to bootstrap peer: ${addr}`);
        await this.node.dial(addr);
      } catch (error) {
        console.error(`[P2P Mesh] Failed to connect to ${addr}:`, error);
      }
    }
  }

  /**
   * Private: Start periodic heartbeat
   */
  private startHeartbeat(): void {
    // Placeholder - actual heartbeat logic would be implemented by the service
    // This just demonstrates the structure
    this.heartbeatInterval = setInterval(() => {
      // Cleanup disconnected peers
      const now = Date.now();
      const staleThreshold = this.config.heartbeatIntervalMs * this.config.maxMissedHeartbeats;

      for (const [peerId, peer] of this.peers.entries()) {
        const timeSinceLastSeen = now - peer.lastSeen.getTime();
        if (timeSinceLastSeen > staleThreshold) {
          console.log(`[P2P Mesh] Removing stale peer: ${peerId}`);
          this.peers.delete(peerId);
        }
      }
    }, this.config.heartbeatIntervalMs);
  }
}

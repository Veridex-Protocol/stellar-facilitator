/**
 * Veridex Bazaar Discovery Engine - P2P Node Implementation
 * License: Apache-2.0
 *
 * Implements a libp2p node with GossipSub for federated catalog discovery.
 * Handles message validation, signature verification, and deduplication.
 */

import { createLibp2p } from "libp2p";
import { tcp } from "@libp2p/tcp";
import { webSockets } from "@libp2p/websockets";
import { kadDHT } from "@libp2p/kad-dht";
import { ping } from "@libp2p/ping";
import { identify } from "@libp2p/identify";
import { noise } from "@libp2p/noise";
import { mplex } from "@libp2p/mplex";
import { gossipsub } from "@chainsafe/libp2p-gossipsub";
import { Keypair } from "@stellar/stellar-sdk";
import { fromString as uint8ArrayFromString } from "uint8arrays/from-string";
import { toString as uint8ArrayToString } from "uint8arrays/to-string";
import {
  type P2PNodeConfig,
  type AnnounceMessage,
  type PeerStatus,
  type P2PStats,
  type MessageHandler,
  type ValidationResult,
  P2PError,
  P2PErrorType,
  BAZAAR_ANNOUNCE_TOPIC,
  AnnounceMessageSchema,
  createMessageHash,
  createSignaturePayload,
  DEFAULT_P2P_CONFIG,
} from "./types.js";

/**
 * P2P Node for Bazaar Discovery Mesh
 *
 * Features:
 * - Ed25519 signature verification using Stellar SDK
 * - Message deduplication via (nodeId, sequence) tracking
 * - Automatic re-gossip of valid messages (excluding origin)
 * - Peer connection management
 * - Bootstrap peer support
 */
export class P2PNode {
  private libp2p: any = null;
  private config: P2PNodeConfig;
  private peers: Map<string, PeerStatus> = new Map();

  // Message deduplication cache: messageHash -> timestamp
  private seenMessages: Map<string, number> = new Map();
  private highestSequenceByNode: Map<string, number> = new Map();
  private readonly MESSAGE_CACHE_TTL_MS = 300_000; // 5 minutes
  private readonly MAX_CLOCK_SKEW_MS = 300_000;

  // Statistics
  private stats: P2PStats = {
    peerId: "",
    connectedPeers: 0,
    messagesReceived: 0,
    messagesPublished: 0,
    messagesSuppressed: 0,
    uptime: 0,
  };
  private startTime: number = 0;

  // Message handler callback
  private messageHandler?: MessageHandler;

  // Cleanup interval
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(config: P2PNodeConfig) {
    this.config = { ...DEFAULT_P2P_CONFIG, ...config };
  }

  /**
   * Start the P2P node and subscribe to GossipSub topics
   */
  async start(): Promise<void> {
    console.log("[P2P Node] Initializing libp2p node...");

    // Create libp2p node with TCP transport, Noise encryption, and Mplex muxing
    this.libp2p = await createLibp2p({
      addresses: {
        listen: this.config.listenAddrs,
      },
      transports: [tcp(), webSockets()],
      connectionEncrypters: [noise()],
      streamMuxers: [mplex()],
      services: {
        identify: identify(),
        ping: ping(),
        dht: kadDHT(),
        pubsub: gossipsub({
          emitSelf: false, // Don't receive our own messages
          allowPublishToZeroTopicPeers: true, // Allow publishing when no peers (for testing)
          scoreThresholds: {
            // Relax peer scoring to allow mesh formation
            gossipThreshold: -100,
            publishThreshold: -100,
            graylistThreshold: -100,
          },
        }) as any,
      },
    });

    await this.libp2p.start();

    const peerId = this.libp2p.peerId.toString();
    this.stats.peerId = peerId;
    this.startTime = Date.now();

    console.log(`[P2P Node] Node started successfully`);
    console.log(`[P2P Node] PeerId: ${peerId}`);
    console.log(`[P2P Node] Listen addresses:`, this.config.listenAddrs);

    // Subscribe to Bazaar announcement topic
    this.libp2p.services.pubsub.subscribe(BAZAAR_ANNOUNCE_TOPIC);
    console.log(`[P2P Node] Subscribed to topic: ${BAZAAR_ANNOUNCE_TOPIC}`);

    // Set up message handler
    this.libp2p.services.pubsub.addEventListener(
      "message",
      this.handleIncomingMessage.bind(this)
    );

    // Set up peer event handlers
    this.setupPeerHandlers();

    // Connect to bootstrap peers if configured
    if (this.config.bootstrapPeers && this.config.bootstrapPeers.length > 0) {
      await this.connectToBootstrapPeers();
    }

    // Start cleanup interval for seen messages cache
    this.startCleanupInterval();
  }

  /**
   * Stop the P2P node and clean up resources
   */
  async stop(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    if (this.libp2p) {
      await this.libp2p.stop();
      console.log("[P2P Node] Node stopped");
      this.libp2p = null;
    }
  }

  /**
   * Publish an announcement message to the P2P mesh
   *
   * @param message - Announcement message to publish
   */
  async publishAnnouncement(message: AnnounceMessage): Promise<void> {
    if (!this.libp2p) {
      throw new P2PError(
        P2PErrorType.NOT_INITIALIZED,
        "P2P node not initialized"
      );
    }

    try {
      // Validate message schema
      const validated = AnnounceMessageSchema.parse(message);

      if (!this.isFresh(validated) || !this.verifySignature(validated)) {
        throw new Error("Announcement signature or timestamp is invalid");
      }

      // Convert to bytes
      const messageBytes = uint8ArrayFromString(JSON.stringify(validated));

      // Publish to GossipSub topic
      await this.libp2p.services.pubsub.publish(
        BAZAAR_ANNOUNCE_TOPIC,
        messageBytes
      );

      this.stats.messagesPublished++;
      console.log(
        `[P2P Node] Published announcement for ${validated.resourceUrl}`
      );
    } catch (error) {
      throw new P2PError(
        P2PErrorType.PUBLISH_FAILED,
        "Failed to publish announcement",
        { error, message }
      );
    }
  }

  /**
   * Set the message handler callback
   *
   * @param handler - Async function to handle validated messages
   */
  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  /**
   * Get current P2P statistics
   */
  getStats(): P2PStats {
    return {
      ...this.stats,
      connectedPeers: Array.from(this.peers.values()).filter((p) => p.connected)
        .length,
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
    };
  }

  /**
   * Get list of connected peers
   */
  getPeers(): PeerStatus[] {
    return Array.from(this.peers.values());
  }

  /**
   * Get node's PeerId
   */
  getPeerId(): string {
    return this.stats.peerId;
  }

  /**
   * Handle incoming GossipSub message
   *
   * Flow:
   * 1. Parse JSON
   * 2. Validate schema
   * 3. Check for duplicates
   * 4. Verify Ed25519 signature
   * 5. Call message handler
   * 6. Re-gossip to other peers
   */
  private async handleIncomingMessage(evt: CustomEvent<any>): Promise<void> {
    this.stats.messagesReceived++;

    try {
      const { data, from } = evt.detail;
      const fromPeerId = from.toString();

      // Parse message JSON
      const messageStr = uint8ArrayToString(data);
      let message: any;

      try {
        message = JSON.parse(messageStr);
      } catch {
        console.warn("[P2P Node] Received invalid JSON message");
        this.stats.messagesSuppressed++;
        return;
      }

      // Validate message schema
      const validation = this.validateMessage(message);
      if (!validation.valid) {
        console.warn(`[P2P Node] Invalid message: ${validation.error}`);
        this.stats.messagesSuppressed++;
        return;
      }

      const validatedMessage = validation.message!;

      if (!this.isFresh(validatedMessage)) {
        console.warn(`[P2P Node] Stale or future-dated message from ${validatedMessage.nodeId}`);
        this.stats.messagesSuppressed++;
        return;
      }

      // Check for duplicate (replay protection)
      if (this.isDuplicate(validatedMessage)) {
        console.debug(
          `[P2P Node] Duplicate message from ${validatedMessage.nodeId}:${validatedMessage.sequence}`
        );
        this.stats.messagesSuppressed++;
        return;
      }

      // Verify Ed25519 signature
      if (!this.verifySignature(validatedMessage)) {
        console.warn(
          `[P2P Node] Invalid signature from ${validatedMessage.nodeId}`
        );
        this.stats.messagesSuppressed++;
        return;
      }

      // Mark as seen (deduplication)
      this.markAsSeen(validatedMessage);

      // Update peer stats
      const peer = this.peers.get(fromPeerId);
      if (peer) {
        peer.lastSeen = new Date();
        peer.messageCount++;
      }

      // Call message handler if set
      if (this.messageHandler) {
        try {
          await this.messageHandler(validatedMessage);
        } catch (error) {
          console.error("[P2P Node] Message handler error:", error);
        }
      }

      // Re-gossip to other peers (automatic via GossipSub)
      // GossipSub handles this automatically when we don't suppress the message

      console.log(
        `[P2P Node] Processed valid message from ${validatedMessage.nodeId} for ${validatedMessage.resourceUrl}`
      );
    } catch (error) {
      console.error("[P2P Node] Error handling message:", error);
      this.stats.messagesSuppressed++;
    }
  }

  /**
   * Validate message against schema
   */
  private validateMessage(message: any): ValidationResult {
    try {
      const validated = AnnounceMessageSchema.parse(message);
      return { valid: true, message: validated };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : "Validation failed",
      };
    }
  }

  /**
   * Check if message has already been seen (deduplication)
   */
  private isDuplicate(message: AnnounceMessage): boolean {
    const hash = createMessageHash(message.nodeId, message.sequence);
    const highestSequence = this.highestSequenceByNode.get(message.nodeId);
    return this.seenMessages.has(hash) ||
      (highestSequence !== undefined && message.sequence <= highestSequence);
  }

  /**
   * Mark message as seen for deduplication
   */
  private markAsSeen(message: AnnounceMessage): void {
    const hash = createMessageHash(message.nodeId, message.sequence);
    this.seenMessages.set(hash, Date.now());
    this.highestSequenceByNode.set(message.nodeId, message.sequence);
  }

  private isFresh(message: AnnounceMessage): boolean {
    return Math.abs(Date.now() - message.timestamp) <= this.MAX_CLOCK_SKEW_MS;
  }

  /**
   * Verify Ed25519 signature using Stellar SDK
   *
   * Signature is over: `${resourceUrl}:${timestamp}:${sequence}`
   */
  private verifySignature(message: AnnounceMessage): boolean {
    try {
      // Create signature payload
      const payload = createSignaturePayload(
        message.resourceUrl,
        message.timestamp,
        message.sequence
      );

      // Convert payload to Buffer
      const payloadBuffer = Buffer.from(payload, "utf-8");

      // Parse signature (base64 or hex)
      const signatureBuffer = Buffer.from(message.signature, "base64");
      if (signatureBuffer.length !== 64) return false;

      try {
        const keypair = Keypair.fromPublicKey(message.nodeId);
        return keypair.verify(payloadBuffer, signatureBuffer);
      } catch {
        console.warn(`[P2P Node] Cannot verify signature: nodeId is not a Stellar G-address`);
        return false;
      }
    } catch (error) {
      console.error("[P2P Node] Signature verification error:", error);
      return false;
    }
  }

  /**
   * Set up peer connection event handlers
   */
  private setupPeerHandlers(): void {
    if (!this.libp2p) return;

    this.libp2p.addEventListener("peer:connect", (evt: any) => {
      const peerId = evt.detail.toString();
      console.log(`[P2P Node] Peer connected: ${peerId}`);

      this.peers.set(peerId, {
        peerId,
        connected: true,
        lastSeen: new Date(),
        messageCount: 0,
        multiaddrs: [],
      });
    });

    this.libp2p.addEventListener("peer:disconnect", (evt: any) => {
      const peerId = evt.detail.toString();
      console.log(`[P2P Node] Peer disconnected: ${peerId}`);

      const peer = this.peers.get(peerId);
      if (peer) {
        peer.connected = false;
      }
    });
  }

  /**
   * Connect to configured bootstrap peers
   */
  private async connectToBootstrapPeers(): Promise<void> {
    if (!this.libp2p || !this.config.bootstrapPeers) return;

    console.log(
      `[P2P Node] Connecting to ${this.config.bootstrapPeers.length} bootstrap peers...`
    );

    for (const addr of this.config.bootstrapPeers) {
      try {
        await this.libp2p.dial(addr as any);
        console.log(`[P2P Node] Connected to bootstrap peer: ${addr}`);
      } catch (error) {
        console.error(`[P2P Node] Failed to connect to ${addr}:`, error);
      }
    }
  }

  /**
   * Start cleanup interval for seen messages cache
   */
  private startCleanupInterval(): void {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      const expired: string[] = [];

      for (const [hash, timestamp] of this.seenMessages.entries()) {
        if (now - timestamp > this.MESSAGE_CACHE_TTL_MS) {
          expired.push(hash);
        }
      }

      for (const hash of expired) {
        this.seenMessages.delete(hash);
      }

      if (expired.length > 0) {
        console.log(`[P2P Node] Cleaned up ${expired.length} expired message hashes`);
      }
    }, 60_000); // Run every minute
  }
}

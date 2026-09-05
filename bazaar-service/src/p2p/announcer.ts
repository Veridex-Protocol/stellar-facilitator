/**
 * Veridex Bazaar Discovery Engine - Announcement Helper
 * License: Apache-2.0
 *
 * Utilities for creating and signing announcement messages.
 * Uses Stellar Ed25519 keypairs for message signing.
 */

import { Keypair } from "@stellar/stellar-sdk";
import {
  type AnnounceMessage,
  type CatalogDelta,
  type CatalogDeltaInput,
  CatalogDeltaUnsignedSchema,
  type TelemetrySnapshot,
  createCatalogDeltaSignaturePayload,
  createSignaturePayload,
} from "./types.js";

/**
 * Resource metadata for announcements
 */
export interface ResourceMetadata {
  resourceUrl: string;
  toolName?: string;
  resourceType?: "http" | "mcp";
  serviceName?: string;
  description?: string;
  tags?: string[];
  iconUrl?: string;
  routeTemplate?: string;
  mimeType?: string;
  inputSpec?: Record<string, unknown>;
  outputSpec?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
  payTo?: string;
  network?: string;
  scheme?: string;
}

/**
 * Announcement builder for creating signed P2P messages
 *
 * Usage:
 * ```typescript
 * const keypair = Keypair.random();
 * const announcer = new Announcer(keypair);
 *
 * const message = await announcer.createAnnouncement({
 *   resourceUrl: "https://api.example.com/weather",
 *   serviceName: "Weather API",
 *   payTo: "GXXXXXXX...",
 * }, {
 *   avgResponseTimeMs: 150,
 *   uptime30d: 99.5,
 *   successfulSettlements: 1250,
 * });
 * ```
 */
export class Announcer {
  private keypair: Keypair;
  private sequenceCounter: number = Date.now();

  constructor(keypair: Keypair) {
    this.keypair = keypair;
  }

  /**
   * Create a signed announcement message
   *
   * @param metadata - Resource metadata
   * @param telemetry - Current telemetry snapshot
   * @returns Signed announcement message
   */
  async createAnnouncement(
    metadata: ResourceMetadata,
    telemetry: TelemetrySnapshot
  ): Promise<AnnounceMessage> {
    // Increment sequence number (monotonic per node)
    const sequence = this.sequenceCounter++;
    const timestamp = Date.now();

    const baseMessage: Omit<AnnounceMessage, "signature"> = {
      nodeId: this.keypair.publicKey(),
      resourceUrl: metadata.resourceUrl,
      toolName: metadata.toolName,
      resourceType: metadata.resourceType,
      serviceName: metadata.serviceName,
      description: metadata.description,
      tags: metadata.tags,
      iconUrl: metadata.iconUrl,
      routeTemplate: metadata.routeTemplate,
      mimeType: metadata.mimeType,
      inputSpec: metadata.inputSpec,
      outputSpec: metadata.outputSpec,
      extensions: metadata.extensions,
      payTo: metadata.payTo,
      network: metadata.network,
      scheme: metadata.scheme,
      timestamp,
      sequence,
      telemetry,
    };

    // Create signature payload covering full metadata
    const payload = createSignaturePayload(
      metadata.resourceUrl,
      timestamp,
      sequence,
      baseMessage
    );

    // Sign with Ed25519
    const signature = this.sign(payload);

    return {
      ...baseMessage,
      signature,
    };
  }

  /**
   * Create a heartbeat announcement (minimal metadata)
   *
   * @param resourceUrl - Resource URL
   * @param telemetry - Current telemetry
   * @returns Signed heartbeat message
   */
  async createHeartbeat(
    resourceUrl: string,
    telemetry: TelemetrySnapshot,
    toolName?: string
  ): Promise<AnnounceMessage> {
    return this.createAnnouncement(
      {
        resourceUrl,
        toolName,
      },
      telemetry
    );
  }

  /**
   * Create a signed, versioned catalog snapshot. Revisions belong to the
   * resource identity, not to the heartbeat sequence, so delayed heartbeats
   * cannot overwrite catalog state.
   */
  createSignedCatalogDelta(input: CatalogDeltaInput): CatalogDelta {
    const unsigned = CatalogDeltaUnsignedSchema.parse({
      v: "veridex/bazaar/catalog-delta/1",
      ...input,
      toolName: input.toolName || "",
    });
    const signature = this.sign(createCatalogDeltaSignaturePayload(unsigned));
    return {
      ...unsigned,
      signer: this.keypair.publicKey(),
      signature,
    };
  }

  /**
   * Get current sequence number
   */
  getSequence(): number {
    return this.sequenceCounter;
  }

  /**
   * Reset sequence counter (for testing)
   */
  resetSequence(): void {
    this.sequenceCounter = 0;
  }

  /**
   * Get node's public key (Stellar G-address)
   */
  getPublicKey(): string {
    return this.keypair.publicKey();
  }

  /**
   * Sign a payload with Ed25519
   *
   * @param payload - String to sign
   * @returns Base64-encoded signature
   */
  private sign(payload: string): string {
    const payloadBuffer = Buffer.from(payload, "utf-8");
    const signatureBuffer = this.keypair.sign(payloadBuffer);
    return signatureBuffer.toString("base64");
  }
}

/**
 * Create an announcer from a secret key
 *
 * @param secretKey - Stellar secret key (S...)
 * @returns Announcer instance
 */
export function createAnnouncer(secretKey: string): Announcer {
  const keypair = Keypair.fromSecret(secretKey);
  return new Announcer(keypair);
}

/**
 * Create an announcer with a random keypair (for testing)
 *
 * @returns Announcer instance and secret key
 */
export function createRandomAnnouncer(): {
  announcer: Announcer;
  secretKey: string;
  publicKey: string;
} {
  const keypair = Keypair.random();
  return {
    announcer: new Announcer(keypair),
    secretKey: keypair.secret(),
    publicKey: keypair.publicKey(),
  };
}

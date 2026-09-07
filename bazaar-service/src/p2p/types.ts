/**
 * Veridex Bazaar Discovery Engine - P2P Message Types
 * License: Apache-2.0
 *
 * Type definitions for P2P mesh communication via libp2p GossipSub.
 * All messages must be signed with Ed25519 to prevent spoofing.
 */

import { z } from "zod";
import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";

/**
 * GossipSub topic for Bazaar announcements
 */
export const BAZAAR_ANNOUNCE_TOPIC = "/x402/bazaar/v1/announce";
export const BAZAAR_CATALOG_DELTA_TOPIC = "/x402/bazaar/v1/catalog-delta";

/**
 * Telemetry snapshot at time of heartbeat
 */
export const TelemetrySnapshotSchema = z.object({
  avgResponseTimeMs: z.number().min(0),
  uptime30d: z.number().min(0).max(100), // Percentage (0-100)
  successfulSettlements: z.number().int().min(0).optional(),
});

export type TelemetrySnapshot = z.infer<typeof TelemetrySnapshotSchema>;

/**
 * P2P Announcement Message
 *
 * This message is gossiped across the mesh when:
 * - A resource server comes online
 * - Periodic heartbeat pings (every 30 seconds)
 * - A facilitator indexes a new resource
 *
 * Signature verification:
 * - Message is signed over: `${resourceUrl}:${timestamp}:${sequence}`
 * - Signature is Ed25519 (Stellar keypair compatible)
 * - Public key is encoded in nodeId field
 */
export const AnnounceMessageSchema = z.object({
  // Node identification (Stellar public key or libp2p PeerID)
  nodeId: z.string().min(1),

  // Resource identification
  resourceUrl: z.string().url(),
  toolName: z.string().optional(), // For MCP tools
  resourceType: z.enum(["http", "mcp"]).optional(),

  // Resource metadata (optional, only in full announcements)
  serviceName: z.string().max(32).optional(),
  description: z.string().optional(),
  tags: z.array(z.string().max(32)).max(5).optional(),
  iconUrl: z.string().url().max(2048).optional(),
  routeTemplate: z.string().optional(),
  mimeType: z.string().max(64).optional(),
  inputSpec: z.record(z.any()).optional(),
  outputSpec: z.record(z.any()).optional(),
  extensions: z.record(z.any()).optional(),

  // Payment configuration (optional)
  payTo: z.string().optional(), // Stellar G-address
  network: z.string().optional(), // e.g., stellar:pubnet
  scheme: z.string().optional(), // e.g., exact, upto
  settlementTx: z.string().optional(),

  // Message metadata
  timestamp: z.number().int().positive(), // Unix timestamp in milliseconds
  sequence: z.number().int().min(0), // Monotonic per nodeId

  // Telemetry snapshot
  telemetry: TelemetrySnapshotSchema,

  // Ed25519 signature over canonical announcement digest
  signature: z.string().min(1),
});

export type AnnounceMessage = z.infer<typeof AnnounceMessageSchema>;

/**
 * A signed full catalog snapshot. Full snapshots are used instead of patches
 * so peers can converge after delayed or out-of-order delivery without first
 * recovering an unseen base document.
 */
export const CatalogDeltaStateSchema = z.object({
  resourceType: z.enum(["http", "mcp"]),
  validationUrl: z.string().url().optional(),
  serviceName: z.string().max(32).optional(),
  description: z.string().min(1),
  tags: z.array(z.string().max(32)).max(5).optional(),
  iconUrl: z.string().url().max(2048).optional(),
  routeTemplate: z.string().optional(),
  mimeType: z.string().max(64).default("application/json"),
  inputSpec: z.record(z.any()),
  outputSpec: z.record(z.any()).optional(),
  extensions: z.record(z.any()).optional(),
  scheme: z.string().min(1),
  asset: z.string().min(1),
  amount: z.string().regex(/^(0|[1-9][0-9]*)$/),
  settlementTx: z.string().regex(/^[0-9a-f]{64}$/i),
  uptoContractId: z.string().optional(),
  settlementToken: z.string().optional(),
  settlementMaxAmount: z.string().regex(/^(0|[1-9][0-9]*)$/).optional(),
  settlementActual: z.string().regex(/^(0|[1-9][0-9]*)$/).optional(),
  settlementResultDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/i).optional(),
});

export type CatalogDeltaState = z.infer<typeof CatalogDeltaStateSchema>;

const CatalogDeltaBaseSchema = z.object({
  v: z.literal("veridex/bazaar/catalog-delta/1"),
  op: z.enum(["upsert", "revoke"]),
  resourceUrl: z.string().url(),
  toolName: z.string().default(""),
  payTo: z.string().min(1),
  network: z.string().min(1),
  revision: z.number().int().nonnegative().safe(),
  issuedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  state: CatalogDeltaStateSchema.nullable(),
});

function refineCatalogDelta<T extends z.ZodTypeAny>(schema: T): T {
  return schema.superRefine((delta, context) => {
  if (delta.op === "upsert" && delta.state === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["state"], message: "upsert deltas require a catalog state" });
  }
  if (delta.op === "revoke" && delta.state !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["state"], message: "revoke deltas must not carry catalog state" });
  }
  if (delta.expiresAt <= delta.issuedAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["expiresAt"], message: "expiresAt must be after issuedAt" });
  }
  if (delta.expiresAt - delta.issuedAt > 24 * 60 * 60) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["expiresAt"], message: "catalog delta lifetime may not exceed 24 hours" });
  }
  if (delta.op === "upsert" && delta.state?.scheme === "upto") {
    for (const [field, value] of [
      ["uptoContractId", delta.state.uptoContractId],
      ["settlementToken", delta.state.settlementToken],
      ["settlementMaxAmount", delta.state.settlementMaxAmount],
      ["settlementActual", delta.state.settlementActual],
      ["settlementResultDigest", delta.state.settlementResultDigest],
    ] as const) {
      if (!value) context.addIssue({ code: z.ZodIssueCode.custom, path: ["state", field], message: `upto deltas require ${field}` });
    }
  }
  }) as unknown as T;
}

export const CatalogDeltaUnsignedSchema = refineCatalogDelta(CatalogDeltaBaseSchema);

export const CatalogDeltaSchema = refineCatalogDelta(CatalogDeltaBaseSchema.extend({
  signer: z.string().min(1),
  signature: z.string().min(1),
}));

export type CatalogDelta = z.infer<typeof CatalogDeltaSchema>;
export type CatalogDeltaInput = Omit<CatalogDelta, "v" | "signer" | "signature">;

export const CATALOG_DELTA_DOMAIN_TAG = "VERIDEX-BAZAAR-CATALOG-DELTA:v1";

export function createCatalogDeltaSignaturePayload(delta: CatalogDelta | CatalogDeltaInput): string {
  const { signature: _signature, signer: _signer, ...unsigned } = delta as CatalogDelta;
  return canonicalize({ domain: CATALOG_DELTA_DOMAIN_TAG, ...unsigned });
}

export function catalogDeltaDigest(delta: CatalogDelta | CatalogDeltaInput): string {
  return createHash("sha256")
    .update(createCatalogDeltaSignaturePayload(delta), "utf8")
    .digest("hex");
}

export function catalogDeltaKey(delta: Pick<CatalogDelta, "resourceUrl" | "toolName" | "payTo" | "network">): string {
  return `${delta.network}:${delta.payTo}:${delta.resourceUrl}:${delta.toolName || ""}`;
}

/**
 * Message validation result
 */
export interface ValidationResult {
  valid: boolean;
  error?: string;
  message?: AnnounceMessage;
}

/**
 * Helper to create message hash for deduplication
 * Format: `${nodeId}:${sequence}`
 */
export function createMessageHash(nodeId: string, sequence: number): string {
  return `${nodeId}:${sequence}`;
}

export const ANNOUNCE_DOMAIN_TAG = "VERIDEX-BAZAAR-ANNOUNCE:v2";

/**
 * Creates canonical deterministic announcement payload for Ed25519 signing.
 * Covers all metadata fields to prevent relay tampering (VDX-05).
 */
export function createSignaturePayload(
  resourceUrl: string,
  timestamp: number,
  sequence: number,
  metadata?: Partial<AnnounceMessage>,
): string {
  if (metadata) {
    return canonicalize({
      domain: ANNOUNCE_DOMAIN_TAG,
      nodeId: metadata.nodeId || "",
      resourceUrl,
      toolName: metadata.toolName || "",
      resourceType: metadata.resourceType || "http",
      serviceName: metadata.serviceName || "",
      description: metadata.description || "",
      tags: metadata.tags || [],
      iconUrl: metadata.iconUrl || "",
      routeTemplate: metadata.routeTemplate || "",
      mimeType: metadata.mimeType || "application/json",
      inputSpec: metadata.inputSpec || {},
      outputSpec: metadata.outputSpec || {},
      extensions: metadata.extensions || {},
      payTo: metadata.payTo || "",
      network: metadata.network || "",
      scheme: metadata.scheme || "",
      timestamp,
      sequence,
      telemetry: metadata.telemetry || {},
      settlementTx: metadata.settlementTx || "",
    });
  }
  return `${resourceUrl}:${timestamp}:${sequence}`;
}

/**
 * P2P Node configuration
 */
export interface P2PNodeConfig {
  // Network configuration
  listenAddrs: string[]; // e.g., ["/ip4/0.0.0.0/tcp/4001"]
  bootstrapPeers?: string[]; // Multiaddr strings of bootstrap nodes

  // Gossip configuration
  heartbeatIntervalMs: number; // Default: 30000 (30 seconds)
  maxMissedHeartbeats: number; // Default: 3

  // Node identity (optional - will generate if not provided)
  privateKey?: Uint8Array; // Ed25519 private key for signing

  /** Optional allowlist for private meshes. Relays do not need to be signers. */
  authorizedPeerIds?: string[];

  /**
   * Resource signer delegates. Keys are `${resourceUrl}|${toolName || ""}`;
   * the payTo owner is always accepted for classic G-address payees.
   */
  authorizedHeartbeatSigners?: Record<string, string[]>;

  /** Catalog-delta signer delegates. Keys are `${network}:${payTo}`. */
  authorizedCatalogSigners?: Record<string, string[]>;
}

/**
 * Default P2P configuration
 */
export const DEFAULT_P2P_CONFIG: Omit<P2PNodeConfig, "listenAddrs"> = {
  heartbeatIntervalMs: 30_000, // 30 seconds
  maxMissedHeartbeats: 3,
  bootstrapPeers: [],
};

/**
 * Peer connection status
 */
export interface PeerStatus {
  peerId: string;
  connected: boolean;
  lastSeen: Date;
  messageCount: number;
  multiaddrs: string[];
}

/**
 * P2P Node statistics
 */
export interface P2PStats {
  peerId: string;
  connectedPeers: number;
  messagesReceived: number;
  messagesPublished: number;
  messagesSuppressed: number; // Duplicate/invalid
  replaysRejected: number;
  uptime: number; // Seconds
}

/**
 * Message deduplication cache entry
 */
export interface CacheEntry {
  messageHash: string;
  timestamp: number;
  nodeId: string;
  sequence: number;
}

/**
 * Message handler callback
 */
export type MessageHandler = (message: AnnounceMessage) => Promise<void>;

/**
 * Error types for P2P operations
 */
export enum P2PErrorType {
  INVALID_SIGNATURE = "invalid_signature",
  INVALID_MESSAGE = "invalid_message",
  DUPLICATE_MESSAGE = "duplicate_message",
  PUBLISH_FAILED = "publish_failed",
  CONNECTION_FAILED = "connection_failed",
  NOT_INITIALIZED = "not_initialized",
  UNAUTHORIZED = "unauthorized",
}

/**
 * P2P Error class
 */
export class P2PError extends Error {
  constructor(
    public type: P2PErrorType,
    message: string,
    public details?: any
  ) {
    super(message);
    this.name = "P2PError";
  }
}

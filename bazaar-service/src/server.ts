/**
 * Veridex Bazaar Discovery Service - HTTP Server
 * License: Apache-2.0
 *
 * Exposes REST endpoints for:
 * - GET /discovery/search - Hybrid search (BM25 + feature-hash vector + telemetry)
 * - GET /discovery/resources - List catalog
 * - POST /announce - Accept P2P announcements via HTTP
 * - POST /catalog/ingest - Trigger ingestion worker
 * - GET /health - Health check
 * - GET /stats - P2P and telemetry statistics
 */

import { Hono } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import { cors } from "hono/cors";
import { logger as honoLogger } from "hono/logger";
import { z } from "zod";
import { Database, createDatabase } from "./db/config.js";
import { P2PNode } from "./p2p/node.js";
import { Announcer, createAnnouncer } from "./p2p/announcer.js";
import { TelemetryTracker } from "./telemetry/tracker.js";
import { BazaarSearchEngine } from "./search/engine.js";
import { CatalogIngestionWorker } from "./catalog/ingestion.js";
import { AnnounceMessageSchema, CatalogDeltaSchema, type CatalogDelta } from "./p2p/types.js";
import { InvalidCursorError } from "./search/cursor.js";
import { rateLimit } from "./rate-limit.js";
import { bodyLimit } from "hono/body-limit";
import type { P2PNodeConfig } from "./p2p/types.js";
import type { ResourceMetadata } from "./p2p/announcer.js";
import { catalogDeltaKey } from "./p2p/catalog-delta.js";
import { ProviderQualityStore } from "./provider-quality/store.js";
import { ProviderAggregateSchema, ProviderObservationSchema } from "./provider-quality/types.js";
import { verifyProviderAggregate, verifyProviderObservation } from "./provider-quality/crypto.js";
import { buildProviderAggregate } from "./provider-quality/aggregator.js";
import { createBazaarMetrics, type BazaarMetrics } from "./metrics.js";
import { publicError, type RegisteredErrorCode } from "./errors.js";

/**
 * Bazaar Service configuration
 */
export interface BazaarServiceConfig {
  // HTTP server
  port: number;
  host: string;

  // Database
  database: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    ssl?: boolean;
  };

  // P2P mesh
  p2p: P2PNodeConfig;

  // Stellar keypair for announcements (optional)
  stellarSecretKey?: string;
  /** Horizon endpoint used to confirm the settlements behind catalog entries. */
  horizonUrl: string;
  sorobanRpcUrl: string;
  /** Shared secret the facilitator presents on /catalog/ingest. Required. */
  internalToken: string;
  announcedResources: ResourceMetadata[];
  providerAggregateIssuerSecretKey?: string;
  providerAggregatePublishedThreshold: number;
  providerAggregateProvisionalThreshold: number;
  providerQualityAuthorizedSigners?: string[];
  providerAggregateAuthorizedIssuers?: string[];
  providerAggregateRecomputeQueueLimit?: number;
  catalogRevalidationIntervalMs: number;
  catalogRevalidationStaleMs: number;
  catalogRevalidationTimeoutMs: number;
  catalogRevalidationBatchSize: number;
  catalogRevalidationAllowedOrigins: string[];
  catalogRevalidationTransportOriginMap: Record<string, string>;
}

/**
 * Get default configuration from environment
 */
export function getDefaultConfig(): BazaarServiceConfig {
  return {
    port: parseInt(process.env.BAZAAR_PORT || "3001", 10),
    host: process.env.BAZAAR_HOST || "0.0.0.0",
    database: {
      host: process.env.DATABASE_HOST || "localhost",
      port: parseInt(process.env.DATABASE_PORT || "5432", 10),
      database: process.env.DATABASE_NAME || "veridex_bazaar",
      user: process.env.DATABASE_USER || "postgres",
      password: process.env.DATABASE_PASSWORD || "",
      ssl: process.env.DATABASE_SSL === "true",
    },
    p2p: {
      listenAddrs: (process.env.P2P_LISTEN_ADDRS || "/ip4/0.0.0.0/tcp/4001,/ip4/0.0.0.0/tcp/4002/ws")
        .split(",")
        .map((a) => a.trim()),
      bootstrapPeers: process.env.P2P_BOOTSTRAP_PEERS
        ? process.env.P2P_BOOTSTRAP_PEERS.split(",").map((a) => a.trim())
        : [],
      heartbeatIntervalMs: 30_000,
      maxMissedHeartbeats: 3,
      authorizedPeerIds: process.env.P2P_AUTHORIZED_PEER_IDS
        ? process.env.P2P_AUTHORIZED_PEER_IDS.split(",").map((a) => a.trim()).filter(Boolean)
        : undefined,
      authorizedHeartbeatSigners: parseAuthorizationMap(process.env.P2P_AUTHORIZED_HEARTBEAT_SIGNERS),
      authorizedCatalogSigners: parseAuthorizationMap(process.env.P2P_AUTHORIZED_CATALOG_SIGNERS),
    },
    stellarSecretKey: process.env.STELLAR_SECRET_KEY,
    announcedResources: parseAnnouncedResources(process.env.P2P_ANNOUNCED_RESOURCES),
    providerAggregateIssuerSecretKey: process.env.PROVIDER_AGGREGATE_ISSUER_SECRET_KEY,
    providerAggregatePublishedThreshold: parseInt(process.env.PROVIDER_AGGREGATE_PUBLISHED_THRESHOLD || "100", 10),
    providerAggregateProvisionalThreshold: parseInt(process.env.PROVIDER_AGGREGATE_PROVISIONAL_THRESHOLD || "20", 10),
    providerQualityAuthorizedSigners: parseCsv(process.env.PROVIDER_QUALITY_AUTHORIZED_SIGNERS),
    providerAggregateAuthorizedIssuers: parseCsv(process.env.PROVIDER_AGGREGATE_AUTHORIZED_ISSUERS),
    providerAggregateRecomputeQueueLimit: parseInt(process.env.PROVIDER_AGGREGATE_RECOMPUTE_QUEUE_LIMIT || "256", 10),
    catalogRevalidationIntervalMs: parseInt(process.env.CATALOG_REVALIDATION_INTERVAL_MS || "300000", 10),
    catalogRevalidationStaleMs: parseInt(process.env.CATALOG_REVALIDATION_STALE_MS || "3600000", 10),
    catalogRevalidationTimeoutMs: parseInt(process.env.CATALOG_REVALIDATION_TIMEOUT_MS || "5000", 10),
    catalogRevalidationBatchSize: parseInt(process.env.CATALOG_REVALIDATION_BATCH_SIZE || "20", 10),
    catalogRevalidationAllowedOrigins: parseCsv(process.env.CATALOG_REVALIDATION_ALLOWED_ORIGINS) ?? [],
    catalogRevalidationTransportOriginMap: parseStringMap(process.env.CATALOG_REVALIDATION_TRANSPORT_ORIGIN_MAP),
    horizonUrl: process.env.HORIZON_URL || "https://horizon-testnet.stellar.org",
    sorobanRpcUrl: process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org",
    // Required, not optional. The previous guard read
    // `if (internalToken && ...)`, which skipped authentication entirely when
    // the variable was unset - an open write endpoint on the public catalog.
    internalToken: requireInternalToken(),
  };
}

/**
 * Reads the shared secret protecting catalog writes.
 *
 * @returns The configured token
 * @throws {Error} When it is unset or too short to be a secret
 */
function requireInternalToken(): string {
  const token = process.env.BAZAAR_INTERNAL_TOKEN?.trim();
  if (!token || token.length < 24) {
    throw new Error(
      "BAZAAR_INTERNAL_TOKEN is required and must be at least 24 characters. " +
        "It guards /catalog/ingest, which writes to the public catalog. " +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(24).toString('hex'))\"",
    );
  }
  return token;
}

function parseAuthorizationMap(value?: string): Record<string, string[]> | undefined {
  if (!value) return undefined;
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("P2P authorization maps must be JSON objects of string keys to string arrays");
  }
  return Object.fromEntries(Object.entries(parsed).map(([key, signers]) => {
    if (!Array.isArray(signers) || signers.some((signer) => typeof signer !== "string")) {
      throw new Error(`P2P authorization map entry '${key}' must contain string signers`);
    }
    return [key, signers];
  }));
}

function parseCsv(value?: string): string[] | undefined {
  if (!value) return undefined;
  const values = value.split(",").map((item) => item.trim()).filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function parseStringMap(value?: string): Record<string, string> {
  if (!value) return {};
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("catalog revalidation transport origin map must be a JSON object");
  }
  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry !== "string") {
      throw new Error(`catalog revalidation transport mapping '${key}' must be a string`);
    }
  }
  return parsed as Record<string, string>;
}

/**
 * Parses a comma-separated query parameter into a list.
 *
 * @param value - Raw query parameter
 * @returns The non-empty entries, or undefined when the parameter was absent
 */
function parseList(value?: string): string[] | undefined {
  if (!value) return undefined;
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

/**
 * Parses the spec's `type` filter.
 *
 * @param value - Raw query parameter
 * @returns The resource type, or undefined when absent or unrecognised
 */
function parseResourceType(value?: string): "http" | "mcp" | undefined {
  return value === "http" || value === "mcp" ? value : undefined;
}

/**
 * Bounds the page size so a client cannot ask for the whole catalog at once.
 *
 * @param value - Raw query parameter
 * @returns A limit between 1 and 100
 */
function clampLimit(value?: string): number {
  const parsed = parseInt(value || "20", 10);
  if (!Number.isFinite(parsed)) return 20;
  return Math.min(100, Math.max(1, parsed));
}

/**
 * Bounds the page offset so a negative offset cannot reach the database.
 *
 * @param value - Raw query parameter
 * @returns A non-negative offset (>= 0)
 */
function clampOffset(value?: string): number {
  const parsed = parseInt(value || "0", 10);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, parsed);
}

/**
 * Encodes an EXTENSION-RESPONSES payload for a rejection raised at the route.
 *
 * @param status - Cataloging outcome
 * @param reason - Why it was rejected
 * @returns The base64 header value
 */
function encodeExtensionResponse(status: "success" | "rejected", reason?: string): string {
  return Buffer.from(
    JSON.stringify({ bazaar: { status, ...(reason && { rejectedReason: reason }) } }),
  ).toString("base64");
}

function parseAnnouncedResources(value?: string): ResourceMetadata[] {
  if (!value) return [];
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error("P2P_ANNOUNCED_RESOURCES must be a JSON array");
  return parsed;
}

function errorResponse(
  code: RegisteredErrorCode,
  reason?: string,
  details?: Record<string, unknown>,
) {
  return publicError(code, { reason, details });
}

/**
 * Bazaar Discovery Service
 *
 * Main HTTP server that orchestrates:
 * - P2P mesh for federated announcements
 * - Telemetry tracking from heartbeats
 * - Hybrid search engine
 * - Auto-cataloging ingestion
 */
export class BazaarService {
  private app: Hono;
  private config: BazaarServiceConfig;
  private db: Database;
  private p2pNode: P2PNode;
  private announcer?: Announcer;
  private telemetryTracker: TelemetryTracker;
  private searchEngine: BazaarSearchEngine;
  private ingestionWorker: CatalogIngestionWorker;
  private providerQualityStore: ProviderQualityStore;
  private metrics: BazaarMetrics;
  private httpServer?: ServerType;
  private livenessInterval?: NodeJS.Timeout;
  private heartbeatInterval?: NodeJS.Timeout;
  private catalogRevalidationInterval?: NodeJS.Timeout;
  private serviceReady = false;
  private stopping = false;
  private providerAggregateRecomputeScheduled = false;
  private readonly pendingProviderAggregateRecomputes = new Map<string, { endpoint: string; payTo?: string }>();

  constructor(config: BazaarServiceConfig) {
    this.config = config;
    this.app = new Hono();

    // Initialize components
    this.db = createDatabase(config.database);
    this.p2pNode = new P2PNode(config.p2p);
    this.telemetryTracker = new TelemetryTracker(this.db);
    this.searchEngine = new BazaarSearchEngine(config.database);
    this.ingestionWorker = new CatalogIngestionWorker(config.database, {
      horizonUrl: config.horizonUrl,
      sorobanRpcUrl: config.sorobanRpcUrl,
      livePaymentTerms: {
        timeoutMs: config.catalogRevalidationTimeoutMs,
        allowedOrigins: config.catalogRevalidationAllowedOrigins,
        transportOriginMap: config.catalogRevalidationTransportOriginMap,
      },
    });
    this.providerQualityStore = new ProviderQualityStore(this.db);
    this.metrics = createBazaarMetrics();

    // Initialize announcer if secret key provided
    if (config.stellarSecretKey) {
      this.announcer = createAnnouncer(config.stellarSecretKey);
    }

    // Setup routes
    this.setupMiddleware();
    this.setupRoutes();
  }

  /**
   * Setup middleware
   */
  private setupMiddleware(): void {
    // CORS
    this.app.use("*", cors({
      origin: "*",
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
    }));

    // Body size limit (1MB max to prevent memory exhaustion / DoS)
    this.app.use("*", bodyLimit({ maxSize: 1024 * 1024 }));

    // Rate limiting (120 req/min with trusted proxy support)
    this.app.use("*", rateLimit({
      windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000", 10),
      max: parseInt(process.env.RATE_LIMIT_MAX || "120", 10),
    }));

    // Logging
    this.app.use("*", honoLogger());
  }

  /**
   * Setup HTTP routes
   */
  private setupRoutes(): void {
    // Capability Descriptor (x402ccd/0), per extension proposal #3117.
    //
    // The Bazaar sells nothing: discovery is free and it issues no receipts.
    // It therefore advertises no jobs and no receipt signer, rather than
    // listing a zero-priced job against a placeholder address.
    this.app.get("/.well-known/x402", (c) => {
      const baseUrl = process.env.BAZAAR_BASE_URL;
      if (!baseUrl) {
        return c.json(
          errorResponse("internal_error", "BAZAAR_BASE_URL is not set, so this service cannot state the origin clients reach it at."),
          503,
        );
      }

      return c.json({
        ccd: "x402ccd/0",
        service: "Veridex Bazaar Discovery & Catalog Service",
        baseUrl: baseUrl.replace(/\/+$/, ""),
        runtime: {
          // Honesty rule: false unless a verifiable TEE claim is present.
          attested: false,
          platform: "stellar-soroban",
          note: "Catalog entries are bound to settlements this service confirms on Horizon before listing them.",
        },
        jobs: [],
        endpoints: [
          { method: "GET", path: "/discovery/search", price: null, description: "Hybrid catalog search. Free." },
          { method: "GET", path: "/discovery/resources", price: null, description: "List catalog entries. Free." },
        ],
      });
    });

    // Health check
    this.app.get("/health", async (c) => {
      const dbHealth = await this.db.healthCheck();
      const p2pStats = this.p2pNode.getStats();

      return c.json({
        status: dbHealth.connected && !dbHealth.error ? "ok" : "degraded",
        timestamp: Date.now(),
        database: dbHealth,
        p2p: {
          peerId: p2pStats.peerId,
          connectedPeers: p2pStats.connectedPeers,
          uptime: p2pStats.uptime,
        },
      });
    });

    this.app.get("/ready", async (c) => {
      const dbHealth = await this.db.healthCheck();
      const p2pStats = this.p2pNode.getStats();
      const ready = this.serviceReady &&
        dbHealth.connected &&
        !dbHealth.error &&
        p2pStats.peerId.length > 0;
      return c.json({
        status: ready ? "ready" : "not_ready",
        serviceStarted: this.serviceReady,
        database: dbHealth,
        p2p: {
          peerId: p2pStats.peerId,
          connectedPeers: p2pStats.connectedPeers,
        },
        timestamp: Date.now(),
      }, ready ? 200 : 503);
    });

    // Statistics
    this.app.get("/stats", async (c) => {
      const p2pStats = this.p2pNode.getStats();
      const telemetryStats = await this.telemetryTracker.getStats();

      return c.json({
        p2p: p2pStats,
        telemetry: telemetryStats,
        timestamp: Date.now(),
      });
    });

    this.app.get("/metrics", async (c) => {
      const p2pStats = this.p2pNode.getStats();
      this.metrics.set("veridex_p2p_messages_total", p2pStats.messagesReceived);
      this.metrics.set("veridex_p2p_invalid_total", Math.max(0, p2pStats.messagesSuppressed - p2pStats.replaysRejected));
      this.metrics.set("veridex_p2p_replays_total", p2pStats.replaysRejected);
      try {
        const result = await this.db.query<{
          searchable: string;
          embedding_backlog: string;
          oldest_pending_seconds: string;
        }>(
          `SELECT
             COUNT(*) FILTER (WHERE soft_dropped = false) AS searchable,
             COUNT(*) FILTER (WHERE soft_dropped = false AND embedding IS NULL) AS embedding_backlog,
             COALESCE(EXTRACT(EPOCH FROM now() - MIN(created_at) FILTER (WHERE verification_status = 'pending')), 0) AS oldest_pending_seconds
           FROM catalog_resources`,
        );
        const row = result.rows[0];
        this.metrics.set("veridex_catalog_resources_total", Number(row?.searchable ?? 0));
        this.metrics.set("veridex_embedding_backlog", Number(row?.embedding_backlog ?? 0));
        this.metrics.set("veridex_catalog_ingestion_lag", Number(row?.oldest_pending_seconds ?? 0));
      } catch {
        this.metrics.set("veridex_catalog_resources_total", 0);
        this.metrics.set("veridex_embedding_backlog", 0);
        this.metrics.set("veridex_catalog_ingestion_lag", 0);
      }
      c.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
      return c.body(this.metrics.render());
    });

    // Hybrid search: BM25 keywords, feature-hash vectors, and telemetry, fused by RRF
    this.app.get("/discovery/search", async (c) => {
      const startedAt = performance.now();
      this.metrics.increment("veridex_search_requests_total");
      try {
        const query = c.req.query("q") || c.req.query("query");
        if (!query) {
          return c.json(errorResponse("invalid_request", "Missing query parameter 'q'."), 400);
        }

        const results = await this.searchEngine.search({
          query,
          // The spec's filters, named as it names them.
          resourceType: parseResourceType(c.req.query("type")),
          payTo: c.req.query("payTo"),
          network: c.req.query("network"),
          scheme: c.req.query("scheme"),
          extensions: parseList(c.req.query("extensions")),
          tags: parseList(c.req.query("tags")),
          minUptimeRatio: parseFloat(c.req.query("minUptimeRatio") || "0"),
          limit: clampLimit(c.req.query("limit")),
          offset: clampOffset(c.req.query("offset")),
          cursor: c.req.query("cursor"),
        });
        if (results.total === 0) this.metrics.increment("veridex_search_zero_results_total");
        return c.json(results);
      } catch (error) {
        // A bad cursor is the client's mistake, and saying so beats a 500.
        if (error instanceof InvalidCursorError) {
          return c.json(errorResponse("invalid_request", error.message, { field: "cursor" }), 400);
        }
        console.error("[Bazaar Service] Search error:", error);
        return c.json(errorResponse("internal_error", "Catalog search could not be completed."), 500);
      } finally {
        this.metrics.observe("veridex_search_latency", (performance.now() - startedAt) / 1000);
      }
    });

    // List resources
    this.app.get("/discovery/resources", async (c) => {
      try {
        const results = await this.searchEngine.list({
          // type, payTo, network, extensions, limit, offset are the filters the
          // discovery spec names; scheme and tags are supported extras.
          resourceType: parseResourceType(c.req.query("type")),
          payTo: c.req.query("payTo"),
          network: c.req.query("network"),
          extensions: parseList(c.req.query("extensions")),
          scheme: c.req.query("scheme"),
          tags: parseList(c.req.query("tags")),
          limit: clampLimit(c.req.query("limit")),
          offset: clampOffset(c.req.query("offset")),
          cursor: c.req.query("cursor"),
        });
        return c.json(results);
      } catch (error) {
        if (error instanceof InvalidCursorError) {
          return c.json(errorResponse("invalid_request", error.message, { field: "cursor" }), 400);
        }
        console.error("[Bazaar Service] List error:", error);
        return c.json(errorResponse("internal_error", "Catalog listing could not be completed."), 500);
      }
    });

    // Public, read-only provider reliability history. This is deliberately
    // separate from heartbeat liveness and settlement counters.
    this.app.get("/v1/provider", async (c) => {
      const endpoint = c.req.query("endpoint");
      if (!endpoint) return c.json(errorResponse("invalid_request", "The endpoint query parameter is required."), 400);
      const payTo = c.req.query("payTo");
      try {
        const aggregate = await this.providerQualityStore.getAggregate(endpoint, payTo);
        if (!aggregate) {
          return c.json({
            v: "veridex/provider-aggregate/1",
            endpoint,
            ...(payTo ? { payTo } : {}),
            state: "insufficient_data",
            faultRateUpperBound: 1,
            faultsObserved: 0,
            n: 0,
            window: "30d",
            retrievedAt: Math.floor(Date.now() / 1000),
          }, 200);
        }
        const verification = verifyProviderAggregate(aggregate, {
          expectedEndpoint: endpoint,
          expectedPayTo: payTo,
          authorizedIssuers: this.config.providerAggregateAuthorizedIssuers,
          maxAgeSeconds: 30 * 24 * 60 * 60,
        });
        if (!verification.valid) {
          return c.json(errorResponse("provider_quality_unavailable", verification.error), 503);
        }
        return c.json(aggregate);
      } catch (error) {
        console.error("[Bazaar Service] Provider aggregate read error:", error);
        return c.json(errorResponse("provider_quality_unavailable"), 503);
      }
    });

    this.app.get("/v1/provider/observations", async (c) => {
      const endpoint = c.req.query("endpoint");
      if (!endpoint) return c.json(errorResponse("invalid_request", "The endpoint query parameter is required."), 400);
      try {
        const observations = await this.providerQualityStore.listObservations(
          endpoint,
          c.req.query("payTo"),
          clampLimit(c.req.query("limit")),
        );
        return c.json({ endpoint, observations });
      } catch (error) {
        console.error("[Bazaar Service] Provider observation read error:", error);
        return c.json(errorResponse("provider_quality_unavailable"), 503);
      }
    });

    this.app.get("/v1/provider/disagreements", async (c) => {
      const endpoint = c.req.query("endpoint");
      if (!endpoint) return c.json(errorResponse("invalid_request", "The endpoint query parameter is required."), 400);
      try {
        const disagreements = await this.providerQualityStore.listDisagreements(
          endpoint,
          c.req.query("payTo"),
          clampLimit(c.req.query("limit")),
        );
        return c.json({ endpoint, disagreements });
      } catch {
        return c.json(errorResponse("provider_quality_unavailable"), 503);
      }
    });

    this.app.post("/provider-quality/aggregates/recompute", async (c) => {
      if (c.req.header("Authorization") !== `Bearer ${this.config.internalToken}`) {
        return c.json(errorResponse("unauthorized"), 401);
      }
      if (!this.config.providerAggregateIssuerSecretKey) {
        return c.json(errorResponse("provider_quality_unavailable", "Provider aggregate signing is not configured."), 503);
      }
      const endpoint = c.req.query("endpoint");
      if (!endpoint) return c.json(errorResponse("invalid_request", "The endpoint query parameter is required."), 400);
      const payTo = c.req.query("payTo") || undefined;
      try {
        const observations = await this.providerQualityStore.listObservationsForAggregate(endpoint, payTo);
        const aggregate = buildProviderAggregate(
          endpoint,
          payTo,
          observations,
          this.config.providerAggregateIssuerSecretKey,
          {
            publishedThreshold: this.config.providerAggregatePublishedThreshold,
            provisionalThreshold: this.config.providerAggregateProvisionalThreshold,
          },
        );
        await this.providerQualityStore.saveAggregate(aggregate);
        return c.json(aggregate, 200);
      } catch (error) {
        return c.json(errorResponse("internal_error", "Provider aggregate recomputation failed."), 500);
      }
    });

    // Accept P2P announcements via HTTP (Authenticated)
    this.app.post("/announce", async (c) => {
      try {
        if (c.req.header("Authorization") !== `Bearer ${this.config.internalToken}`) {
          return c.json(
            errorResponse("unauthorized", "/announce requires the internal bearer token to publish gossip announcements."),
            401,
          );
        }

        const body = await c.req.json();
        const message = AnnounceMessageSchema.parse(body);

        // Publish to P2P mesh
        await this.p2pNode.publishAnnouncement(message);

        return c.json({
          status: "success",
          message: "Announcement published to P2P mesh",
        });
      } catch (error) {
        console.error("[Bazaar Service] Announce error:", error);
        return c.json(errorResponse("invalid_request", error instanceof Error ? error.message : undefined), 400);
      }
    });

    this.app.post("/catalog/delta", async (c) => {
      if (c.req.header("Authorization") !== `Bearer ${this.config.internalToken}`) {
        return c.json(errorResponse("unauthorized"), 401);
      }
      try {
        const delta = CatalogDeltaSchema.parse(await c.req.json());
        const allowed = this.config.p2p.authorizedCatalogSigners?.[`${delta.network}:${delta.payTo}`]
          ?? (delta.signer === delta.payTo ? [delta.payTo] : undefined);
        const result = await this.ingestionWorker.applyCatalogDelta(delta, {
          authorizedSigners: allowed,
        });
        return c.json({ ...result, key: catalogDeltaKey(delta) }, result.status === "rejected" ? 400 : 202);
      } catch (error) {
        return c.json(errorResponse("invalid_catalog_delta", error instanceof Error ? error.message : undefined), 400);
      }
    });

    // Trigger catalog ingestion
    this.app.post("/catalog/ingest", async (c) => {
      try {
        if (c.req.header("Authorization") !== `Bearer ${this.config.internalToken}`) {
          return c.json(
            errorResponse("unauthorized", "/catalog/ingest requires the facilitator's bearer token. This endpoint writes to the public catalog."),
            401,
          );
        }

        const body = await c.req.json();

        if (typeof body?.settlementTx !== "string" || body.settlementTx.length === 0) {
          const reason =
            "settlementTx is required: a catalog entry must name the settlement that backs it, which this service confirms on Horizon.";
          c.header("EXTENSION-RESPONSES", encodeExtensionResponse("rejected", reason));
          return c.json({ status: "rejected", reason }, 400);
        }

        const result = await this.ingestionWorker.ingest(body);

        // The spec reports cataloging outcomes in this header so a seller can
        // tell whether a listing landed, and why not. It travels back to the
        // seller on the facilitator's settle response.
        c.header("EXTENSION-RESPONSES", result.extensionResponse);

        if (result.status === "success") {
          return c.json({
            status: "success",
            resourceId: result.resourceId,
            extensionResponse: result.extensionResponse,
          });
        }
        return c.json({
          status: "rejected",
          reason: result.rejectedReason,
          extensionResponse: result.extensionResponse,
        }, 400);
      } catch (error) {
        console.error("[Bazaar Service] Ingestion error:", error);
        return c.json(errorResponse("catalog_ingestion_failed"), 500);
      }
    });

    // Internal asynchronous observation ingestion. It is never called by the
    // facilitator before settlement and contains hashes, not raw payloads.
    this.app.post("/provider-quality/observations", async (c) => {
      if (c.req.header("Authorization") !== `Bearer ${this.config.internalToken}`) {
        return c.json(errorResponse("unauthorized"), 401);
      }
      try {
        const body = await c.req.json();
        const observation = ProviderObservationSchema.parse(body.observation ?? body);
        const source = body.source === "independent" ? "independent" : "in_band";
        const verification = verifyProviderObservation(observation, {
          expectedResource: observation.resource,
          expectedPayTo: observation.payTo,
          authorizedSigners: this.config.providerQualityAuthorizedSigners,
          maxAgeSeconds: 15 * 60,
        });
        if (!verification.valid) {
          return c.json(errorResponse("invalid_provider_observation", verification.error), 400);
        }
        const record = await this.providerQualityStore.recordObservation({ observation, source });
        this.metrics.increment("veridex_provider_observations_total");
        if (observation.providerAtFault) this.metrics.increment("veridex_provider_faults_total");
        if (record.disagreementRecorded) this.metrics.increment("veridex_provider_disagreements_total");
        this.enqueueProviderAggregateRecompute(observation.resource, observation.payTo);
        return c.json({ status: "accepted", id: record.id }, 202);
      } catch (error) {
        return c.json(errorResponse("invalid_provider_observation", error instanceof Error ? error.message : undefined), 400);
      }
    });

    // Internal aggregate ingestion. Aggregates are accepted only after
    // signature, timestamp, endpoint, and payee checks succeed.
    this.app.post("/provider-quality/aggregates", async (c) => {
      if (c.req.header("Authorization") !== `Bearer ${this.config.internalToken}`) {
        return c.json(errorResponse("unauthorized"), 401);
      }
      try {
        const aggregate = ProviderAggregateSchema.parse(await c.req.json());
        const verification = verifyProviderAggregate(aggregate, {
          expectedEndpoint: aggregate.endpoint,
          expectedPayTo: aggregate.payTo,
          authorizedIssuers: this.config.providerAggregateAuthorizedIssuers,
          maxAgeSeconds: 15 * 60,
        });
        if (!verification.valid) {
          return c.json(errorResponse("invalid_provider_aggregate", verification.error), 400);
        }
        await this.providerQualityStore.saveAggregate(aggregate);
        return c.json({ status: "accepted" }, 202);
      } catch (error) {
        return c.json(errorResponse("invalid_provider_aggregate", error instanceof Error ? error.message : undefined), 400);
      }
    });

    this.app.post("/provider-quality/observations/settlement", async (c) => {
      if (c.req.header("Authorization") !== `Bearer ${this.config.internalToken}`) {
        return c.json(errorResponse("unauthorized"), 401);
      }
      try {
        const body = await c.req.json();
        if (
          typeof body?.signer !== "string" ||
          typeof body?.signature !== "string" ||
          !/^[0-9a-f]{64}$/i.test(body?.settlementTx || "")
        ) {
          return c.json(errorResponse("invalid_request", "Settlement correlation requires signer, signature, and a transaction hash."), 400);
        }
        const attached = await this.providerQualityStore.attachSettlement(
          body.signer,
          body.signature,
          body.settlementTx,
        );
        return attached
          ? c.json({ status: "attached" }, 202)
          : c.json(errorResponse("not_found", "The provider observation was not found."), 404);
      } catch (error) {
        return c.json(errorResponse("invalid_request", error instanceof Error ? error.message : undefined), 400);
      }
    });
  }

  /**
   * Start the Bazaar service
   *
   * 1. Check database health
   * 2. Initialize embedding model
   * 3. Start P2P node
   * 4. Set up P2P message handler (telemetry tracker)
   * 5. Start HTTP server
   */
  async start(): Promise<void> {
    console.log("[Bazaar Service] Starting Veridex Bazaar Discovery Service...");
    this.stopping = false;

    // Check database
    console.log("[Bazaar Service] Checking database connection...");
    const dbHealth = await this.db.healthCheck();
    if (!dbHealth.connected || dbHealth.error) {
      throw new Error(`Database connection failed: ${dbHealth.error}`);
    }
    console.log("[Bazaar Service] Database OK");
    console.log(`[Bazaar Service] Extensions: ${dbHealth.extensions.join(", ")}`);

    // Initialize embedding model
    console.log("[Bazaar Service] Initializing embedding model...");
    const { initializeEmbeddingModel } = await import("./search/embeddings.js");
    await initializeEmbeddingModel();
    console.log("[Bazaar Service] Embedding model ready");

    // Start P2P node
    console.log("[Bazaar Service] Starting P2P node...");
    await this.p2pNode.start();
    console.log(`[Bazaar Service] P2P node ready (${this.p2pNode.getPeerId()})`);

    // Set up P2P message handler
    this.p2pNode.onMessage(async (message) => {
      try {
        // A signed gossip announcement proves who said it, not that anyone
        // paid. Only announcements naming a settlement reach the catalog; the
        // rest still count as liveness telemetry below.
        if (
          message.description &&
          message.payTo &&
          message.network &&
          message.scheme &&
          typeof (message as any).settlementTx === "string"
        ) {
          await this.ingestionWorker.ingest({
            resourceUrl: message.resourceUrl,
            resourceType: message.resourceType || (message.toolName ? "mcp" : "http"),
            toolName: message.toolName,
            payTo: message.payTo,
            network: message.network,
            scheme: message.scheme,
            bazaarExtension: {
              serviceName: message.serviceName,
              description: message.description,
              tags: message.tags,
              iconUrl: message.iconUrl,
              routeTemplate: message.routeTemplate,
              mimeType: message.mimeType || "application/json",
              inputSpec: message.inputSpec || {},
              outputSpec: message.outputSpec,
            },
            extensions: message.extensions,
            settlementTx: (message as any).settlementTx,
          });
        }
        await this.telemetryTracker.processHeartbeat(message);
      } catch (error) {
        console.error("[Bazaar Service] Error processing heartbeat:", error);
      }
    });

    this.p2pNode.onCatalogDelta(async (delta: CatalogDelta) => {
      const allowed = this.config.p2p.authorizedCatalogSigners?.[`${delta.network}:${delta.payTo}`]
        ?? (delta.signer === delta.payTo ? [delta.payTo] : undefined);
      const result = await this.ingestionWorker.applyCatalogDelta(delta, {
        authorizedSigners: allowed,
      });
      if (result.status === "rejected") {
        console.warn(`[Bazaar Service] Catalog delta rejected: ${result.reason}`);
      }
    });

    if (this.announcer && this.config.announcedResources.length > 0) {
      const publishHeartbeats = async () => {
        for (const resource of this.config.announcedResources) {
          const message = await this.announcer!.createAnnouncement(resource, {
            avgResponseTimeMs: 0,
            uptime30d: 100,
            successfulSettlements: 0,
          });
          await this.p2pNode.publishAnnouncement(message);
        }
      };
      await publishHeartbeats();
      this.heartbeatInterval = setInterval(() => {
        publishHeartbeats().catch((error) =>
          console.error("[Bazaar Service] Heartbeat publication failed:", error)
        );
      }, this.config.p2p.heartbeatIntervalMs);
    }

    // Start HTTP server
    console.log(`[Bazaar Service] Starting HTTP server on ${this.config.host}:${this.config.port}...`);

    this.httpServer = serve({
      fetch: this.app.fetch,
      port: this.config.port,
      hostname: this.config.host,
    });
    this.serviceReady = true;

    this.livenessInterval = setInterval(() => {
      this.telemetryTracker.pruneOfflineNodes()
        .then((changed) => this.metrics.increment("veridex_liveness_changes_total", changed))
        .catch((error) => console.error("[Bazaar Service] Liveness evaluation failed:", error));
    }, 30_000);

    if (this.config.catalogRevalidationIntervalMs > 0) {
      this.catalogRevalidationInterval = setInterval(() => {
        this.ingestionWorker.revalidateStale({
          staleAfterMs: this.config.catalogRevalidationStaleMs,
          limit: this.config.catalogRevalidationBatchSize,
        }).then((summary) => {
          this.metrics.increment("veridex_catalog_revalidation_failures_total", summary.quarantined);
          this.metrics.increment("veridex_catalog_revalidation_retained_total", summary.retained);
          if (summary.checked > 0) console.log("[Bazaar Service] Catalog revalidation", summary);
        }).catch((error) =>
          console.error("[Bazaar Service] Catalog revalidation failed:", error)
        );
      }, this.config.catalogRevalidationIntervalMs);
    }

    console.log(`[Bazaar Service] ✓ Service ready at http://${this.config.host}:${this.config.port}`);
    console.log("[Bazaar Service] Endpoints:");
    console.log("  GET  /health");
    console.log("  GET  /stats");
    console.log("  GET  /discovery/search?q=<query>");
    console.log("  GET  /discovery/resources");
    console.log("  POST /announce");
    console.log("  POST /catalog/ingest");
  }

  /**
   * Stop the service and clean up resources
   */
  async stop(): Promise<void> {
    console.log("[Bazaar Service] Stopping service...");
    this.stopping = true;
    this.serviceReady = false;
    this.pendingProviderAggregateRecomputes.clear();

    if (this.livenessInterval) {
      clearInterval(this.livenessInterval);
      this.livenessInterval = undefined;
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
    if (this.catalogRevalidationInterval) {
      clearInterval(this.catalogRevalidationInterval);
      this.catalogRevalidationInterval = undefined;
    }
    if (this.httpServer) {
      await new Promise<void>((resolve, reject) =>
        this.httpServer!.close((error?: Error) => (error ? reject(error) : resolve()))
      );
      this.httpServer = undefined;
    }

    await this.p2pNode.stop();
    await this.db.close();
    await this.telemetryTracker.close();

    console.log("[Bazaar Service] Service stopped");
  }

  /**
   * Get Hono app instance (for testing)
   */
  getApp(): Hono {
    return this.app;
  }

  private enqueueProviderAggregateRecompute(endpoint: string, payTo?: string): void {
    if (!this.config.providerAggregateIssuerSecretKey || this.stopping) return;
    const key = `${endpoint}|${payTo ?? ""}`;
    const queueLimit = Math.max(1, this.config.providerAggregateRecomputeQueueLimit ?? 256);
    if (!this.pendingProviderAggregateRecomputes.has(key) && this.pendingProviderAggregateRecomputes.size >= queueLimit) {
      console.warn(`[Bazaar Service] Provider aggregate recompute queue is full; dropping ${key}`);
      return;
    }
    this.pendingProviderAggregateRecomputes.set(key, { endpoint, payTo });
    if (this.providerAggregateRecomputeScheduled) return;
    this.providerAggregateRecomputeScheduled = true;
    setTimeout(() => {
      this.providerAggregateRecomputeScheduled = false;
      this.drainProviderAggregateRecomputeQueue().catch((error) =>
        console.error("[Bazaar Service] Provider aggregate recomputation failed:", error),
      );
    }, 0);
  }

  private async drainProviderAggregateRecomputeQueue(): Promise<void> {
    while (!this.stopping && this.pendingProviderAggregateRecomputes.size > 0) {
      const next = this.pendingProviderAggregateRecomputes.values().next().value as
        { endpoint: string; payTo?: string } | undefined;
      if (!next) return;
      this.pendingProviderAggregateRecomputes.delete(`${next.endpoint}|${next.payTo ?? ""}`);
      try {
        await this.recomputeProviderAggregate(next.endpoint, next.payTo);
      } catch (error) {
        console.error(`[Bazaar Service] Failed to recompute provider aggregate for ${next.endpoint}:`, error);
      }
    }
  }

  private async recomputeProviderAggregate(endpoint: string, payTo?: string): Promise<void> {
    const issuerSecretKey = this.config.providerAggregateIssuerSecretKey;
    if (!issuerSecretKey) return;
    const observations = await this.providerQualityStore.listObservationsForAggregate(endpoint, payTo);
    const aggregate = buildProviderAggregate(endpoint, payTo, observations, issuerSecretKey, {
      publishedThreshold: this.config.providerAggregatePublishedThreshold,
      provisionalThreshold: this.config.providerAggregateProvisionalThreshold,
    });
    await this.providerQualityStore.saveAggregate(aggregate);
  }
}

/**
 * Create and start Bazaar service with default configuration
 */
export async function startBazaarService(
  config?: Partial<BazaarServiceConfig>
): Promise<BazaarService> {
  const fullConfig = { ...getDefaultConfig(), ...config };
  const service = new BazaarService(fullConfig);
  await service.start();
  return service;
}

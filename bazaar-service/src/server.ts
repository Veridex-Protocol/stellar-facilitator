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
import { AnnounceMessageSchema } from "./p2p/types.js";
import { InvalidCursorError } from "./search/cursor.js";
import { rateLimit } from "./rate-limit.js";
import { bodyLimit } from "hono/body-limit";
import type { P2PNodeConfig } from "./p2p/types.js";
import type { ResourceMetadata } from "./p2p/announcer.js";

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
  /** Shared secret the facilitator presents on /catalog/ingest. Required. */
  internalToken: string;
  announcedResources: ResourceMetadata[];
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
    },
    stellarSecretKey: process.env.STELLAR_SECRET_KEY,
    announcedResources: parseAnnouncedResources(process.env.P2P_ANNOUNCED_RESOURCES),
    horizonUrl: process.env.HORIZON_URL || "https://horizon-testnet.stellar.org",
    // Required, not optional. The previous guard read
    // `if (internalToken && ...)`, which skipped authentication entirely when
    // the variable was unset — an open write endpoint on the public catalog.
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
  private httpServer?: ServerType;
  private livenessInterval?: NodeJS.Timeout;
  private heartbeatInterval?: NodeJS.Timeout;

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
    });

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
          {
            error: "not_configured",
            message:
              "BAZAAR_BASE_URL is not set, so this service cannot state the origin clients reach it at.",
          },
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
        status: dbHealth.connected ? "ok" : "degraded",
        timestamp: Date.now(),
        database: dbHealth,
        p2p: {
          peerId: p2pStats.peerId,
          connectedPeers: p2pStats.connectedPeers,
          uptime: p2pStats.uptime,
        },
      });
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

    // Hybrid search: BM25 keywords, feature-hash vectors, and telemetry, fused by RRF
    this.app.get("/discovery/search", async (c) => {
      try {
        const query = c.req.query("q") || c.req.query("query");
        if (!query) {
          return c.json({ error: "Missing query parameter 'q'" }, 400);
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
        return c.json(results);
      } catch (error) {
        // A bad cursor is the client's mistake, and saying so beats a 500.
        if (error instanceof InvalidCursorError) {
          return c.json({ error: "invalid_cursor", message: error.message }, 400);
        }
        console.error("[Bazaar Service] Search error:", error);
        return c.json({
          error: "Search failed",
          message: error instanceof Error ? error.message : "Unknown error",
        }, 500);
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
          return c.json({ error: "invalid_cursor", message: error.message }, 400);
        }
        console.error("[Bazaar Service] List error:", error);
        return c.json({
          error: "List failed",
          message: error instanceof Error ? error.message : "Unknown error",
        }, 500);
      }
    });

    // Accept P2P announcements via HTTP (Authenticated)
    this.app.post("/announce", async (c) => {
      try {
        if (c.req.header("Authorization") !== `Bearer ${this.config.internalToken}`) {
          return c.json(
            {
              error: "unauthorized",
              message: "/announce requires the internal bearer token to publish gossip announcements",
            },
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
        return c.json({
          error: "Announcement failed",
          message: error instanceof Error ? error.message : "Unknown error",
        }, 400);
      }
    });

    // Trigger catalog ingestion
    this.app.post("/catalog/ingest", async (c) => {
      try {
        if (c.req.header("Authorization") !== `Bearer ${this.config.internalToken}`) {
          return c.json(
            {
              error: "unauthorized",
              message:
                "/catalog/ingest requires the facilitator's bearer token. This endpoint writes to the public catalog.",
            },
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
        return c.json({
          error: "Ingestion failed",
          message: error instanceof Error ? error.message : "Unknown error",
        }, 500);
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

    // Check database
    console.log("[Bazaar Service] Checking database connection...");
    const dbHealth = await this.db.healthCheck();
    if (!dbHealth.connected) {
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

    this.livenessInterval = setInterval(() => {
      this.telemetryTracker.pruneOfflineNodes().catch((error) =>
        console.error("[Bazaar Service] Liveness evaluation failed:", error)
      );
    }, 30_000);

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

    if (this.livenessInterval) {
      clearInterval(this.livenessInterval);
      this.livenessInterval = undefined;
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
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

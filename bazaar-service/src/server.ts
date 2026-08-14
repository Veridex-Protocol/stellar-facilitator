/**
 * Veridex Bazaar Discovery Service - HTTP Server
 * License: Apache-2.0
 *
 * Exposes REST endpoints for:
 * - GET /discovery/search - Hybrid semantic search
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
  };
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
    this.ingestionWorker = new CatalogIngestionWorker(config.database);

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

    // Logging
    this.app.use("*", honoLogger());
  }

  /**
   * Setup HTTP routes
   */
  private setupRoutes(): void {
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

    // Hybrid semantic search
    this.app.get("/discovery/search", async (c) => {
      try {
        const query = c.req.query("q") || c.req.query("query");
        if (!query) {
          return c.json({ error: "Missing query parameter 'q'" }, 400);
        }

        const searchQuery = {
          query,
          network: c.req.query("network") || "stellar:pubnet",
          minUptimeRatio: parseFloat(c.req.query("minUptimeRatio") || "0.9"),
          limit: parseInt(c.req.query("limit") || "20", 10),
          offset: parseInt(c.req.query("offset") || "0", 10),
        };

        const results = await this.searchEngine.search(searchQuery);
        return c.json(results);
      } catch (error) {
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
        const filters = {
          network: c.req.query("network"),
          limit: parseInt(c.req.query("limit") || "20", 10),
          offset: parseInt(c.req.query("offset") || "0", 10),
        };

        const results = await this.searchEngine.list(filters);
        return c.json(results);
      } catch (error) {
        console.error("[Bazaar Service] List error:", error);
        return c.json({
          error: "List failed",
          message: error instanceof Error ? error.message : "Unknown error",
        }, 500);
      }
    });

    // Accept P2P announcements via HTTP
    this.app.post("/announce", async (c) => {
      try {
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
        const internalToken = process.env.BAZAAR_INTERNAL_TOKEN;
        if (internalToken && c.req.header("Authorization") !== `Bearer ${internalToken}`) {
          return c.json({ error: "Unauthorized" }, 401);
        }
        const body = await c.req.json();

        const result = await this.ingestionWorker.ingest(body);

        if (result.status === "success") {
          return c.json({
            status: "success",
            resourceId: result.resourceId,
            extensionResponse: result.extensionResponse,
          });
        } else {
          return c.json({
            status: "rejected",
            reason: result.rejectedReason,
            extensionResponse: result.extensionResponse,
          }, 400);
        }
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
        if (message.description && message.payTo && message.network && message.scheme) {
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

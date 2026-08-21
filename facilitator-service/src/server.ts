/**
 * Veridex Facilitator Service - HTTP Server
 * License: Apache-2.0
 *
 * x402 Facilitator endpoints:
 * - POST /verify - Verify transaction before settlement
 * - POST /settle - Submit transaction to Stellar network
 * - GET /supported - List supported payment schemes
 * - GET /health - Health check
 * - GET /stats - Channel pool and settlement statistics
 */

import { Hono } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import { cors } from "hono/cors";
import { logger as honoLogger } from "hono/logger";
import { z } from "zod";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import { extractDiscoveryInfo } from "@x402/extensions/bazaar";
import { ChannelAccountPool, createChannelPool } from "./channel/pool.js";
import {
  StellarTransactionVerifier,
  StellarTransactionSettler,
  X402Facilitator,
  createVerifier,
  createSettler,
  generateJobReceipt,
} from "./stellar/index.js";
import type {
  X402StellarRequest,
  X402StellarResponse,
  StellarNetworkConfig,
} from "./stellar/types.js";
import type { ChannelPoolConfig } from "./channel/types.js";

/**
 * x402 Stellar Request Schema (Zod)
 */
const X402StellarRequestSchema = z.object({
  scheme: z.literal("stellar"),
  network: z.string(),
  resourceServer: z.string(),
  transactionXdr: z.string(),
  metadata: z
    .object({
      resourceUrl: z.string().optional(),
      toolName: z.string().optional(),
      sessionId: z.string().optional(),
    })
    .optional(),
});

/**
 * Facilitator Service configuration
 */
export interface FacilitatorServiceConfig {
  // HTTP server
  port: number;
  host: string;

  // Stellar network
  stellar: StellarNetworkConfig;

  // Channel pool
  channelPool: Partial<ChannelPoolConfig>;
}

/**
 * Get default configuration from environment
 */
export function getDefaultConfig(): FacilitatorServiceConfig {
  const configuredNetwork = process.env.STELLAR_NETWORK || "testnet";
  if (configuredNetwork !== "testnet" && configuredNetwork !== "pubnet") {
    throw new Error("STELLAR_NETWORK must be 'testnet' or 'pubnet' for canonical x402 v2");
  }
  const network = configuredNetwork;
  const facilitatorSecretKey = process.env.FACILITATOR_SECRET_KEY || "";
  const facilitatorPublicKey =
    process.env.FACILITATOR_PUBLIC_KEY ||
    (facilitatorSecretKey ? Keypair.fromSecret(facilitatorSecretKey).publicKey() : "");

  const networkPassphrase =
    network === "pubnet"
      ? Networks.PUBLIC
      : Networks.TESTNET;

  const horizonUrl =
    process.env.HORIZON_URL ||
    (network === "pubnet"
      ? "https://horizon.stellar.org"
      : "https://horizon-testnet.stellar.org");

  const rpcUrl =
    process.env.SOROBAN_RPC_URL ||
    (network === "pubnet"
      ? "https://mainnet.sorobanrpc.com"
      : "https://soroban-testnet.stellar.org");

  return {
    port: parseInt(process.env.FACILITATOR_PORT || "3002", 10),
    host: process.env.FACILITATOR_HOST || "0.0.0.0",
    stellar: {
      network,
      networkPassphrase,
      horizonUrl,
      rpcUrl,
      facilitatorPublicKey,
      facilitatorSecretKey,
    },
    channelPool: {
      poolSize: parseInt(process.env.CHANNEL_POOL_SIZE || "0", 10),
      networkPassphrase,
      horizonUrl,
      sourceSecretKey: facilitatorSecretKey,
      channelSecretKeys: (process.env.CHANNEL_SECRET_KEYS || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      autoCreateChannels: process.env.CHANNEL_AUTO_CREATE === "true",
      cooldownMs: parseInt(process.env.CHANNEL_COOLDOWN_MS || "5000", 10),
      channelStartingBalance: process.env.CHANNEL_STARTING_BALANCE || "5",
      refillThreshold: process.env.CHANNEL_REFILL_THRESHOLD || "2",
      refillAmount: process.env.CHANNEL_REFILL_AMOUNT || "3",
    },
  };
}

/**
 * Facilitator Service
 *
 * x402 payment facilitator for Stellar network.
 */
export class FacilitatorService {
  private app: Hono;
  private config: FacilitatorServiceConfig;
  private channelPool: ChannelAccountPool;
  private verifier: StellarTransactionVerifier;
  private settler: StellarTransactionSettler;
  private x402Facilitator: X402Facilitator;
  private httpServer?: ServerType;
  private stats: {
    totalVerifications: number;
    successfulVerifications: number;
    totalSettlements: number;
    successfulSettlements: number;
    startTime: number;
  };

  constructor(config: FacilitatorServiceConfig) {
    this.config = config;
    this.app = new Hono();

    // Initialize components
    this.channelPool = createChannelPool(config.channelPool);
    this.verifier = createVerifier(config.stellar);
    this.settler = createSettler(config.stellar, this.channelPool);

    // Initialize x402 canonical facilitator wrapper
    this.x402Facilitator = new X402Facilitator({
      channelPool: this.channelPool,
      networkPassphrase: config.stellar.networkPassphrase,
      feeBumpSignerSecret:
        process.env.FEE_BUMP_SIGNER_SECRET || config.stellar.facilitatorSecretKey,
      rpcUrl: config.stellar.rpcUrl,
    });

    // Initialize stats
    this.stats = {
      totalVerifications: 0,
      successfulVerifications: 0,
      totalSettlements: 0,
      successfulSettlements: 0,
      startTime: Date.now(),
    };

    // Setup routes
    this.setupMiddleware();
    this.setupRoutes();
  }

  /**
   * Setup middleware
   */
  private setupMiddleware(): void {
    // CORS
    this.app.use(
      "*",
      cors({
        origin: "*",
        allowMethods: ["GET", "POST", "OPTIONS"],
        allowHeaders: ["Content-Type", "Authorization", "X-Resource-URL"],
      })
    );

    // Logging
    this.app.use("*", honoLogger());
  }

  /**
   * Setup HTTP routes
   */
  private setupRoutes(): void {
    // Health check
    this.app.get("/health", (c) => {
      const channelStats = this.channelPool.getStats();

      return c.json({
        status: "ok",
        timestamp: Date.now(),
        channels: channelStats,
        network: this.config.stellar.network,
      });
    });

    // Statistics
    this.app.get("/stats", (c) => {
      const channelStats = this.channelPool.getStats();
      const uptime = Date.now() - this.stats.startTime;

      return c.json({
        uptime,
        verifications: {
          total: this.stats.totalVerifications,
          successful: this.stats.successfulVerifications,
          successRate:
            this.stats.totalVerifications > 0
              ? this.stats.successfulVerifications / this.stats.totalVerifications
              : 0,
        },
        settlements: {
          total: this.stats.totalSettlements,
          successful: this.stats.successfulSettlements,
          successRate:
            this.stats.totalSettlements > 0
              ? this.stats.successfulSettlements / this.stats.totalSettlements
              : 0,
        },
        channels: channelStats,
        timestamp: Date.now(),
      });
    });

    // Supported schemes
    this.app.get("/supported", (c) => {
      const network = `stellar:${this.config.stellar.network}`;
      return c.json({
        kinds: [
          {
            x402Version: 2,
            scheme: "exact",
            network,
            extra: this.x402Facilitator.getExtra(network as any),
          },
          {
            x402Version: 2,
            scheme: "upto",
            network,
            extra: {
              contractId: process.env.UPTO_ESCROW_CONTRACT_ID || "upto_escrow_v1",
            },
          },
        ],
        extensions: ["attested-compute"],
        signers: {
          "stellar:*": this.x402Facilitator.getSigners(network),
        },
      });
    });

    // Capability Descriptor endpoint (x402ccd/0) per extension proposal #3117
    this.app.get("/.well-known/x402", (c) => {
      const baseUrl = process.env.BASE_URL || "https://facilitator.veridex.io";
      const receiptSigner = this.config.stellar.facilitatorPublicKey;

      return c.json({
        ccd: "x402ccd/0",
        service: "Veridex Attested & Verified Compute Facilitator",
        baseUrl,
        runtime: {
          attested: false, // Honesty Rule: MUST be false unless verifiable TEE claim is present
          platform: "stellar-soroban",
          note: "Results independently verifiable via chain provenance; attested (TEE) runtime is labeled per job when present."
        },
        receipts: {
          format: "x402job/1",
          signer: receiptSigner,
          note: "Signature over canonical JSON; request and result digests recompute from exact bytes exchanged."
        },
        jobs: [
          {
            id: "oracle/read",
            method: "POST",
            path: "/oracle/read",
            price: {
              asset: "USDC",
              amountAtomic: "50000",
              decimals: 6,
              network: `stellar:${this.config.stellar.network}`,
              scheme: "exact",
              payTo: receiptSigner
            },
            verification: {
              kind: "chain-provenance",
              detail: "Response names feedId, blockNumber, timestamp; re-query oracle or ledger to reproduce."
            }
          },
          {
            id: "compute/session",
            method: "POST",
            path: "/rooms",
            price: {
              asset: "XLM",
              amountAtomic: "10000000",
              decimals: 7,
              network: `stellar:${this.config.stellar.network}`,
              scheme: "upto",
              payTo: receiptSigner
            },
            verification: {
              kind: "chain-provenance",
              detail: "Session spend metered and bound on-chain by upto_escrow Soroban contract."
            }
          }
        ]
      });
    });

    // Canonical x402 verification endpoint
    const canonicalVerify = async (c: any) => {
      try {
        const body = await c.req.json();
        const paymentPayload = body.paymentPayload || body.payload;
        const paymentRequirements = body.paymentRequirements || body.requirements;

        if (!paymentPayload || !paymentRequirements) {
          return c.json(
            {
              isValid: false,
              invalidReason: "invalid_request",
              invalidMessage: "Missing paymentPayload or paymentRequirements",
            },
            400
          );
        }

        this.stats.totalVerifications++;
        const result = await this.x402Facilitator.verify(paymentPayload, paymentRequirements);

        if (result.isValid) {
          this.stats.successfulVerifications++;
          return c.json(result);
        } else {
          return c.json(result, 400);
        }
      } catch (error: any) {
        console.error("[Facilitator] x402 verification error:", error);
        return c.json(
          {
            isValid: false,
            invalidReason: "internal_error",
            invalidMessage: error instanceof Error ? error.message : "Unknown verification error",
          },
          500
        );
      }
    };
    this.app.post("/verify", canonicalVerify);
    this.app.post("/x402/verify", canonicalVerify);

    // Canonical x402 settlement endpoint
    const canonicalSettle = async (c: any) => {
      try {
        const body = await c.req.json();
        const paymentPayload = body.paymentPayload || body.payload;
        const paymentRequirements = body.paymentRequirements || body.requirements;

        if (!paymentPayload || !paymentRequirements) {
          return c.json(
            {
              success: false,
              errorReason: "invalid_request",
              errorMessage: "Missing paymentPayload or paymentRequirements",
              transaction: "",
              network: body.network || "stellar:testnet",
            },
            400
          );
        }

        this.stats.totalSettlements++;
        const result = await this.x402Facilitator.settle(paymentPayload, paymentRequirements);

        if (result.success) {
          this.stats.successfulSettlements++;
          await this.catalogSuccessfulPayment(paymentPayload, paymentRequirements).catch((error) =>
            console.error("[Facilitator] Bazaar catalog update failed:", error)
          );

          // Generate recomputable compute receipt (x402job/1) per proposal #3117
          const receipt = generateJobReceipt({
            serviceUrl: process.env.BASE_URL || "https://facilitator.veridex.io",
            jobId: paymentRequirements.scheme || "exact",
            requestBody: paymentPayload,
            resultBody: { transaction: result.transaction, ledger: (result as any).ledger },
            txHash: result.transaction,
            payer: result.payer || paymentRequirements.payTo,
            asset: paymentRequirements.asset || "USDC",
            amount: paymentRequirements.amount,
            network: paymentRequirements.network,
            signerSecretKey: this.config.stellar.facilitatorSecretKey,
            signerPublicKey: this.config.stellar.facilitatorPublicKey,
          });

          return c.json({
            ...result,
            receipt,
          });
        } else {
          return c.json(result, 500);
        }
      } catch (error: any) {
        console.error("[Facilitator] x402 settlement error:", error);
        return c.json(
          {
            success: false,
            errorReason: "internal_error",
            errorMessage: error instanceof Error ? error.message : "Unknown settlement error",
            transaction: "",
            network: "stellar:testnet",
          },
          500
        );
      }
    };
    this.app.post("/settle", canonicalSettle);
    this.app.post("/x402/settle", canonicalSettle);

    // Verify transaction (Legacy format)
    this.app.post("/legacy/verify", async (c) => {
      try {
        const body = await c.req.json();
        const request = X402StellarRequestSchema.parse(body);

        this.stats.totalVerifications++;

        // Extract expected amount from headers or metadata
        const expectedAmount = c.req.header("X-Expected-Amount");

        // Verify transaction
        const result = await this.verifier.verify(request, expectedAmount);

        if (result.valid) {
          this.stats.successfulVerifications++;

          return c.json({
            status: "success",
            valid: true,
            facilitatorAccount: result.facilitatorAccount,
            expectedAmount: result.expectedAmount,
          });
        } else {
          return c.json(
            {
              status: "error",
              valid: false,
              error: result.error,
            },
            400
          );
        }
      } catch (error) {
        console.error("[Facilitator] Verification error:", error);

        if (error instanceof z.ZodError) {
          return c.json(
            {
              status: "error",
              error: "Invalid request format",
              details: error.errors,
            },
            400
          );
        }

        return c.json(
          {
            status: "error",
            error: error instanceof Error ? error.message : "Unknown verification error",
          },
          500
        );
      }
    });

    // Settle transaction
    this.app.post("/legacy/settle", async (c) => {
      try {
        const body = await c.req.json();
        const request = X402StellarRequestSchema.parse(body);

        this.stats.totalSettlements++;

        // Extract expected amount
        const expectedAmount = c.req.header("X-Expected-Amount");

        // Verify first
        const verifyResult = await this.verifier.verify(request, expectedAmount);

        if (!verifyResult.valid) {
          return c.json(
            {
              status: "error",
              error: `Verification failed: ${verifyResult.error}`,
            },
            400
          );
        }

        if (!verifyResult.transaction) {
          return c.json(
            {
              status: "error",
              error: "Transaction parsing failed",
            },
            500
          );
        }

        // Settle transaction
        const settleResult = await this.settler.settle(verifyResult.transaction);

        if (settleResult.success) {
          this.stats.successfulSettlements++;

          const response: X402StellarResponse = {
            status: "success",
            transactionHash: settleResult.transactionHash,
            ledger: settleResult.ledger,
          };

          return c.json(response);
        } else {
          const response: X402StellarResponse = {
            status: "error",
            error: settleResult.error,
            errorCode: settleResult.errorCode,
          };

          return c.json(response, 500);
        }
      } catch (error) {
        console.error("[Facilitator] Settlement error:", error);

        if (error instanceof z.ZodError) {
          return c.json(
            {
              status: "error",
              error: "Invalid request format",
              details: error.errors,
            },
            400
          );
        }

        return c.json(
          {
            status: "error",
            error: error instanceof Error ? error.message : "Unknown settlement error",
          },
          500
        );
      }
    });

    // Transaction status lookup
    this.app.get("/transaction/:hash", async (c) => {
      try {
        const hash = c.req.param("hash");
        const status = await this.settler.getTransactionStatus(hash);

        if (!status.found) {
          return c.json({ error: "Transaction not found" }, 404);
        }

        return c.json(status);
      } catch (error) {
        console.error("[Facilitator] Transaction lookup error:", error);
        return c.json(
          {
            error: error instanceof Error ? error.message : "Unknown error",
          },
          500
        );
      }
    });
  }

  private async catalogSuccessfulPayment(
    paymentPayload: any,
    paymentRequirements: any
  ): Promise<void> {
    const bazaarUrl = process.env.BAZAAR_URL;
    if (!bazaarUrl) return;

    const discovered = extractDiscoveryInfo(paymentPayload, paymentRequirements) as any;
    if (!discovered) return;
    const info: any = discovered.discoveryInfo;
    const resourceType = info.input?.type === "mcp" ? "mcp" : "http";
    const response = await fetch(new URL("/catalog/ingest", bazaarUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.BAZAAR_INTERNAL_TOKEN
          ? { Authorization: `Bearer ${process.env.BAZAAR_INTERNAL_TOKEN}` }
          : {}),
      },
      body: JSON.stringify({
        resourceUrl: discovered.resourceUrl,
        resourceType,
        toolName: resourceType === "mcp" ? info.input.toolName : undefined,
        payTo: paymentRequirements.payTo,
        network: paymentRequirements.network,
        scheme: paymentRequirements.scheme,
        bazaarExtension: {
          serviceName: discovered.serviceName,
          description: discovered.description || info.input?.description || discovered.resourceUrl,
          tags: discovered.tags,
          iconUrl: discovered.iconUrl,
          routeTemplate: discovered.routeTemplate,
          mimeType: discovered.mimeType || "application/json",
          inputSpec: info.input || {},
          outputSpec: info.output,
        },
        extensions: discovered.extensions,
        settlementSucceeded: true,
      }),
    });
    if (!response.ok) throw new Error(`Bazaar ingestion returned HTTP ${response.status}`);
  }

  /**
   * Start the Facilitator service
   */
  async start(): Promise<void> {
    console.log("[Facilitator] Starting Veridex x402 Facilitator Service...");

    // Validate configuration
    if (!this.config.stellar.facilitatorSecretKey) {
      throw new Error("FACILITATOR_SECRET_KEY is required");
    }

    // Initialize channel pool
    console.log("[Facilitator] Initializing channel pool...");
    await this.channelPool.initialize();
    this.x402Facilitator.refreshSigners();
    console.log("[Facilitator] ✓ Channel pool ready");

    // Start HTTP server
    console.log(`[Facilitator] Starting HTTP server on ${this.config.host}:${this.config.port}...`);
    this.httpServer = serve({
      fetch: this.app.fetch,
      port: this.config.port,
      hostname: this.config.host,
    });

    console.log(`[Facilitator] ✓ Service ready at http://${this.config.host}:${this.config.port}`);
    console.log(`[Facilitator] Network: ${this.config.stellar.network}`);
    console.log(`[Facilitator] Facilitator: ${this.config.stellar.facilitatorPublicKey}`);
    console.log("[Facilitator] Endpoints:");
    console.log("  POST /verify");
    console.log("  POST /settle");
    console.log("  GET  /supported");
    console.log("  GET  /health");
    console.log("  GET  /stats");
    console.log("  GET  /transaction/:hash");
  }

  /**
   * Stop the service
   */
  async stop(): Promise<void> {
    console.log("[Facilitator] Stopping service...");
    if (this.httpServer) {
      await new Promise<void>((resolve, reject) =>
        this.httpServer!.close((error?: Error) => (error ? reject(error) : resolve()))
      );
      this.httpServer = undefined;
    }
    await this.channelPool.shutdown();
    console.log("[Facilitator] Service stopped");
  }

  /**
   * Get Hono app instance (for testing)
   */
  getApp(): Hono {
    return this.app;
  }
}

/**
 * Create and start Facilitator service
 */
export async function startFacilitatorService(
  config?: Partial<FacilitatorServiceConfig>
): Promise<FacilitatorService> {
  const fullConfig = { ...getDefaultConfig(), ...config };
  const service = new FacilitatorService(fullConfig);
  await service.start();
  return service;
}

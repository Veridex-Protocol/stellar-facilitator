/**
 * Veridex Facilitator Service - HTTP Server
 * License: Apache-2.0
 *
 * Canonical x402 v2 facilitator for Stellar:
 * - POST /verify              verify a payment before settling it
 * - POST /settle              submit a verified payment to the network
 * - GET  /supported           schemes, networks, signers, fee sponsorship
 * - GET  /.well-known/x402    capability descriptor (x402ccd/0)
 * - GET  /health              liveness plus the facts this deployment claims
 * - GET  /ready               readiness after channel and network checks pass
 * - GET  /stats               in-process counters since boot
 *
 * Everything advertised here is checked against the network at boot. See
 * `startup.ts`: the process refuses to start rather than advertise a scheme
 * with no contract behind it, or fee sponsorship from an unfunded account.
 */

import { Hono } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import { extractDiscoveryInfo } from "@x402/extensions/bazaar";
import type { SettleResponse, VerifyResponse } from "@x402/core/types";
import { ChannelAccountPool, createChannelPool } from "./channel/pool.js";
import {
  StellarTransactionVerifier,
  StellarTransactionSettler,
  X402Facilitator,
  createVerifier,
  createSettler,
  generateJobReceipt,
} from "./stellar/index.js";
import type { X402StellarResponse, StellarNetworkConfig } from "./stellar/types.js";
import type { ChannelPoolConfig } from "./channel/types.js";
import { createLogger, type Logger } from "./logger.js";
import { rateLimit } from "./rate-limit.js";
import { validateFacilitatorRequest } from "./validation.js";
import { LOCAL_REASONS, classifyError, describeReason, errorDetail } from "./reasons.js";
import { withLedgerSkewRetry, settleRetryReason } from "./retry.js";
import { SignerBusyError } from "./settle-scheduler.js";
import {
  assertSignerKeypairConsistent,
  assertSupportedIsTruthful,
  checkSponsorFunding,
  resolveUptoGate,
  type SupportedKind,
} from "./startup.js";
import {
  buildCapabilityDescriptor,
  loadCapabilityJobs,
  type CapabilityJob,
} from "./capability-descriptor.js";
import { createFacilitatorMetrics, type PrometheusRegistry } from "./metrics.js";
import { RpcCoordinator } from "./rpc-coordinator.js";
import { CatalogOutbox, type CatalogOutboxEvent } from "./catalog-outbox.js";

/** Legacy (pre-canonical) Stellar request, served only under /legacy/*. */
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

export interface FacilitatorServiceConfig {
  port: number;
  host: string;
  /** Public origin this deployment is reachable at. Advertised in the descriptor. */
  baseUrl: string;
  stellar: StellarNetworkConfig;
  channelPool: Partial<ChannelPoolConfig>;
  /** Ceiling on the network fee this facilitator will sponsor, in stroops. */
  maxTransactionFeeStroops: number;
  ledgerSkew: { retries: number; delayMs: number };
  /** How long a settlement may wait for a free signer before being refused. */
  settleQueueTimeoutMs: number;
  /** Maximum best-effort delay after settlement while reporting catalog status. */
  catalogHandoffTimeoutMs: number;
  catalogOutboxDirectory: string;
  catalogOutboxReplayIntervalMs: number;
  catalogOutboxBatchSize: number;
  rpcRequestTimeoutMs: number;
  rateLimit: { windowMs: number; max: number };
  /** Path to the JSON job list backing `/.well-known/x402`. */
  jobsFile?: string;
  /** Whether this deployment intends to sponsor fees; confirmed against Horizon at boot. */
  intendToSponsorFees: boolean;
}

/**
 * Builds configuration from the environment.
 *
 * @returns Validated service configuration
 * @throws {Error} When a required variable is missing or malformed
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

  const networkPassphrase = network === "pubnet" ? Networks.PUBLIC : Networks.TESTNET;

  const horizonUrl =
    process.env.HORIZON_URL ||
    (network === "pubnet" ? "https://horizon.stellar.org" : "https://horizon-testnet.stellar.org");

  const rpcUrl =
    process.env.SOROBAN_RPC_URL ||
    (network === "pubnet" ? "https://mainnet.sorobanrpc.com" : "https://soroban-testnet.stellar.org");
  const rpcUrls = (process.env.SOROBAN_RPC_URLS || rpcUrl)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const port = parseInt(process.env.FACILITATOR_PORT || "3002", 10);
  const host = process.env.FACILITATOR_HOST || "0.0.0.0";

  // The descriptor publishes this to clients as where to reach the service, so
  // it cannot be guessed from a bind address that is usually 0.0.0.0.
  const baseUrl = process.env.BASE_URL?.replace(/\/+$/, "") || "";
  if (!baseUrl) {
    throw new Error(
      "BASE_URL is required: it is the public origin advertised in /.well-known/x402. Set it to the URL clients reach this facilitator at (e.g. http://localhost:3002 for local runs).",
    );
  }

  return {
    port,
    host,
    baseUrl,
    maxTransactionFeeStroops: parseInt(process.env.MAX_TRANSACTION_FEE_STROOPS || "50000", 10),
    ledgerSkew: {
      retries: parseInt(process.env.LEDGER_SKEW_RETRIES || "2", 10),
      // Must outlast one ledger close (~5s) or every attempt re-observes the
      // same divergence. See retry.ts.
      delayMs: parseInt(process.env.LEDGER_SKEW_RETRY_DELAY_MS || "6000", 10),
    },
    rateLimit: {
      windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000", 10),
      max: parseInt(process.env.RATE_LIMIT_MAX || "120", 10),
    },
    // Long enough to ride out a settlement ahead in the queue, short enough
    // that a caller gets a usable answer well inside a typical HTTP timeout.
    settleQueueTimeoutMs: parseInt(process.env.SETTLE_QUEUE_TIMEOUT_MS || "30000", 10),
    catalogHandoffTimeoutMs: parseInt(process.env.CATALOG_HANDOFF_TIMEOUT_MS || "2000", 10),
    catalogOutboxDirectory: process.env.CATALOG_OUTBOX_DIRECTORY || ".veridex/catalog-outbox",
    catalogOutboxReplayIntervalMs: parseInt(process.env.CATALOG_OUTBOX_REPLAY_INTERVAL_MS || "5000", 10),
    catalogOutboxBatchSize: parseInt(process.env.CATALOG_OUTBOX_BATCH_SIZE || "20", 10),
    rpcRequestTimeoutMs: parseInt(process.env.RPC_REQUEST_TIMEOUT_MS || "5000", 10),
    jobsFile: process.env.X402_JOBS_FILE || undefined,
    intendToSponsorFees: process.env.SPONSOR_FEES !== "false",
    stellar: {
      network,
      networkPassphrase,
      horizonUrl,
      rpcUrl,
      rpcUrls,
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

/** What this deployment has established about itself, as opposed to intends. */
interface VerifiedCapabilities {
  /** True only once Horizon has confirmed the sponsoring account is funded. */
  feesAreSponsored: boolean;
  /** Set only once a contract has been confirmed deployed at the configured id. */
  uptoContractId?: string;
  jobs: CapabilityJob[];
  /** Whether the boot-time checks have run. False means nothing here is confirmed. */
  checked: boolean;
  notes: string[];
}

export class FacilitatorService {
  private app: Hono;
  private config: FacilitatorServiceConfig;
  private channelPool: ChannelAccountPool;
  private verifier: StellarTransactionVerifier;
  private settler: StellarTransactionSettler;
  private x402Facilitator: X402Facilitator;
  private logger: Logger;
  private metrics: PrometheusRegistry;
  private rpcCoordinator?: RpcCoordinator;
  private catalogOutbox: CatalogOutbox;
  private catalogOutboxInterval?: NodeJS.Timeout;
  private catalogOutboxDraining = false;
  private httpServer?: ServerType;
  private serviceReady = false;
  private capabilities: VerifiedCapabilities;
  private stats: {
    totalVerifications: number;
    successfulVerifications: number;
    totalSettlements: number;
    successfulSettlements: number;
    ledgerSkewRetries: number;
    ledgerSkewRecoveries: number;
    startTime: number;
  };

  constructor(config: FacilitatorServiceConfig, logger: Logger = createLogger()) {
    this.config = config;
    this.logger = logger;
    this.metrics = createFacilitatorMetrics();
    this.catalogOutbox = new CatalogOutbox(config.catalogOutboxDirectory);
    this.app = new Hono();

    this.channelPool = createChannelPool(config.channelPool);
    this.verifier = createVerifier(config.stellar);
    this.settler = createSettler(config.stellar, this.channelPool);

    // Nothing is confirmed until start() runs, so the service claims nothing.
    this.capabilities = { feesAreSponsored: false, jobs: [], checked: false, notes: [] };

    this.x402Facilitator = new X402Facilitator({
      channelPool: this.channelPool,
      networkPassphrase: config.stellar.networkPassphrase,
      feeBumpSignerSecret:
        process.env.FEE_BUMP_SIGNER_SECRET || config.stellar.facilitatorSecretKey,
      areFeesSponsored: false,
      rpcUrl: config.stellar.rpcUrl,
      maxTransactionFeeStroops: config.maxTransactionFeeStroops,
      settleQueueTimeoutMs: config.settleQueueTimeoutMs,
    });

    this.stats = {
      totalVerifications: 0,
      successfulVerifications: 0,
      totalSettlements: 0,
      successfulSettlements: 0,
      ledgerSkewRetries: 0,
      ledgerSkewRecoveries: 0,
      startTime: Date.now(),
    };

    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    this.app.use("*", secureHeaders());
    this.app.use(
      "*",
      cors({
        origin: process.env.CORS_ORIGINS?.split(",").map((o) => o.trim()) ?? "*",
        allowMethods: ["GET", "POST", "OPTIONS"],
        allowHeaders: ["Content-Type", "Authorization", "X-Resource-URL", "X-Job-Id"],
        // Cataloging outcomes are reported in this header; without exposing it
        // a browser-based caller cannot read its own listing result.
        exposeHeaders: ["EXTENSION-RESPONSES", "RateLimit-Limit", "RateLimit-Remaining", "Retry-After"],
      }),
    );

    // A signed Stellar envelope is a few KB. Anything approaching this ceiling
    // is not a payment.
    this.app.use("*", bodyLimit({ maxSize: 256 * 1024, onError: (c) =>
      c.json(
        {
          error: "payload_too_large",
          message: "Request body exceeds 256KB. An x402 payment envelope is a few kilobytes.",
        },
        413,
      ),
    }));

    // Settlement spends real XLM from this facilitator's own account, so cap
    // how fast anyone can make it do that.
    this.app.use(
      "*",
      rateLimit({
        windowMs: this.config.rateLimit.windowMs,
        max: this.config.rateLimit.max,
        onRejected: (c) =>
          this.logger.outcome({
            endpoint: c.req.path,
            outcome: "rate_limited",
            status: 429,
            latencyMs: 0,
          }),
      }),
    );
  }

  /**
   * Builds the `/supported` body from what has actually been confirmed.
   *
   * @returns The response served at GET /supported
   */
  private buildSupported(): { kinds: SupportedKind[]; extensions: string[]; signers: Record<string, string[]> } {
    const network = `stellar:${this.config.stellar.network}`;
    const kinds: SupportedKind[] = [
      {
        x402Version: 2,
        scheme: "exact",
        network,
        extra: this.x402Facilitator.getExtra(network as any),
      },
    ];

    // `upto` appears only when startup confirmed a real contract on this
    // network. It is otherwise absent entirely - not advertised against a
    // placeholder id, and not advertised as "coming".
    if (this.capabilities.uptoContractId) {
      kinds.push({
        x402Version: 2,
        scheme: "upto",
        network,
        extra: this.x402Facilitator.getUptoExtra(network as any) ?? {
          contractId: this.capabilities.uptoContractId,
        },
      });
    }

    return {
      kinds,
      extensions: ["bazaar"],
      signers: { "stellar:*": this.x402Facilitator.getSigners(network) },
    };
  }

  /** Schemes this deployment actually advertises right now. */
  private advertisedSchemes(): string[] {
    return this.buildSupported().kinds.map((kind) => kind.scheme);
  }

  private setupRoutes(): void {
    this.app.get("/health", (c) =>
      c.json({
        status: "ok",
        timestamp: Date.now(),
        network: `stellar:${this.config.stellar.network}`,
        facilitator: this.config.stellar.facilitatorPublicKey,
        areFeesSponsored: this.capabilities.feesAreSponsored,
        startupChecksPassed: this.capabilities.checked,
        channels: this.channelPool.getStats(),
      }),
    );

    this.app.get("/ready", (c) => {
      const ready = this.serviceReady && this.capabilities.checked;
      return c.json({
        status: ready ? "ready" : "not_ready",
        serviceStarted: this.serviceReady,
        startupChecksPassed: this.capabilities.checked,
        schemes: this.advertisedSchemes(),
        timestamp: Date.now(),
      }, ready ? 200 : 503);
    });

    this.app.get("/stats", async (c) => {
      const uptime = Date.now() - this.stats.startTime;
      const catalogOutbox = await this.catalogOutbox.stats().catch(() => ({ pending: 0, oldestAgeSeconds: 0 }));
      return c.json({
        uptime,
        // These reset on restart. Published reliability figures must come from
        // the structured request_outcome log lines, not from here.
        note: "In-process counters since boot. They reset on restart; derive published figures from the request_outcome log lines.",
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
        ledgerSkew: {
          retriesIssued: this.stats.ledgerSkewRetries,
          recoveredAfterRetry: this.stats.ledgerSkewRecoveries,
        },
        // Settlement concurrency is bounded by the number of funded signer
        // accounts. A rising 'queued' or any 'totalRejected' means the pool is
        // too small for the offered load.
        settlementConcurrency: this.x402Facilitator.getSchedulerStats(),
        channels: this.channelPool.getStats(),
        rpcProviders: this.rpcCoordinator?.getHealth() ?? [{
          url: this.config.stellar.rpcUrl,
          healthy: true,
          consecutiveFailures: 0,
        }],
        catalogOutbox,
        timestamp: Date.now(),
      });
    });

    this.app.get("/metrics", async (c) => {
      const scheduler = this.x402Facilitator.getSchedulerStats();
      const channels = this.channelPool.getStats();
      const outbox = await this.catalogOutbox.stats().catch(() => ({ pending: 0, oldestAgeSeconds: 0 }));
      this.metrics.set("veridex_channel_available", Math.max(0, scheduler.poolSize - scheduler.inFlight));
      this.metrics.set("veridex_channel_in_use", scheduler.inFlight);
      this.metrics.set("veridex_channel_quarantined", channels.error);
      this.metrics.set("veridex_catalog_outbox_pending", outbox.pending);
      this.metrics.set("veridex_catalog_outbox_oldest_age", outbox.oldestAgeSeconds);
      c.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
      return c.body(this.metrics.render());
    });

    this.app.get("/supported", (c) => c.json(this.buildSupported()));

    this.app.get("/.well-known/x402", (c) =>
      c.json(
        buildCapabilityDescriptor({
          baseUrl: this.config.baseUrl,
          network: `stellar:${this.config.stellar.network}`,
          receiptSigner: this.config.stellar.facilitatorPublicKey,
          advertisedSchemes: this.advertisedSchemes(),
          jobs: this.capabilities.jobs,
        }),
      ),
    );

    const canonicalVerify = async (c: any) => {
      const startedAt = performance.now();
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        body = undefined;
      }

      const invalidRequest = validateFacilitatorRequest(body);
      if (invalidRequest) {
        const response: VerifyResponse = {
          isValid: false,
          invalidReason: LOCAL_REASONS.INVALID_REQUEST_BODY,
          invalidMessage: invalidRequest,
        };
        this.logger.outcome({
          endpoint: "/verify",
          outcome: "invalid",
          reason: response.invalidReason,
          status: 400,
          latencyMs: Math.round(performance.now() - startedAt),
        });
        return c.json(response, 400);
      }

      const { paymentPayload, paymentRequirements } = body as any;
      this.stats.totalVerifications++;
      this.metrics.increment("veridex_verifications_total");
      this.metrics.increment("veridex_rpc_requests_total");

      try {
        let attempts = 0;
        const result = this.withVerifyReason(
          await withLedgerSkewRetry(
            () => {
              attempts++;
              return this.x402Facilitator.verify(paymentPayload, paymentRequirements);
            },
            (r) => (r.isValid ? undefined : r.invalidReason),
            this.config.ledgerSkew,
            this.logger,
            "/verify",
          ),
        );
        this.recordSkew(attempts, result.isValid);

        if (result.isValid) this.stats.successfulVerifications++;

        this.logger.outcome({
          endpoint: "/verify",
          outcome: result.isValid ? "valid" : "invalid",
          reason: result.invalidReason,
          payer: (result as any).payer,
          status: 200,
          latencyMs: Math.round(performance.now() - startedAt),
          skewRetries: attempts - 1,
        });
        // A rejection is a valid protocol answer, not a transport failure. The
        // body carries the reason; the status stays 200 so stock clients read it.
        return c.json(result, 200);
      } catch (error) {
        const reason = classifyError(error);
        const isClientFault = reason === LOCAL_REASONS.UNSUPPORTED_SCHEME_OR_NETWORK;
        const response: VerifyResponse = {
          isValid: false,
          invalidReason: reason,
          invalidMessage: `${describeReason(reason)} (detail: ${errorDetail(error)})`,
        };
        this.logger.warn("verify raised", { reason, detail: errorDetail(error) });
        if (reason === LOCAL_REASONS.UPSTREAM_RPC_UNAVAILABLE) {
          this.metrics.increment("veridex_rpc_failures_total");
        }
        this.logger.outcome({
          endpoint: "/verify",
          outcome: isClientFault ? "invalid" : "error",
          reason,
          status: isClientFault ? 200 : 502,
          latencyMs: Math.round(performance.now() - startedAt),
        });
        return c.json(response, isClientFault ? 200 : 502);
      }
    };
    this.app.post("/verify", canonicalVerify);
    this.app.post("/x402/verify", canonicalVerify);

    const canonicalSettle = async (c: any) => {
      const startedAt = performance.now();
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        body = undefined;
      }

      const invalidRequest = validateFacilitatorRequest(body);
      if (invalidRequest) {
        const response: SettleResponse = {
          success: false,
          transaction: "",
          network: (body as any)?.paymentRequirements?.network ?? `stellar:${this.config.stellar.network}`,
          errorReason: LOCAL_REASONS.INVALID_REQUEST_BODY,
          errorMessage: invalidRequest,
        };
        this.logger.outcome({
          endpoint: "/settle",
          outcome: "failed",
          reason: response.errorReason,
          status: 400,
          latencyMs: Math.round(performance.now() - startedAt),
        });
        return c.json(response, 400);
      }

      const { paymentPayload, paymentRequirements } = body as any;
      this.stats.totalSettlements++;
      this.metrics.increment("veridex_settlements_total");
      this.metrics.increment("veridex_rpc_requests_total");

      try {
        let attempts = 0;
        const result = this.withSettleReason(
          await withLedgerSkewRetry(
            () => {
              attempts++;
              return this.x402Facilitator.settle(paymentPayload, paymentRequirements);
            },
            // Never retry a failure carrying a transaction hash: it reached the
            // network, and retrying risks settling the same payment twice.
            settleRetryReason,
            this.config.ledgerSkew,
            this.logger,
            "/settle",
          ),
        );
        this.recordSkew(attempts, result.success);

        if (!result.success) {
          this.metrics.increment("veridex_settlement_failures_total");
          this.metrics.observe("veridex_settlement_latency", (performance.now() - startedAt) / 1000);
          this.logger.outcome({
            endpoint: "/settle",
            outcome: "failed",
            reason: result.errorReason,
            transaction: result.transaction || undefined,
            status: 200,
            latencyMs: Math.round(performance.now() - startedAt),
            skewRetries: attempts - 1,
          });
          return c.json(result, 200);
        }

        this.stats.successfulSettlements++;

        // A failure to catalog must never fail a settled payment: the money has
        // already moved. The outcome is reported to the seller in the header.
        const extensionResponses = await this.catalogSuccessfulPayment(
          paymentPayload,
          paymentRequirements,
          result,
        ).catch((error) => {
          this.logger.warn("Bazaar catalog update failed", { detail: errorDetail(error) });
          return undefined;
        });

        if (extensionResponses) c.header("EXTENSION-RESPONSES", extensionResponses);

        const receipt = this.issueReceipt(c, paymentPayload, paymentRequirements, result);

        this.logger.outcome({
          endpoint: "/settle",
          outcome: "settled",
          transaction: result.transaction,
          payer: (result as any).payer,
          status: 200,
          latencyMs: Math.round(performance.now() - startedAt),
          skewRetries: attempts - 1,
        });
        this.metrics.observe("veridex_settlement_latency", (performance.now() - startedAt) / 1000);
        return c.json(receipt ? { ...result, receipt } : result, 200);
      } catch (error) {
        // Being refused for capacity is a definite "no funds moved", which is
        // more useful to a client than an ambiguous transport error.
        const busy = error instanceof SignerBusyError;
        const reason = busy ? LOCAL_REASONS.SETTLEMENT_CAPACITY_EXCEEDED : classifyError(error);
        const response: SettleResponse = {
          success: false,
          transaction: "",
          network: paymentRequirements.network,
          errorReason: reason,
          errorMessage: busy ? (error as SignerBusyError).message : `${describeReason(reason)} (detail: ${errorDetail(error)})`,
        };
        this.metrics.increment("veridex_settlement_failures_total");
        this.metrics.observe("veridex_settlement_latency", (performance.now() - startedAt) / 1000);
        if (reason === LOCAL_REASONS.UPSTREAM_RPC_UNAVAILABLE) {
          this.metrics.increment("veridex_rpc_failures_total");
        }
        if (busy) {
          this.logger.warn("settlement refused: all signers busy", {
            waitedMs: (error as SignerBusyError).waitedMs,
            poolSize: (error as SignerBusyError).poolSize,
          });
        } else {
          this.logger.warn("settle raised", { reason, detail: errorDetail(error) });
        }
        this.logger.outcome({
          endpoint: "/settle",
          outcome: "failed",
          reason,
          status: busy ? 503 : 502,
          latencyMs: Math.round(performance.now() - startedAt),
        });
        if (busy) c.header("Retry-After", "5");
        return c.json(response, busy ? 503 : 502);
      }
    };
    this.app.post("/settle", canonicalSettle);
    this.app.post("/x402/settle", canonicalSettle);

    this.setupLegacyRoutes();

    this.app.get("/transaction/:hash", async (c) => {
      try {
        const status = await this.settler.getTransactionStatus(c.req.param("hash"));
        if (!status.found) return c.json({ error: "Transaction not found" }, 404);
        return c.json(status);
      } catch (error) {
        return c.json({ error: errorDetail(error) }, 500);
      }
    });

    this.app.notFound((c) =>
      c.json(
        {
          error: "not_found",
          message:
            "Unknown endpoint. This facilitator serves POST /verify, POST /settle, GET /supported, GET /.well-known/x402, GET /health and GET /stats.",
        },
        404,
      ),
    );

    this.app.onError((error, c) => {
      const reason = classifyError(error);
      this.logger.error("unhandled error", { reason, detail: errorDetail(error) });
      return c.json(
        { error: reason, message: `${describeReason(reason)} (detail: ${errorDetail(error)})` },
        500,
      );
    });
  }

  /**
   * Guarantees a verify rejection carries both a code and a sentence.
   *
   * @param response - Response from the scheme
   * @returns The response with both fields populated when invalid
   */
  private withVerifyReason(response: VerifyResponse): VerifyResponse {
    if (response.isValid) return response;
    const invalidReason = response.invalidReason?.trim() || LOCAL_REASONS.FACILITATOR_INTERNAL_ERROR;
    return {
      ...response,
      invalidReason,
      invalidMessage: response.invalidMessage?.trim() || describeReason(invalidReason),
    };
  }

  /**
   * Guarantees a settle failure carries both a code and a sentence.
   *
   * @param response - Response from the scheme
   * @returns The response with both fields populated when failed
   */
  private withSettleReason(response: SettleResponse): SettleResponse {
    if (response.success) return response;
    const errorReason = response.errorReason?.trim() || LOCAL_REASONS.FACILITATOR_INTERNAL_ERROR;
    return {
      ...response,
      errorReason,
      errorMessage: response.errorMessage?.trim() || describeReason(errorReason),
    };
  }

  /**
   * Records whether a ledger-skew retry fired and whether it recovered.
   *
   * @param attempts - How many attempts the operation took
   * @param succeeded - Whether the final attempt succeeded
   */
  private recordSkew(attempts: number, succeeded: boolean): void {
    if (attempts <= 1) return;
    this.stats.ledgerSkewRetries += attempts - 1;
    if (succeeded) this.stats.ledgerSkewRecoveries++;
  }

  /**
   * Issues an `x402job/1` receipt for a settled payment.
   *
   * Returns undefined rather than inventing a value when the settlement does
   * not name a payer: a receipt asserting the wrong payer is worse than no
   * receipt, and the previous implementation substituted `payTo` - the
   * recipient - when the payer was unknown.
   *
   * @param c - Request context, read for an optional caller-supplied job id
   * @param paymentPayload - The exact payload received
   * @param paymentRequirements - The requirements it was settled against
   * @param result - The settlement response
   * @returns A signed receipt, or undefined when one cannot be issued truthfully
   */
  private issueReceipt(
    c: any,
    paymentPayload: unknown,
    paymentRequirements: any,
    result: SettleResponse,
  ) {
    const payer = (result as any).payer;
    if (!payer) {
      this.logger.debug("no receipt issued: settlement did not name a payer", {
        transaction: result.transaction,
      });
      return undefined;
    }

    try {
      return generateJobReceipt({
        serviceUrl: this.config.baseUrl,
        // The job the facilitator performed is the settlement itself, unless
        // the caller names the job the payment bought.
        jobId: c.req.header("X-Job-Id") || "x402/settle",
        requestBody: paymentPayload,
        resultBody: result,
        txHash: result.transaction,
        payer,
        asset: paymentRequirements.asset,
        amount: paymentRequirements.amount,
        network: paymentRequirements.network,
        signerSecretKey: this.config.stellar.facilitatorSecretKey,
        signerPublicKey: this.config.stellar.facilitatorPublicKey,
      });
    } catch (error) {
      this.logger.warn("receipt generation failed", { detail: errorDetail(error) });
      return undefined;
    }
  }

  private setupLegacyRoutes(): void {
    // Pre-canonical shape, kept for existing integrations. Classic payment
    // operations only; the canonical v2 path above is the supported one.
    this.app.post("/legacy/verify", async (c) => {
      try {
        const request = X402StellarRequestSchema.parse(await c.req.json());
        this.stats.totalVerifications++;
        const result = await this.verifier.verify(request, c.req.header("X-Expected-Amount"));

        if (result.valid) {
          this.stats.successfulVerifications++;
          return c.json({
            status: "success",
            valid: true,
            facilitatorAccount: result.facilitatorAccount,
            expectedAmount: result.expectedAmount,
          });
        }
        return c.json({ status: "error", valid: false, error: result.error }, 400);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return c.json(
            { status: "error", error: "Invalid request format", details: error.errors },
            400,
          );
        }
        return c.json({ status: "error", error: errorDetail(error) }, 500);
      }
    });

    this.app.post("/legacy/settle", async (c) => {
      try {
        const request = X402StellarRequestSchema.parse(await c.req.json());
        this.stats.totalSettlements++;
        const expectedAmount = c.req.header("X-Expected-Amount");

        const verifyResult = await this.verifier.verify(request, expectedAmount);
        if (!verifyResult.valid) {
          return c.json({ status: "error", error: `Verification failed: ${verifyResult.error}` }, 400);
        }
        if (!verifyResult.transaction) {
          return c.json({ status: "error", error: "Transaction parsing failed" }, 500);
        }

        const settleResult = await this.settler.settle(verifyResult.transaction);
        if (settleResult.success) {
          this.stats.successfulSettlements++;
          const response: X402StellarResponse = {
            status: "success",
            transactionHash: settleResult.transactionHash,
            ledger: settleResult.ledger,
          };
          return c.json(response);
        }
        const response: X402StellarResponse = {
          status: "error",
          error: settleResult.error,
          errorCode: settleResult.errorCode,
        };
        return c.json(response, 500);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return c.json(
            { status: "error", error: "Invalid request format", details: error.errors },
            400,
          );
        }
        return c.json({ status: "error", error: errorDetail(error) }, 500);
      }
    });
  }

  /**
   * Posts a settled payment's discovery metadata to the Bazaar catalog.
   *
   * The settlement transaction hash goes with it so the catalog can confirm
   * the payment independently on Horizon rather than taking this service's
   * word for it.
   *
   * Returns the catalog's EXTENSION-RESPONSES value so it can travel back to
   * the seller on the settle response. Without that, a seller has no way to
   * learn that their listing was rejected, or why - the feedback loop the
   * discovery spec asks for.
   *
   * @param paymentPayload - The payload that was settled
   * @param paymentRequirements - The requirements it settled against
   * @param result - The settlement response, for the transaction hash
   * @returns The base64 EXTENSION-RESPONSES value, or undefined when nothing was catalogued
   */
  private async catalogSuccessfulPayment(
    paymentPayload: any,
    paymentRequirements: any,
    result: SettleResponse,
  ): Promise<string | undefined> {
    const bazaarUrl = process.env.BAZAAR_URL;
    if (!bazaarUrl) return undefined;

    const discovered = extractDiscoveryInfo(paymentPayload, paymentRequirements) as any;
    if (!discovered) return undefined;
    const info: any = discovered.discoveryInfo;
    const resourceType = info.input?.type === "mcp" ? "mcp" : "http";
    const payload = {
        resourceUrl: discovered.resourceUrl,
        validationUrl: paymentPayload.resource?.url ?? discovered.resourceUrl,
        resourceType,
        toolName: resourceType === "mcp" ? info.input.toolName : undefined,
        payTo: paymentRequirements.payTo,
        network: paymentRequirements.network,
        scheme: paymentRequirements.scheme,
        asset: paymentPayload.accepted?.asset ?? paymentRequirements.asset,
        amount: paymentPayload.accepted?.amount ?? paymentRequirements.amount,
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
        settlementTx: result.transaction,
        ...(paymentRequirements.scheme === "upto" ? {
          settlementProof: {
            scheme: "upto",
            uptoContractId: paymentRequirements.extra?.contractId,
            expectedToken: paymentRequirements.asset,
            expectedMaxAmount: paymentPayload.accepted.amount,
            expectedActual: paymentRequirements.amount,
            expectedResultDigest: paymentPayload.payload?.resultDigest,
          },
        } : {}),
      };
    const event = await this.catalogOutbox.enqueue(result.transaction, payload);
    return this.deliverCatalogEvent(event);
  }

  private async deliverCatalogEvent(event: CatalogOutboxEvent): Promise<string | undefined> {
    const bazaarUrl = process.env.BAZAAR_URL;
    if (!bazaarUrl) return undefined;
    const attempted = await this.catalogOutbox.markAttempt(event);
    const response = await postCatalogIngest(new URL("/catalog/ingest", bazaarUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.BAZAAR_INTERNAL_TOKEN
          ? { Authorization: `Bearer ${process.env.BAZAAR_INTERNAL_TOKEN}` }
          : {}),
      },
      body: JSON.stringify(attempted.payload),
    }, this.config.catalogHandoffTimeoutMs);
    // The catalog reports the outcome in this header on both acceptance and
    // rejection, so read it before deciding whether this was an error.
    const extensionResponses = response.headers.get("EXTENSION-RESPONSES") ?? undefined;

    if (response.status >= 500 || (!response.ok && !extensionResponses)) {
      throw new Error(`Bazaar ingestion returned HTTP ${response.status}`);
    }
    await this.catalogOutbox.acknowledge(event.id);
    if (!response.ok) {
      this.logger.info("catalog rejected the listing", {
        status: response.status,
        transaction: event.id,
      });
    }

    return extensionResponses;
  }

  async drainCatalogOutbox(): Promise<void> {
    if (this.catalogOutboxDraining || !process.env.BAZAAR_URL) return;
    this.catalogOutboxDraining = true;
    try {
      const events = await this.catalogOutbox.list(this.config.catalogOutboxBatchSize);
      for (const event of events) {
        try {
          await this.deliverCatalogEvent(event);
        } catch (error) {
          this.logger.warn("catalog outbox event retained", {
            transaction: event.id,
            attempts: event.attempts + 1,
            detail: errorDetail(error),
          });
        }
      }
    } finally {
      this.catalogOutboxDraining = false;
    }
  }

  /**
   * Runs every boot-time check and records what was confirmed.
   *
   * Separated from `start()` so tests and a `--check` invocation can run the
   * checks without binding a port.
   *
   * @throws {Error} When the deployment cannot truthfully serve what it would advertise
   */
  async runStartupChecks(): Promise<void> {
    const { stellar } = this.config;
    const notes: string[] = [];

    assertSignerKeypairConsistent(stellar.facilitatorSecretKey, stellar.facilitatorPublicKey);

    if (this.config.maxTransactionFeeStroops > 50000) {
      console.warn(
        `[Facilitator] Warning: maxTransactionFeeStroops is configured at ${this.config.maxTransactionFeeStroops} stroops, exceeding the spec default of 50000 stroops (0.005 XLM).`,
      );
    }

    // 1. Fee sponsorship: a claim about an account balance, so ask the network.
    let feesAreSponsored = false;
    if (this.config.intendToSponsorFees) {
      const funding = await checkSponsorFunding(stellar.horizonUrl, stellar.facilitatorPublicKey);
      if (!funding.funded) {
        throw new Error(
          `This deployment is configured to sponsor network fees, but its account ${stellar.facilitatorPublicKey} ${funding.reason}. ` +
            `Fund it, or set SPONSOR_FEES=false to advertise areFeesSponsored=false instead. Refusing to start rather than advertise sponsorship it cannot honour.`,
        );
      }
      feesAreSponsored = true;
      notes.push(`fee sponsorship confirmed: ${funding.balanceXlm} XLM available`);
    } else {
      notes.push("fee sponsorship disabled by configuration (SPONSOR_FEES=false)");
    }
    this.x402Facilitator.setFeeSponsorship(feesAreSponsored);

    // 2. upto: advertised only against a contract confirmed on this network.
    const upto = await resolveUptoGate(stellar.network as "testnet" | "pubnet", stellar.rpcUrl);
    if (upto.advertise) {
      notes.push(`upto contract confirmed at ${upto.contractId}`);
      this.x402Facilitator.setUptoContract(upto.contractId);
    } else {
      notes.push(`upto not advertised: ${upto.reason}`);
      this.x402Facilitator.setUptoContract(undefined);
    }

    this.capabilities = {
      feesAreSponsored,
      uptoContractId: upto.contractId,
      jobs: [],
      checked: true,
      notes,
    };

    // 3. Descriptor jobs, validated against what we now advertise.
    this.capabilities.jobs = loadCapabilityJobs({
      jobsFile: this.config.jobsFile,
      network: `stellar:${stellar.network}`,
      advertisedSchemes: this.advertisedSchemes(),
    });
    notes.push(`${this.capabilities.jobs.length} job(s) advertised in /.well-known/x402`);

    // 4. Final gate: what we would serve must match what we confirmed.
    assertSupportedIsTruthful(this.buildSupported(), {
      network: `stellar:${stellar.network}`,
      feesAreSponsored,
      uptoContractId: upto.contractId,
      signerAddress: stellar.facilitatorPublicKey,
    });

    for (const note of notes) this.logger.info(note, { kind: "startup_check" });
  }

  /**
   * Starts the service: channel pool, startup checks, then bind.
   */
  async start(): Promise<void> {
    this.logger.info("starting Veridex x402 facilitator", {
      network: `stellar:${this.config.stellar.network}`,
      baseUrl: this.config.baseUrl,
    });

    try {
      const rpcProviders = this.config.stellar.rpcUrls ?? [this.config.stellar.rpcUrl];
      if (rpcProviders.length > 1) {
        if (this.config.stellar.network !== "testnet") {
          throw new Error("SOROBAN_RPC_URLS multi-provider mode is testnet-only until the local coordinator supports TLS");
        }
        this.rpcCoordinator = new RpcCoordinator({
          providers: rpcProviders,
          networkPassphrase: this.config.stellar.networkPassphrase,
          requestTimeoutMs: this.config.rpcRequestTimeoutMs,
          onFailure: () => this.metrics.increment("veridex_rpc_failures_total"),
          onDisagreement: () => this.metrics.increment("veridex_rpc_disagreements_total"),
        });
        const coordinatedRpcUrl = await this.rpcCoordinator.start();
        this.config.stellar.rpcUrl = coordinatedRpcUrl;
        this.verifier = createVerifier(this.config.stellar);
        this.x402Facilitator.setRpcUrl(coordinatedRpcUrl);
      }

      await this.channelPool.initialize();
      this.x402Facilitator.refreshSigners();

      // Everything advertised is confirmed here. A failure aborts the boot.
      await this.runStartupChecks();

      this.httpServer = serve({
        fetch: this.app.fetch,
        port: this.config.port,
        hostname: this.config.host,
      });
      this.serviceReady = true;
      if (this.config.catalogOutboxReplayIntervalMs > 0) {
        this.catalogOutboxInterval = setInterval(() => {
          this.drainCatalogOutbox().catch((error) =>
            this.logger.warn("catalog outbox replay failed", { detail: errorDetail(error) }),
          );
        }, this.config.catalogOutboxReplayIntervalMs);
      }
      void this.drainCatalogOutbox();
    } catch (error) {
      await this.rpcCoordinator?.stop();
      this.rpcCoordinator = undefined;
      throw error;
    }

    this.logger.info("facilitator ready", {
      url: `http://${this.config.host}:${this.config.port}`,
      facilitator: this.config.stellar.facilitatorPublicKey,
      areFeesSponsored: this.capabilities.feesAreSponsored,
      schemes: this.advertisedSchemes(),
    });
  }

  async stop(): Promise<void> {
    this.serviceReady = false;
    if (this.catalogOutboxInterval) {
      clearInterval(this.catalogOutboxInterval);
      this.catalogOutboxInterval = undefined;
    }
    if (this.httpServer) {
      await new Promise<void>((resolve, reject) =>
        this.httpServer!.close((error?: Error) => (error ? reject(error) : resolve())),
      );
      this.httpServer = undefined;
    }
    await this.channelPool.shutdown();
    await this.rpcCoordinator?.stop();
    this.rpcCoordinator = undefined;
    this.logger.info("facilitator stopped");
  }

  /** The Hono app, for testing. */
  getApp(): Hono {
    return this.app;
  }

  /** What this deployment has confirmed about itself, for testing. */
  getCapabilities(): Readonly<VerifiedCapabilities> {
    return this.capabilities;
  }
}

export async function postCatalogIngest(
  url: URL,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  return fetchImpl(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * Creates and starts the facilitator service.
 *
 * @param config - Optional overrides on top of the environment configuration
 * @returns The running service
 */
export async function startFacilitatorService(
  config?: Partial<FacilitatorServiceConfig>,
): Promise<FacilitatorService> {
  const fullConfig = { ...getDefaultConfig(), ...config };
  const service = new FacilitatorService(fullConfig);
  await service.start();
  return service;
}

/**
 * Signed provider-quality aggregates, caching, and seller policy.
 * License: Apache-2.0
 */

import { Keypair } from "@stellar/stellar-sdk";
import {
  canonicalizeJson,
  type ProviderOutcome,
} from "./provider-outcome.js";

export type ProviderAggregateState = "insufficient_data" | "provisional" | "published";

export interface ProviderAggregateUnsigned {
  v: "veridex/provider-aggregate/1";
  endpoint: string;
  payTo?: string;
  state: ProviderAggregateState;
  faultRateUpperBound: number;
  faultsObserved: number;
  n: number;
  window: string;
  retrievedAt: number;
}

export interface ProviderAggregate extends ProviderAggregateUnsigned {
  issuer: string;
  signature: string;
}

/** Public response used when an indexer has no observations to aggregate yet. */
export interface ProviderAggregateInsufficientData {
  v: "veridex/provider-aggregate/1";
  endpoint: string;
  payTo?: string;
  state: "insufficient_data";
  faultRateUpperBound: 1;
  faultsObserved: 0;
  n: 0;
  window: string;
  retrievedAt: number;
}

export interface ProviderAggregateValidationOptions {
  nowSeconds?: number;
  maxAgeSeconds?: number;
  futureSkewSeconds?: number;
  expectedEndpoint?: string;
  expectedPayTo?: string;
  expectedIssuer?: string;
  authorizedIssuers?: string[];
}

export interface ProviderAggregateValidation {
  valid: boolean;
  error?: string;
}

export interface AggregateLookup {
  status: "fresh" | "cached" | "unavailable" | "invalid";
  aggregate?: ProviderAggregate;
  state?: ProviderAggregateState;
  stale: boolean;
  error?: string;
}

export interface ProviderAggregateClientOptions {
  /** HTTPS base URL of the indexer exposing GET /v1/provider. */
  indexerUrl: string;
  maxAgeSeconds?: number;
  cacheTtlMs?: number;
  maxStaleMs?: number;
  timeoutMs?: number;
  backoffBaseMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface AggregateCacheEntry {
  aggregate: ProviderAggregate;
  cachedAt: number;
  failures: number;
  retryAt: number;
}

export interface SellerPolicyConfig {
  insufficientData: "sell" | "sell-and-warn" | "warn" | "hold";
  provisional: "sell" | "sell-and-warn" | "warn" | "hold";
  published: "sell" | "sell-and-warn" | "warn" | "hold" | "stop";
  warnMax: number;
  holdMax: number;
  /** @deprecated Use holdMax. */
  maxFaultRateUpperBound: number;
  staleAggregate: "preserve" | "warn" | "hold";
  invalidAggregate: "preserve" | "warn" | "hold";
  unavailableIndexer: "preserve" | "warn" | "hold";
  disagreement: "record" | "warn" | "hold";
  repeatedDisagreementThreshold: number;
}

export const DEFAULT_SELLER_POLICY: SellerPolicyConfig = {
  insufficientData: "sell-and-warn",
  provisional: "sell-and-warn",
  published: "sell",
  warnMax: 0.10,
  holdMax: 0.15,
  maxFaultRateUpperBound: 0.15,
  staleAggregate: "preserve",
  invalidAggregate: "preserve",
  unavailableIndexer: "preserve",
  disagreement: "warn",
  repeatedDisagreementThreshold: 3,
};

export interface SellerPolicyDecision {
  action: "sell" | "sell-and-warn" | "hold";
  reason: string;
  warning?: string;
}

export function createProviderAggregate(
  aggregate: Omit<ProviderAggregateUnsigned, "v">,
  issuerSecretKey: string,
): ProviderAggregate {
  const keypair = Keypair.fromSecret(issuerSecretKey);
  const unsigned: ProviderAggregateUnsigned = {
    v: "veridex/provider-aggregate/1",
    ...aggregate,
  };
  const validation = validateUnsignedAggregate(unsigned);
  if (!validation.valid) throw new Error(validation.error);
  return {
    ...unsigned,
    issuer: keypair.publicKey(),
    signature: keypair.sign(Buffer.from(canonicalizeJson(unsigned), "utf8")).toString("base64"),
  };
}

export function verifyProviderAggregate(
  aggregate: ProviderAggregate,
  options: ProviderAggregateValidationOptions = {},
): ProviderAggregateValidation {
  const unsigned: ProviderAggregateUnsigned = {
    v: aggregate.v,
    endpoint: aggregate.endpoint,
    ...(aggregate.payTo !== undefined && { payTo: aggregate.payTo }),
    state: aggregate.state,
    faultRateUpperBound: aggregate.faultRateUpperBound,
    faultsObserved: aggregate.faultsObserved,
    n: aggregate.n,
    window: aggregate.window,
    retrievedAt: aggregate.retrievedAt,
  };
  const validation = validateUnsignedAggregate(unsigned);
  if (!validation.valid) return validation;
  if (options.expectedEndpoint && aggregate.endpoint !== options.expectedEndpoint) {
    return { valid: false, error: "provider aggregate endpoint does not match the resource" };
  }
  if (options.expectedPayTo && aggregate.payTo !== options.expectedPayTo) {
    return { valid: false, error: "provider aggregate payTo does not match the resource" };
  }
  if (options.expectedIssuer && aggregate.issuer !== options.expectedIssuer) {
    return { valid: false, error: "provider aggregate issuer is not authorized" };
  }
  if (options.authorizedIssuers && !options.authorizedIssuers.includes(aggregate.issuer)) {
    return { valid: false, error: "provider aggregate issuer is not authorized" };
  }

  let keypair: Keypair;
  try {
    keypair = Keypair.fromPublicKey(aggregate.issuer);
  } catch {
    return { valid: false, error: "provider aggregate issuer is not a valid Stellar public key" };
  }
  let signature: Buffer;
  try {
    signature = Buffer.from(aggregate.signature, "base64");
  } catch {
    return { valid: false, error: "provider aggregate signature is not base64" };
  }
  if (signature.length !== 64 || !keypair.verify(Buffer.from(canonicalizeJson(unsigned), "utf8"), signature)) {
    return { valid: false, error: "provider aggregate signature is invalid" };
  }

  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const maxAge = options.maxAgeSeconds ?? 3600;
  const futureSkew = options.futureSkewSeconds ?? 30;
  if (aggregate.retrievedAt > now + futureSkew) {
    return { valid: false, error: "provider aggregate timestamp is in the future" };
  }
  if (now - aggregate.retrievedAt > maxAge) {
    return { valid: false, error: "provider aggregate is stale" };
  }
  return { valid: true };
}

export class ProviderAggregateClient {
  private readonly options: Required<ProviderAggregateClientOptions>;
  private readonly cache = new Map<string, AggregateCacheEntry>();

  constructor(options: ProviderAggregateClientOptions) {
    if (!options.indexerUrl) throw new Error("indexerUrl is required for provider aggregate retrieval");
    this.options = {
      indexerUrl: options.indexerUrl.replace(/\/+$/, ""),
      maxAgeSeconds: options.maxAgeSeconds ?? 3600,
      cacheTtlMs: options.cacheTtlMs ?? 60_000,
      maxStaleMs: options.maxStaleMs ?? 15 * 60_000,
      timeoutMs: options.timeoutMs ?? 5_000,
      backoffBaseMs: options.backoffBaseMs ?? 1_000,
      fetchImpl: options.fetchImpl ?? fetch,
      now: options.now ?? (() => Date.now()),
    };
  }

  async get(endpoint: string, payTo?: string): Promise<AggregateLookup> {
    const url = new URL("/v1/provider", this.options.indexerUrl);
    url.searchParams.set("endpoint", endpoint);
    if (payTo) url.searchParams.set("payTo", payTo);
    const key = `${endpoint}|${payTo || ""}`;
    const cached = this.cache.get(key);
    const now = this.options.now();

    if (cached && now - cached.cachedAt <= this.options.cacheTtlMs) {
      return { status: "cached", aggregate: cached.aggregate, stale: false };
    }
    if (cached && now < cached.retryAt) {
      return this.cachedOrUnavailable(cached, now, "aggregate lookup is in backoff");
    }

    if (url.protocol !== "https:") {
      return this.cachedOrUnavailable(cached, now, "provider aggregate retrieval requires HTTPS");
    }

    try {
      const response = await this.options.fetchImpl(url, {
        signal: AbortSignal.timeout(this.options.timeoutMs),
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`aggregate endpoint returned HTTP ${response.status}`);
      const responseBody = (await response.json()) as unknown;
      if (isInsufficientDataAggregate(responseBody, endpoint, payTo)) {
        return { status: "fresh", state: "insufficient_data", stale: false };
      }
      const aggregate = responseBody as ProviderAggregate;
      const validation = verifyProviderAggregate(aggregate, {
        expectedEndpoint: endpoint,
        expectedPayTo: payTo,
        maxAgeSeconds: this.options.maxAgeSeconds,
        nowSeconds: Math.floor(now / 1000),
      });
      if (!validation.valid) {
        if (cached) return { status: "invalid", aggregate: cached.aggregate, stale: true, error: validation.error };
        return { status: "invalid", stale: true, error: validation.error };
      }
      this.cache.set(key, { aggregate, cachedAt: now, failures: 0, retryAt: 0 });
      return { status: "fresh", aggregate, stale: false };
    } catch (error) {
      const failures = (cached?.failures ?? 0) + 1;
      const retryAt = now + Math.min(60_000, this.options.backoffBaseMs * 2 ** Math.min(failures - 1, 6));
      if (cached) {
        cached.failures = failures;
        cached.retryAt = retryAt;
        return this.cachedOrUnavailable(cached, now, error instanceof Error ? error.message : String(error));
      }
      return { status: "unavailable", stale: true, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private cachedOrUnavailable(entry: AggregateCacheEntry | undefined, now: number, error: string): AggregateLookup {
    if (entry && now - entry.cachedAt <= this.options.maxStaleMs) {
      return { status: "cached", aggregate: entry.aggregate, stale: true, error };
    }
    return { status: "unavailable", stale: true, error };
  }
}

export class SellerPolicyEngine {
  private readonly config: SellerPolicyConfig;
  private readonly disagreements = new Map<string, number>();

  constructor(config: Partial<SellerPolicyConfig> = {}) {
    this.config = { ...DEFAULT_SELLER_POLICY, ...config };
    if (config.maxFaultRateUpperBound !== undefined && config.holdMax === undefined) {
      this.config.holdMax = config.maxFaultRateUpperBound;
    }
    if (
      this.config.warnMax < 0 ||
      this.config.holdMax > 1 ||
      this.config.warnMax > this.config.holdMax
    ) {
      throw new Error("seller policy requires 0 <= warnMax <= holdMax <= 1");
    }
  }

  evaluate(endpoint: string, lookup: AggregateLookup): SellerPolicyDecision {
    if (lookup.state === "insufficient_data") {
      const action = this.config.insufficientData;
      return {
        action: normalizePolicyAction(action),
        reason: `${lookup.state}: no provider observations are available for ${endpoint}`,
        warning: isWarningAction(action) ? "provider quality evidence is not sufficient for an unconditional sale" : undefined,
      };
    }
    if (!lookup.aggregate) {
      return this.decisionForUnavailable(lookup.error || "no valid provider aggregate");
    }
    if (lookup.status === "invalid") {
      return this.decisionFor("invalidAggregate", "provider aggregate signature or binding is invalid");
    }
    if (lookup.stale) {
      return this.decisionFor("staleAggregate", "provider aggregate is outside its fresh cache window");
    }

    const aggregate = lookup.aggregate;
    const action = aggregate.state === "insufficient_data"
      ? normalizePolicyAction(this.config.insufficientData)
      : aggregate.state === "provisional"
        ? normalizePolicyAction(this.config.provisional)
        : aggregate.faultRateUpperBound > this.config.holdMax
          ? "hold"
          : aggregate.faultRateUpperBound >= this.config.warnMax
            ? "sell-and-warn"
            : "sell";
    return {
      action,
      reason: `${aggregate.state}: faultRateUpperBound=${aggregate.faultRateUpperBound.toFixed(4)}, n=${aggregate.n}`,
      warning: action === "sell-and-warn" ? "provider quality evidence is not sufficient for an unconditional sale" : undefined,
    };
  }

  recordDisagreement(endpoint: string, outcome: Pick<ProviderOutcome, "usable" | "providerAtFault" | "attributable">): { count: number; escalated: boolean } {
    if (outcome.usable || !outcome.providerAtFault || outcome.attributable !== "provider") {
      return { count: 0, escalated: false };
    }
    const count = (this.disagreements.get(endpoint) ?? 0) + 1;
    this.disagreements.set(endpoint, count);
    return { count, escalated: count >= this.config.repeatedDisagreementThreshold };
  }

  private decisionForUnavailable(reason: string): SellerPolicyDecision {
    return this.decisionFor("unavailableIndexer", reason);
  }

  private decisionFor(key: "staleAggregate" | "invalidAggregate" | "unavailableIndexer", reason: string): SellerPolicyDecision {
    const action = this.config[key];
    return {
      action: action === "preserve" ? "sell" : normalizePolicyAction(action),
      reason,
      warning: action === "preserve" || action === "warn" ? reason : undefined,
    };
  }
}

function normalizePolicyAction(action: "sell" | "sell-and-warn" | "warn" | "hold" | "stop"): SellerPolicyDecision["action"] {
  if (action === "warn" || action === "sell-and-warn") return "sell-and-warn";
  if (action === "stop") return "hold";
  return action;
}

function isWarningAction(action: "sell" | "sell-and-warn" | "warn" | "hold" | "stop"): boolean {
  return action === "warn" || action === "sell-and-warn";
}

export function wilsonUpperBound(faultsObserved: number, n: number, confidenceZ = 1.959963984540054): number {
  if (!Number.isInteger(faultsObserved) || !Number.isInteger(n) || n < 0 || faultsObserved < 0 || faultsObserved > n) {
    throw new Error("faultsObserved must be an integer between zero and n");
  }
  if (n === 0) return 1;
  const phat = faultsObserved / n;
  const z2 = confidenceZ ** 2;
  const denominator = 1 + z2 / n;
  const centre = phat + z2 / (2 * n);
  const spread = confidenceZ * Math.sqrt((phat * (1 - phat) / n) + z2 / (4 * n ** 2));
  return Math.min(1, (centre + spread) / denominator);
}

function validateUnsignedAggregate(aggregate: ProviderAggregateUnsigned): ProviderAggregateValidation {
  if (aggregate.v !== "veridex/provider-aggregate/1") return { valid: false, error: "unsupported provider aggregate version" };
  try {
    const url = new URL(aggregate.endpoint);
    if (url.protocol !== "http:" && url.protocol !== "https:") return { valid: false, error: "aggregate endpoint must use HTTP or HTTPS" };
  } catch {
    return { valid: false, error: "aggregate endpoint is not a valid URL" };
  }
  if (!Number.isFinite(aggregate.faultRateUpperBound) || aggregate.faultRateUpperBound < 0 || aggregate.faultRateUpperBound > 1) return { valid: false, error: "aggregate upper bound must be between 0 and 1" };
  if (!Number.isInteger(aggregate.n) || aggregate.n < 0 || !Number.isInteger(aggregate.faultsObserved) || aggregate.faultsObserved < 0 || aggregate.faultsObserved > aggregate.n) return { valid: false, error: "aggregate counts are invalid" };
  if (!Number.isInteger(aggregate.retrievedAt) || aggregate.retrievedAt <= 0 || !aggregate.window) return { valid: false, error: "aggregate timestamp and window are required" };
  return { valid: true };
}

function isInsufficientDataAggregate(
  value: unknown,
  endpoint: string,
  payTo?: string,
): value is ProviderAggregateInsufficientData {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ProviderAggregateInsufficientData>;
  return candidate.v === "veridex/provider-aggregate/1" &&
    candidate.endpoint === endpoint &&
    (payTo === undefined || candidate.payTo === payTo) &&
    candidate.state === "insufficient_data" &&
    candidate.faultRateUpperBound === 1 &&
    candidate.faultsObserved === 0 &&
    candidate.n === 0 &&
    typeof candidate.window === "string" &&
    typeof candidate.retrievedAt === "number" &&
    Number.isInteger(candidate.retrievedAt) &&
    candidate.retrievedAt > 0;
}
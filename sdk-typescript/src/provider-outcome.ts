/**
 * Signed provider outcomes for response-aware x402 sellers.
 * License: Apache-2.0
 */

import { createHash } from "node:crypto";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

export const PROVIDER_OUTCOME_VERSION = "veridex/provider-outcome/1" as const;
export const PROVIDER_OUTCOME_HEADER = "X-Veridex-Provider-Outcome";

export type ProviderAttribution = "provider" | "caller" | "unknown";

export interface ProviderOutcomeUnsigned {
  v: typeof PROVIDER_OUTCOME_VERSION;
  resource: string;
  payTo: string;
  requestDigest: string;
  responseDigest: string;
  observedAt: number;
  usable: boolean;
  providerAtFault: boolean;
  attributable: ProviderAttribution;
  reasonCode: string;
  /** Atomic units used by a metered resource. Required for `upto` settlement. */
  usageAtomic?: string;
  responseStatus?: number;
  toolName?: string;
  route?: string;
  callId?: string;
  settlementTx?: string;
}

export interface ProviderOutcome extends ProviderOutcomeUnsigned {
  signer: string;
  signature: string;
}

export interface ProviderOutcomeValidationOptions {
  nowSeconds?: number;
  maxAgeSeconds?: number;
  futureSkewSeconds?: number;
  expectedResource?: string;
  expectedPayTo?: string;
  expectedSigner?: string;
  replayGuard?: ProviderOutcomeReplayGuard;
}

export interface ProviderOutcomeValidation {
  valid: boolean;
  error?: string;
}

export class ProviderOutcomeReplayGuard {
  private readonly seen = new Set<string>();

  has(outcome: Pick<ProviderOutcome, "signer" | "callId" | "signature">): boolean {
    return this.seen.has(replayKey(outcome));
  }

  add(outcome: Pick<ProviderOutcome, "signer" | "callId" | "signature">): void {
    this.seen.add(replayKey(outcome));
  }
}

export function computeSha256Digest(value: unknown): string {
  const bytes = typeof value === "string" ? value : canonicalizeJson(value);
  return `sha256:${createHash("sha256").update(bytes, "utf8").digest("hex")}`;
}

export function canonicalProviderOutcome(outcome: ProviderOutcomeUnsigned): string {
  return canonicalizeJson(outcome);
}

export function encodeProviderOutcomeHeader(outcome: ProviderOutcome): string {
  return Buffer.from(JSON.stringify(outcome), "utf8").toString("base64");
}

export function decodeProviderOutcomeHeader(value: string): ProviderOutcome {
  let parsed: unknown;
  try {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 === 1) {
      throw new Error("invalid base64");
    }
    parsed = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    throw new Error("provider outcome header is not valid base64 JSON");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("provider outcome header must contain an object");
  }
  return parsed as ProviderOutcome;
}

export function createProviderOutcome(
  outcome: Omit<ProviderOutcomeUnsigned, "v">,
  signerSecretKey: string,
): ProviderOutcome {
  const keypair = Keypair.fromSecret(signerSecretKey);
  const unsigned: ProviderOutcomeUnsigned = {
    v: PROVIDER_OUTCOME_VERSION,
    resource: outcome.resource,
    payTo: outcome.payTo,
    requestDigest: outcome.requestDigest,
    responseDigest: outcome.responseDigest,
    observedAt: outcome.observedAt,
    usable: outcome.usable,
    providerAtFault: outcome.providerAtFault,
    attributable: outcome.attributable,
    reasonCode: outcome.reasonCode,
    ...(outcome.usageAtomic !== undefined && { usageAtomic: outcome.usageAtomic }),
    ...(outcome.responseStatus !== undefined && { responseStatus: outcome.responseStatus }),
    ...(outcome.toolName !== undefined && { toolName: outcome.toolName }),
    ...(outcome.route !== undefined && { route: outcome.route }),
    ...(outcome.callId !== undefined && { callId: outcome.callId }),
    ...(outcome.settlementTx !== undefined && { settlementTx: outcome.settlementTx }),
  };
  const validation = validateUnsignedOutcome(unsigned);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const signature = keypair
    .sign(Buffer.from(canonicalProviderOutcome(unsigned), "utf8"))
    .toString("base64");

  return { ...unsigned, signer: keypair.publicKey(), signature };
}

export function verifyProviderOutcome(
  outcome: ProviderOutcome,
  options: ProviderOutcomeValidationOptions = {},
): ProviderOutcomeValidation {
  const unsigned: ProviderOutcomeUnsigned = {
    v: outcome.v,
    resource: outcome.resource,
    payTo: outcome.payTo,
    requestDigest: outcome.requestDigest,
    responseDigest: outcome.responseDigest,
    observedAt: outcome.observedAt,
    usable: outcome.usable,
    providerAtFault: outcome.providerAtFault,
    attributable: outcome.attributable,
    reasonCode: outcome.reasonCode,
    ...(outcome.usageAtomic !== undefined && { usageAtomic: outcome.usageAtomic }),
    ...(outcome.responseStatus !== undefined && { responseStatus: outcome.responseStatus }),
    ...(outcome.toolName !== undefined && { toolName: outcome.toolName }),
    ...(outcome.route !== undefined && { route: outcome.route }),
    ...(outcome.callId !== undefined && { callId: outcome.callId }),
    ...(outcome.settlementTx !== undefined && { settlementTx: outcome.settlementTx }),
  };
  const validation = validateUnsignedOutcome(unsigned);
  if (!validation.valid) return validation;

  if (typeof outcome.signer !== "string" || typeof outcome.signature !== "string") {
    return { valid: false, error: "provider outcome signer and signature are required" };
  }
  if (options.expectedResource && outcome.resource !== options.expectedResource) {
    return { valid: false, error: "provider outcome resource does not match the request" };
  }
  if (options.expectedPayTo && outcome.payTo !== options.expectedPayTo) {
    return { valid: false, error: "provider outcome payTo does not match the payment" };
  }
  if (options.expectedSigner && outcome.signer !== options.expectedSigner) {
    return { valid: false, error: "provider outcome signer is not authorized for this resource" };
  }

  let keypair: Keypair;
  try {
    keypair = Keypair.fromPublicKey(outcome.signer);
    if (!StrKey.isValidEd25519PublicKey(outcome.payTo) && !StrKey.isValidContract(outcome.payTo)) {
      return { valid: false, error: "provider outcome payTo is not a valid Stellar public key" };
    }
  } catch {
    return { valid: false, error: "provider outcome signer or payTo is not a valid Stellar public key" };
  }

  let signature: Buffer;
  try {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(outcome.signature) || outcome.signature.length % 4 === 1) {
      throw new Error("invalid base64");
    }
    signature = Buffer.from(outcome.signature, "base64");
  } catch {
    return { valid: false, error: "provider outcome signature is not base64" };
  }
  if (signature.length !== 64 || !keypair.verify(Buffer.from(canonicalProviderOutcome(unsigned), "utf8"), signature)) {
    return { valid: false, error: "provider outcome signature is invalid" };
  }

  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const maxAge = options.maxAgeSeconds ?? 300;
  const futureSkew = options.futureSkewSeconds ?? 30;
  if (outcome.observedAt > now + futureSkew) {
    return { valid: false, error: "provider outcome timestamp is in the future" };
  }
  if (now - outcome.observedAt > maxAge) {
    return { valid: false, error: "provider outcome is stale" };
  }

  if (options.replayGuard) {
    if (options.replayGuard.has(outcome)) {
      return { valid: false, error: "provider outcome has already been observed" };
    }
    options.replayGuard.add(outcome);
  }

  return { valid: true };
}

function validateUnsignedOutcome(outcome: ProviderOutcomeUnsigned): ProviderOutcomeValidation {
  if (outcome.v !== PROVIDER_OUTCOME_VERSION) return { valid: false, error: "unsupported provider outcome version" };
  try {
    const url = new URL(outcome.resource);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { valid: false, error: "provider outcome resource must use HTTP or HTTPS" };
    }
  } catch {
    return { valid: false, error: "provider outcome resource is not a valid URL" };
  }
  if (!/^sha256:[0-9a-f]{64}$/i.test(outcome.requestDigest) || !/^sha256:[0-9a-f]{64}$/i.test(outcome.responseDigest)) {
    return { valid: false, error: "provider outcome digests must be sha256 hex digests" };
  }
  if (!Number.isInteger(outcome.observedAt) || outcome.observedAt <= 0) {
    return { valid: false, error: "provider outcome observedAt must be a positive epoch-second integer" };
  }
  if (typeof outcome.payTo !== "string" || typeof outcome.reasonCode !== "string" || outcome.reasonCode.length === 0) {
    return { valid: false, error: "provider outcome payTo and reasonCode are required" };
  }
  if (outcome.providerAtFault && outcome.attributable !== "provider") {
    return { valid: false, error: "providerAtFault requires provider attribution" };
  }
  if (!outcome.providerAtFault && outcome.attributable === "provider") {
    return { valid: false, error: "provider attribution requires providerAtFault" };
  }
  if (outcome.usable && outcome.providerAtFault) {
    return { valid: false, error: "a usable outcome cannot attribute a fault to the provider" };
  }
  if (!/^[a-z][a-z0-9_.-]{1,63}$/.test(outcome.reasonCode)) {
    return { valid: false, error: "provider outcome reasonCode is invalid" };
  }
  if (outcome.usageAtomic !== undefined && !/^(0|[1-9][0-9]*)$/.test(outcome.usageAtomic)) {
    return { valid: false, error: "provider outcome usageAtomic must be a non-negative integer string" };
  }
  if (outcome.responseStatus !== undefined && (!Number.isInteger(outcome.responseStatus) || outcome.responseStatus < 100 || outcome.responseStatus > 599)) {
    return { valid: false, error: "provider outcome responseStatus is invalid" };
  }
  for (const [name, value] of Object.entries({
    toolName: outcome.toolName,
    route: outcome.route,
    callId: outcome.callId,
  })) {
    if (value !== undefined && (value.length === 0 || value.length > 256)) {
      return { valid: false, error: `provider outcome ${name} has an invalid length` };
    }
  }
  if (outcome.settlementTx !== undefined && !/^[0-9a-f]{64}$/i.test(outcome.settlementTx)) {
    return { valid: false, error: "provider outcome settlementTx is not a Stellar transaction hash" };
  }
  return { valid: true };
}

function replayKey(outcome: Pick<ProviderOutcome, "signer" | "callId" | "signature">): string {
  return `${outcome.signer}:${outcome.callId || outcome.signature}`;
}

export function canonicalizeJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Cannot canonicalize a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => {
      if (item === undefined || typeof item === "function" || typeof item === "symbol") return "null";
      return canonicalizeJson(item);
    }).join(",")}]`;
  }
  if (typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .filter((key) => {
        const item = (value as Record<string, unknown>)[key];
        return item !== undefined && typeof item !== "function" && typeof item !== "symbol";
      })
      .map((key) => `${JSON.stringify(key)}:${canonicalizeJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Cannot canonicalize provider outcome value");
}
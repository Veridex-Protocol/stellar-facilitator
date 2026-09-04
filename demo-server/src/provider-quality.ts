/**
 * Reference seller integration for response-aware x402 settlement.
 * License: Apache-2.0
 */

import { createHash } from "node:crypto";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import type {
  ResourceServerExtension,
  SettleContext,
  SettleResultContext,
} from "@x402/core/types";

export const PROVIDER_OUTCOME_HEADER = "X-Veridex-Provider-Outcome";
export const PROVIDER_QUALITY_EXTENSION_KEY = "veridex-provider-quality";

type Attribution = "provider" | "caller" | "unknown";

interface ProviderOutcome {
  v: "veridex/provider-outcome/1";
  resource: string;
  payTo: string;
  requestDigest: string;
  responseDigest: string;
  observedAt: number;
  usable: boolean;
  providerAtFault: boolean;
  attributable: Attribution;
  reasonCode: string;
  responseStatus?: number;
  usageAtomic?: string;
  callId?: string;
  signer: string;
  signature: string;
}

export function digestBytes(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function digestJson(value: unknown): string {
  return digestBytes(canonicalize(value));
}

export function createProviderOutcome(params: {
  resource: string;
  payTo: string;
  requestDigest: string;
  responseDigest: string;
  observedAt: number;
  usable: boolean;
  providerAtFault: boolean;
  attributable: Attribution;
  reasonCode: string;
  responseStatus?: number;
  usageAtomic?: string;
  callId?: string;
  signerSecretKey: string;
}): ProviderOutcome {
  const keypair = Keypair.fromSecret(params.signerSecretKey);
  const unsigned = {
    v: "veridex/provider-outcome/1" as const,
    resource: params.resource,
    payTo: params.payTo,
    requestDigest: params.requestDigest,
    responseDigest: params.responseDigest,
    observedAt: params.observedAt,
    usable: params.usable,
    providerAtFault: params.providerAtFault,
    attributable: params.attributable,
    reasonCode: params.reasonCode,
    ...(params.responseStatus === undefined ? {} : { responseStatus: params.responseStatus }),
    ...(params.usageAtomic === undefined ? {} : { usageAtomic: params.usageAtomic }),
    ...(params.callId === undefined ? {} : { callId: params.callId }),
  };
  validateOutcome(unsigned, keypair.publicKey(), params.payTo);
  return {
    ...unsigned,
    signer: keypair.publicKey(),
    signature: keypair.sign(Buffer.from(canonicalize(unsigned), "utf8")).toString("base64"),
  };
}

export function encodeProviderOutcome(outcome: ProviderOutcome): string {
  return Buffer.from(JSON.stringify(outcome), "utf8").toString("base64");
}

export function createProviderQualityExtension(options: {
  requireOutcome?: boolean;
  maxAgeSeconds?: number;
  callerFailurePolicy?: "settle" | "skip";
  ambiguousFailurePolicy?: "settle" | "skip";
  expectedSigner?: string;
  onObservation?: (outcome: ProviderOutcome, context: SettleContext) => Promise<void> | void;
  onSettlement?: (outcome: ProviderOutcome, context: SettleResultContext) => Promise<void> | void;
} = {}): ResourceServerExtension {
  return {
    key: PROVIDER_QUALITY_EXTENSION_KEY,
    hooks: {
      onBeforeSettle: async (_declaration, context) => {
        const outcome = readOutcome(context);
        if (!outcome) {
          return options.requireOutcome
            ? { abort: true as const, reason: "provider_outcome_missing", message: "Paid response did not include a provider outcome." }
            : undefined;
        }

        const transport = context.transportContext as { responseBody?: Buffer } | undefined;
        const expectedResponseDigest = digestBytes(transport?.responseBody ?? Buffer.alloc(0));
        const expectedResource = context.paymentPayload.resource?.url;
        const expectedSigner = options.expectedSigner ?? context.requirements.payTo;
        const error = verifyOutcome(outcome, {
          expectedResource,
          expectedPayTo: context.requirements.payTo,
          expectedSigner,
          expectedResponseDigest,
          maxAgeSeconds: options.maxAgeSeconds ?? 300,
        });
        if (error) return { abort: true as const, reason: "provider_outcome_invalid", message: error };

        void Promise.resolve(options.onObservation?.(outcome, context)).catch(() => undefined);

        if (outcome.usable) return undefined;
        if (outcome.providerAtFault) {
          return { abort: true as const, reason: `provider_unusable:${outcome.reasonCode}`, message: "Provider-attributed unusable response was not settled." };
        }
        const policy = outcome.attributable === "caller"
          ? options.callerFailurePolicy ?? "skip"
          : options.ambiguousFailurePolicy ?? "skip";
        return policy === "settle"
          ? undefined
          : { abort: true as const, reason: `${outcome.attributable}_policy_skip:${outcome.reasonCode}`, message: "Seller policy did not authorize settlement." };
      },
      onAfterSettle: async (_declaration, context) => {
        const outcome = readOutcome(context);
        if (!outcome || !context.result.success || !context.result.transaction) return;
        void Promise.resolve(options.onSettlement?.(outcome, context)).catch(() => undefined);
      },
    },
  };
}

function readOutcome(context: SettleContext): ProviderOutcome | undefined {
  const transport = context.transportContext as { responseHeaders?: Record<string, string> } | undefined;
  const raw = Object.entries(transport?.responseHeaders ?? {})
    .find(([name]) => name.toLowerCase() === PROVIDER_OUTCOME_HEADER.toLowerCase())?.[1];
  if (!raw) return undefined;
  try {
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw) || raw.length % 4 === 1) throw new Error("invalid base64");
    const value = JSON.parse(decoded) as ProviderOutcome;
    if (!value || typeof value !== "object") throw new Error("outcome must be an object");
    return value;
  } catch (error) {
    throw new Error(`provider outcome header is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function verifyOutcome(
  outcome: ProviderOutcome,
  expected: {
    expectedResource?: string;
    expectedPayTo: string;
    expectedSigner: string;
    expectedResponseDigest: string;
    maxAgeSeconds: number;
  },
): string | undefined {
  try {
    validateOutcome(outcome, outcome.signer, expected.expectedPayTo);
    if (expected.expectedResource && outcome.resource !== expected.expectedResource) return "outcome resource does not match the request";
    if (outcome.payTo !== expected.expectedPayTo) return "outcome payTo does not match the payment";
    if (outcome.signer !== expected.expectedSigner) return "outcome signer is not authorized";
    if (outcome.responseDigest !== expected.expectedResponseDigest) return "outcome responseDigest does not match the returned bytes";
    const now = Math.floor(Date.now() / 1000);
    if (outcome.observedAt > now + 30) return "outcome is future-dated";
    if (now - outcome.observedAt > expected.maxAgeSeconds) return "outcome is stale";
    const unsigned = withoutSignature(outcome);
    const keypair = Keypair.fromPublicKey(outcome.signer);
    const signature = Buffer.from(outcome.signature, "base64");
    if (signature.length !== 64 || !keypair.verify(Buffer.from(canonicalize(unsigned), "utf8"), signature)) return "outcome signature is invalid";
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function validateOutcome(
  outcome: Omit<ProviderOutcome, "signer" | "signature"> | ProviderOutcome,
  signer: string,
  payTo: string,
): void {
  if (outcome.v !== "veridex/provider-outcome/1") throw new Error("unsupported provider outcome version");
  if (!/^https?:\/\//.test(outcome.resource)) throw new Error("outcome resource must be HTTP or HTTPS");
  if (!/^sha256:[0-9a-f]{64}$/i.test(outcome.requestDigest) || !/^sha256:[0-9a-f]{64}$/i.test(outcome.responseDigest)) throw new Error("outcome digests are invalid");
  if (!Number.isInteger(outcome.observedAt) || outcome.observedAt <= 0) throw new Error("outcome observedAt is invalid");
  if (outcome.providerAtFault !== (outcome.attributable === "provider")) throw new Error("outcome attribution is inconsistent");
  if (outcome.usable && outcome.providerAtFault) throw new Error("usable outcome cannot report provider fault");
  if (!StrKey.isValidEd25519PublicKey(signer)) throw new Error("outcome signer is not a Stellar public key");
  if (!StrKey.isValidEd25519PublicKey(payTo) && !StrKey.isValidContract(payTo)) throw new Error("outcome payTo is not a Stellar address");
  if (outcome.usageAtomic !== undefined && !/^(0|[1-9][0-9]*)$/.test(outcome.usageAtomic)) throw new Error("outcome usageAtomic is invalid");
}

function withoutSignature(outcome: ProviderOutcome): Omit<ProviderOutcome, "signer" | "signature"> {
  const { signer: _signer, signature: _signature, ...unsigned } = outcome;
  return unsigned;
}

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  throw new TypeError("unsupported canonical value");
}
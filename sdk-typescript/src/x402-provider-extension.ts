/**
 * x402 resource-server integration for response-aware provider outcomes.
 * License: Apache-2.0
 */

import type {
  ResourceServerExtension,
  SchemeNetworkServer,
  SettleContext,
  SettleResultContext,
} from "@x402/core/types";
import {
  decodeProviderOutcomeHeader,
  encodeProviderOutcomeHeader,
  PROVIDER_OUTCOME_HEADER,
  verifyProviderOutcome,
  type ProviderOutcome,
  type ProviderOutcomeValidationOptions,
} from "./provider-outcome.js";

export const PROVIDER_QUALITY_EXTENSION_KEY = "veridex-provider-quality";
export const SETTLEMENT_OVERRIDES_HEADER = "Settlement-Overrides";

export interface ProviderQualityDeclaration {
  requireOutcome?: boolean;
  maxAgeSeconds?: number;
  callerFailurePolicy?: "settle" | "skip";
  ambiguousFailurePolicy?: "settle" | "skip";
  expectedSigner?: string;
}

export interface ProviderQualityExtensionOptions {
  key?: string;
  requireOutcome?: boolean;
  maxAgeSeconds?: number;
  callerFailurePolicy?: "settle" | "skip";
  ambiguousFailurePolicy?: "settle" | "skip";
  expectedSigner?: string | ((payTo: string) => string | undefined);
  replayGuard?: ProviderOutcomeValidationOptions["replayGuard"];
  nowSeconds?: number;
  onObservation?: (outcome: ProviderOutcome, context: SettleContext) => Promise<void> | void;
  onSettlement?: (outcome: ProviderOutcome, context: SettleResultContext) => Promise<void> | void;
}

/**
 * Creates an x402 resource-server extension. The extension runs after the
 * resource handler has returned, so it can make a charge decision from the
 * provider response without putting an indexer in the payment path.
 */
export function createProviderQualityExtension(
  options: ProviderQualityExtensionOptions = {},
): ResourceServerExtension {
  const key = options.key ?? PROVIDER_QUALITY_EXTENSION_KEY;

  return {
    key,
    hooks: {
      onBeforeSettle: async (declaration, context) => {
        const config = mergeDeclaration(options, declaration);
        let outcome: ProviderOutcome | undefined;
        try {
          outcome = readOutcome(context);
        } catch (error) {
          return {
            abort: true as const,
            reason: "provider_outcome_invalid",
            message: error instanceof Error ? error.message : String(error),
          };
        }

        if (!outcome) {
          return config.requireOutcome
            ? {
                abort: true as const,
                reason: "provider_outcome_missing",
                message: "The paid response did not include a signed provider outcome.",
              }
            : undefined;
        }

        const payTo = context.requirements.payTo;
        const expectedResource = context.paymentPayload.resource?.url;
        const expectedSigner = typeof options.expectedSigner === "function"
          ? options.expectedSigner(payTo)
          : config.expectedSigner;
        const validation = verifyProviderOutcome(outcome, {
          expectedPayTo: payTo,
          expectedResource,
          expectedSigner,
          maxAgeSeconds: config.maxAgeSeconds,
          nowSeconds: options.nowSeconds,
          replayGuard: options.replayGuard,
        });

        if (!validation.valid) {
          return {
            abort: true as const,
            reason: "provider_outcome_invalid",
            message: validation.error,
          };
        }

        if (context.requirements.scheme === "upto") {
          if (outcome.usageAtomic === undefined) {
            return {
              abort: true as const,
              reason: "upto_usage_missing",
              message: "An upto settlement requires signed response usage in atomic units.",
            };
          }
          if (BigInt(outcome.usageAtomic) > BigInt(context.requirements.amount)) {
            return {
              abort: true as const,
              reason: "upto_usage_exceeds_maximum",
              message: "Signed response usage exceeds the authorized upto maximum.",
            };
          }
        }

        void Promise.resolve(options.onObservation?.(outcome, context)).catch(() => undefined);

        if (outcome.usable || (outcome.attributable === "caller"
          ? config.callerFailurePolicy === "settle"
          : config.ambiguousFailurePolicy === "settle")) {
          return undefined;
        }

        if (outcome.providerAtFault) {
          return {
            abort: true as const,
            reason: `provider_unusable:${outcome.reasonCode}`,
            message: "Provider-attributed unusable responses are not settled.",
          };
        }

        return {
          abort: true as const,
          reason: outcome.attributable === "caller"
            ? `caller_policy_skip:${outcome.reasonCode}`
            : `ambiguous_policy_skip:${outcome.reasonCode}`,
          message: "The configured seller policy did not authorize settlement.",
        };
      },
      onAfterSettle: async (_declaration, context) => {
        let outcome: ProviderOutcome | undefined;
        try {
          outcome = readOutcome(context);
        } catch {
          return;
        }
        if (!outcome) return;
        void Promise.resolve(options.onSettlement?.(outcome, context)).catch(() => undefined);
      },
    },
  };
}

/**
 * Installs response-digest enrichment on a seller-side scheme. The core x402
 * server merges this into the signed settlement payload immediately before it
 * calls the facilitator. The facilitator's `upto` implementation uses it for
 * the on-chain result digest.
 */
export function installProviderOutcomeSettlementEnrichment<T extends SchemeNetworkServer>(
  scheme: T,
  options: Pick<ProviderQualityExtensionOptions, "nowSeconds"> = {},
): T {
  const original = scheme.enrichSettlementPayload?.bind(scheme);
  scheme.enrichSettlementPayload = async (context) => {
    const existing = (await original?.(context)) ?? {};
    const outcome = readOutcome(context);
    if (!outcome) return existing;

    const validation = verifyProviderOutcome(outcome, {
      expectedPayTo: context.requirements.payTo,
      expectedResource: context.paymentPayload.resource?.url,
      nowSeconds: options.nowSeconds,
    });
    if (!validation.valid) throw new Error(validation.error);

    return {
      ...existing,
      resultDigest: outcome.responseDigest,
    };
  };
  return scheme;
}

/**
 * Applies the response headers a seller must expose before x402 runs its
 * post-handler settlement step.
 */
export function applyProviderOutcomeHeaders(
  outcome: ProviderOutcome,
  setHeader: (name: string, value: string) => void,
  scheme?: string,
): void {
  setHeader(PROVIDER_OUTCOME_HEADER, encodeProviderOutcomeHeader(outcome));
  if (scheme === "upto" && outcome.usageAtomic !== undefined) {
    setHeader(SETTLEMENT_OVERRIDES_HEADER, JSON.stringify({ amount: outcome.usageAtomic }));
  }
}

function readOutcome(context: SettleContext): ProviderOutcome | undefined {
  const transport = context.transportContext as {
    responseHeaders?: Record<string, string>;
  } | undefined;
  const headers = transport?.responseHeaders;
  if (!headers) return undefined;
  const raw = Object.entries(headers).find(([name]) => name.toLowerCase() === PROVIDER_OUTCOME_HEADER.toLowerCase())?.[1];
  if (!raw) return undefined;
  return decodeProviderOutcomeHeader(raw);
}

function mergeDeclaration(
  options: ProviderQualityExtensionOptions,
  declaration: unknown,
): Required<Pick<ProviderQualityDeclaration, "requireOutcome" | "maxAgeSeconds" | "callerFailurePolicy" | "ambiguousFailurePolicy">> & Pick<ProviderQualityDeclaration, "expectedSigner"> {
  const declared = declaration && typeof declaration === "object"
    ? declaration as ProviderQualityDeclaration
    : {};
  return {
    requireOutcome: declared.requireOutcome ?? options.requireOutcome ?? false,
    maxAgeSeconds: declared.maxAgeSeconds ?? options.maxAgeSeconds ?? 300,
    callerFailurePolicy: declared.callerFailurePolicy ?? options.callerFailurePolicy ?? "skip",
    ambiguousFailurePolicy: declared.ambiguousFailurePolicy ?? options.ambiguousFailurePolicy ?? "skip",
    expectedSigner: declared.expectedSigner ?? (typeof options.expectedSigner === "string" ? options.expectedSigner : undefined),
  };
}
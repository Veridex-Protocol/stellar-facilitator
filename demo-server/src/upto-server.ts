/**
 * Reference seller-side Stellar `upto` scheme adapter.
 * License: Apache-2.0
 */

import { digestJson, PROVIDER_OUTCOME_HEADER } from "./provider-quality.js";
import type {
  AssetAmount,
  Network,
  PaymentRequirements,
  SchemeNetworkServer,
  SchemePaymentRequiredContext,
  SettleContext,
} from "@x402/core/types";

const SETTLEMENT_OVERRIDES_HEADER = "Settlement-Overrides";

function readOutcome(context: SettleContext): { responseDigest: string } {
  const transport = context.transportContext as { responseHeaders?: Record<string, string> } | undefined;
  const raw = Object.entries(transport?.responseHeaders ?? {})
    .find(([name]) => name.toLowerCase() === PROVIDER_OUTCOME_HEADER.toLowerCase())?.[1];
  if (!raw) throw new Error("upto settlement requires a signed provider outcome");
  const outcome = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as {
    responseDigest?: string;
  };
  if (!outcome.responseDigest) throw new Error("upto settlement requires a response digest");
  return { responseDigest: outcome.responseDigest };
}

export class UptoStellarServerScheme implements SchemeNetworkServer {
  readonly scheme = "upto";

  async parsePrice(price: unknown, _network: Network): Promise<AssetAmount> {
    if (!price || typeof price !== "object") throw new Error("upto price must be an AssetAmount");
    const value = price as Partial<AssetAmount>;
    if (typeof value.asset !== "string" || typeof value.amount !== "string") {
      throw new Error("upto price must include asset and maximum amount");
    }
    return { asset: value.asset, amount: value.amount, extra: value.extra };
  }

  async enhancePaymentRequirements(
    requirements: PaymentRequirements,
    supportedKind: { extra?: Record<string, unknown> },
  ): Promise<PaymentRequirements> {
    return { ...requirements, extra: { ...requirements.extra, ...supportedKind.extra } };
  }

  async enrichPaymentRequiredResponse(context: SchemePaymentRequiredContext): Promise<PaymentRequirements[]> {
    const transport = context.transportContext as {
      request?: { method?: string; url?: string };
    } | undefined;
    const requestDigest = digestJson({
      method: transport?.request?.method ?? "GET",
      url: transport?.request?.url ?? context.resourceInfo.url,
    });
    return context.requirements.map((requirements) => requirements.scheme === "upto"
      ? { ...requirements, extra: { ...requirements.extra, requestDigest } }
      : requirements);
  }

  async enrichSettlementPayload(context: SettleContext): Promise<Record<string, unknown>> {
    return { resultDigest: readOutcome(context).responseDigest };
  }
}

export function applyUptoSettlementHeaders(
  setHeader: (name: string, value: string) => void,
  usageAtomic: string,
): void {
  setHeader(SETTLEMENT_OVERRIDES_HEADER, JSON.stringify({ amount: usageAtomic }));
}

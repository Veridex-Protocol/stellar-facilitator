import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import type { SettleContext } from "@x402/core/server";
import {
  applyProviderOutcomeHeaders,
  createProviderQualityExtension,
  installProviderOutcomeSettlementEnrichment,
} from "../x402-provider-extension.js";
import {
  computeSha256Digest,
  createProviderOutcome,
  PROVIDER_OUTCOME_HEADER,
} from "../provider-outcome.js";

function makeContext(outcomeHeader: string, scheme = "exact"): SettleContext {
  return {
    paymentPayload: {
      x402Version: 2,
      resource: { url: "https://provider.example/fx" },
      accepted: {
        scheme,
        network: "stellar:testnet",
        asset: "CC7AMNLQWIEKWMSGKXC7DFEXHDTNMQ6JL2BBPRBM6RQXYZXCNKD75CVB",
        amount: "1000",
        payTo: signer.publicKey(),
        maxTimeoutSeconds: 60,
        extra: {},
      },
      payload: {},
    },
    requirements: {
      scheme,
      network: "stellar:testnet",
      asset: "CC7AMNLQWIEKWMSGKXC7DFEXHDTNMQ6JL2BBPRBM6RQXYZXCNKD75CVB",
      amount: "1000",
      payTo: signer.publicKey(),
      maxTimeoutSeconds: 60,
      extra: {},
    },
    declaredExtensions: {},
    phase: "after-handler",
    transportContext: { responseHeaders: { [PROVIDER_OUTCOME_HEADER]: outcomeHeader } },
  } as SettleContext;
}

const signer = Keypair.random();
const signedOutcome = createProviderOutcome({
  resource: "https://provider.example/fx",
  payTo: signer.publicKey(),
  requestDigest: computeSha256Digest({ pair: "XLM/USD" }),
  responseDigest: computeSha256Digest({ value: "0.12" }),
  observedAt: 1_700_000_000,
  usable: true,
  providerAtFault: false,
  attributable: "unknown",
  reasonCode: "ok",
  usageAtomic: "250",
}, signer.secret());

describe("x402 provider-quality extension", () => {
  it("aborts provider-attributed exact settlement before the facilitator call", async () => {
    const outcome = createProviderOutcome({
      ...signedOutcome,
      usable: false,
      providerAtFault: true,
      attributable: "provider",
      reasonCode: "data_stale",
    }, signer.secret());
    const extension = createProviderQualityExtension({ requireOutcome: true, nowSeconds: 1_700_000_100 });
    const result = await extension.hooks!.onBeforeSettle!(
      {},
      makeContext(Buffer.from(JSON.stringify(outcome)).toString("base64")),
    );

    expect(result).toMatchObject({ abort: true, reason: "provider_unusable:data_stale" });
  });

  it("enriches an upto settlement with the real response digest", async () => {
    const scheme = {
      scheme: "upto",
      enrichSettlementPayload: async () => ({ existing: true }),
    } as any;
    installProviderOutcomeSettlementEnrichment(scheme, { nowSeconds: 1_700_000_100 });
    const context = makeContext(Buffer.from(JSON.stringify(signedOutcome)).toString("base64"), "upto");
    const enrichment = await scheme.enrichSettlementPayload(context);
    expect(enrichment).toEqual({ existing: true, resultDigest: signedOutcome.responseDigest });
  });

  it("writes a bounded upto override without involving an indexer", () => {
    const headers: Record<string, string> = {};
    applyProviderOutcomeHeaders(signedOutcome, (name, value) => { headers[name] = value; }, "upto");
    expect(JSON.parse(headers["Settlement-Overrides"])).toEqual({ amount: "250" });
  });

  it("rejects upto settlement when signed usage is missing or exceeds the ceiling", async () => {
    const extension = createProviderQualityExtension({
      requireOutcome: true,
      nowSeconds: 1_700_000_100,
    });
    const missingUsage = createProviderOutcome({
      resource: signedOutcome.resource,
      payTo: signedOutcome.payTo,
      requestDigest: signedOutcome.requestDigest,
      responseDigest: signedOutcome.responseDigest,
      observedAt: signedOutcome.observedAt,
      usable: signedOutcome.usable,
      providerAtFault: signedOutcome.providerAtFault,
      attributable: signedOutcome.attributable,
      reasonCode: signedOutcome.reasonCode,
    }, signer.secret());
    const missing = await extension.hooks!.onBeforeSettle!(
      {},
      makeContext(Buffer.from(JSON.stringify(missingUsage)).toString("base64"), "upto"),
    );
    expect(missing).toMatchObject({ abort: true, reason: "upto_usage_missing" });

    const tooMuch = createProviderOutcome({
      ...signedOutcome,
      usageAtomic: "1001",
    }, signer.secret());
    const over = await extension.hooks!.onBeforeSettle!(
      {},
      makeContext(Buffer.from(JSON.stringify(tooMuch)).toString("base64"), "upto"),
    );
    expect(over).toMatchObject({ abort: true, reason: "upto_usage_exceeds_maximum" });
  });
});
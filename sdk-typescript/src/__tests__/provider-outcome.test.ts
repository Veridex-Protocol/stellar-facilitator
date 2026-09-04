import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  ProviderOutcomeReplayGuard,
  computeSha256Digest,
  createProviderOutcome,
  verifyProviderOutcome,
} from "../provider-outcome.js";
import {
  ProviderAggregateClient,
  SellerPolicyEngine,
  createProviderAggregate,
  verifyProviderAggregate,
  wilsonUpperBound,
} from "../provider-quality.js";
import { executeResponseAware } from "../response-aware.js";

const resource = "https://provider.example/fx";
const payTo = Keypair.random();
const requestDigest = computeSha256Digest({ pair: "XLM/USD" });
const responseDigest = computeSha256Digest({ value: "0.12" });

function outcome(overrides: Record<string, unknown> = {}) {
  return createProviderOutcome(
    {
      resource,
      payTo: payTo.publicKey(),
      requestDigest,
      responseDigest,
      observedAt: 1_700_000_000,
      usable: true,
      providerAtFault: false,
      attributable: "unknown",
      reasonCode: "ok",
      usageAtomic: "0",
      callId: "call-1",
      ...overrides,
    },
    payTo.secret(),
  );
}

describe("signed provider outcomes", () => {
  it("binds the signature to resource, payee, and response facts", () => {
    const signed = outcome();
    expect(verifyProviderOutcome(signed, { nowSeconds: 1_700_000_100 })).toEqual({ valid: true });

    expect(
      verifyProviderOutcome({ ...signed, payTo: Keypair.random().publicKey() }, { nowSeconds: 1_700_000_100 }).valid,
    ).toBe(false);
    expect(
      verifyProviderOutcome({ ...signed, responseDigest: computeSha256Digest("different") }, { nowSeconds: 1_700_000_100 }).valid,
    ).toBe(false);
  });

  it("rejects stale, future, and replayed outcomes", () => {
    const guard = new ProviderOutcomeReplayGuard();
    const signed = outcome();
    expect(verifyProviderOutcome(signed, { nowSeconds: 1_700_000_100, replayGuard: guard }).valid).toBe(true);
    expect(verifyProviderOutcome(signed, { nowSeconds: 1_700_000_100, replayGuard: guard }).valid).toBe(false);
    expect(verifyProviderOutcome(signed, { nowSeconds: 1_700_001_000 }).valid).toBe(false);
    expect(verifyProviderOutcome(outcome({ observedAt: 1_700_000_500 }), { nowSeconds: 1_700_000_100 }).valid).toBe(false);
  });
});

describe("response-aware settlement", () => {
  it("settles a usable response", async () => {
    let settlements = 0;
    const result = await executeResponseAware({
      execute: async () => ({ result: { ok: true }, outcome: outcome() }),
      settle: async () => {
        settlements++;
        return "tx";
      },
      outcomeValidation: { nowSeconds: 1_700_000_100 },
    });

    expect(result).toMatchObject({ chargeDisposition: "settle", settled: true, settlement: "tx" });
    expect(settlements).toBe(1);
  });

  it("skips settlement for provider-attributed unusable responses", async () => {
    let settlements = 0;
    const result = await executeResponseAware({
      execute: async () => ({
        result: { stale: true },
        outcome: outcome({ usable: false, providerAtFault: true, attributable: "provider", reasonCode: "data_stale" }),
      }),
      settle: async () => {
        settlements++;
        return "must-not-run";
      },
      outcomeValidation: { nowSeconds: 1_700_000_100 },
    });

    expect(result).toMatchObject({ chargeDisposition: "skip", settled: false });
    expect(settlements).toBe(0);
  });

  it("uses explicit local policy for caller and ambiguous failures", async () => {
    let settlements = 0;
    const result = await executeResponseAware({
      execute: async () => ({
        result: { rejected: true },
        outcome: outcome({ usable: false, attributable: "caller", reasonCode: "invalid_input" }),
      }),
      settle: async () => {
        settlements++;
        return "tx";
      },
      callerFailurePolicy: "settle",
      outcomeValidation: { nowSeconds: 1_700_000_100 },
    });

    expect(result).toMatchObject({ chargeDisposition: "policy_decision", settled: true });
    expect(settlements).toBe(1);
  });

  it("does not consult aggregate reputation to trigger settlement", async () => {
    let settlements = 0;
    const result = await executeResponseAware({
      execute: async () => ({
        result: { stale: true },
        outcome: outcome({ usable: false, providerAtFault: false, attributable: "unknown", reasonCode: "unknown" }),
      }),
      settle: async () => {
        settlements++;
        return "must-not-run";
      },
      ambiguousFailurePolicy: "skip",
      outcomeValidation: { nowSeconds: 1_700_000_100 },
    });

    expect(result.settled).toBe(false);
    expect(settlements).toBe(0);
  });
});

describe("signed provider aggregates and seller policy", () => {
  it("signs and verifies aggregates with a configurable evidence state", () => {
    const aggregate = createProviderAggregate({
      endpoint: resource,
      payTo: payTo.publicKey(),
      state: "provisional",
      faultRateUpperBound: wilsonUpperBound(5, 34),
      faultsObserved: 5,
      n: 34,
      window: "30d",
      retrievedAt: 1_700_000_000,
    }, payTo.secret());

    expect(verifyProviderAggregate(aggregate, {
      expectedEndpoint: resource,
      expectedPayTo: payTo.publicKey(),
      nowSeconds: 1_700_000_100,
    })).toEqual({ valid: true });
    expect(verifyProviderAggregate({ ...aggregate, endpoint: "https://other.example" }, {
      expectedEndpoint: resource,
      nowSeconds: 1_700_000_100,
    }).valid).toBe(false);
  });

  it("keeps indexer outages out of the payment decision path", async () => {
    const client = new ProviderAggregateClient({
      indexerUrl: "https://indexer.example",
      fetchImpl: (async () => { throw new Error("offline"); }) as typeof fetch,
    });
    const lookup = await client.get(resource, payTo.publicKey());
    expect(lookup.status).toBe("unavailable");

    const decision = new SellerPolicyEngine().evaluate(resource, lookup);
    expect(decision.action).toBe("sell");
    expect(decision.warning).toContain("offline");
  });

  it("keeps insufficient data distinct from an invalid signed aggregate", async () => {
    const client = new ProviderAggregateClient({
      indexerUrl: "https://indexer.example",
      fetchImpl: (async () => new Response(JSON.stringify({
        v: "veridex/provider-aggregate/1",
        endpoint: resource,
        payTo: payTo.publicKey(),
        state: "insufficient_data",
        faultRateUpperBound: 1,
        faultsObserved: 0,
        n: 0,
        window: "30d",
        retrievedAt: 1_700_000_000,
      }))) as typeof fetch,
      now: () => 1_700_000_100_000,
    });
    const lookup = await client.get(resource, payTo.publicKey());
    expect(lookup).toMatchObject({ status: "fresh", state: "insufficient_data", stale: false });
    expect(lookup.aggregate).toBeUndefined();

    const decision = new SellerPolicyEngine({ insufficientData: "hold" }).evaluate(resource, lookup);
    expect(decision.action).toBe("hold");
  });

  it("holds a published aggregate above the configured policy ceiling", () => {
    const decision = new SellerPolicyEngine({ maxFaultRateUpperBound: 0.15 }).evaluate(resource, {
      status: "fresh",
      stale: false,
      aggregate: createProviderAggregate({
        endpoint: resource,
        payTo: payTo.publicKey(),
        state: "published",
        faultRateUpperBound: 0.2,
        faultsObserved: 20,
        n: 100,
        window: "30d",
        retrievedAt: 1_700_000_000,
      }, payTo.secret()),
    });
    expect(decision.action).toBe("stop");
  });

  it("preserves the last valid aggregate during a bounded indexer outage", async () => {
    let now = 1_700_000_000_000;
    const aggregate = createProviderAggregate({
      endpoint: resource,
      payTo: payTo.publicKey(),
      state: "published",
      faultRateUpperBound: 0.1,
      faultsObserved: 5,
      n: 100,
      window: "30d",
      retrievedAt: 1_700_000_000,
    }, payTo.secret());
    let calls = 0;
    const client = new ProviderAggregateClient({
      indexerUrl: "https://indexer.example",
      cacheTtlMs: 1,
      maxStaleMs: 60_000,
      now: () => now,
      fetchImpl: (async () => {
        calls++;
        if (calls === 1) return new Response(JSON.stringify(aggregate));
        throw new Error("indexer unavailable");
      }) as typeof fetch,
    });
    expect((await client.get(resource, payTo.publicKey())).status).toBe("fresh");
    now += 2;
    const outage = await client.get(resource, payTo.publicKey());
    expect(outage.status).toBe("cached");
    expect(outage.stale).toBe(true);
    expect(outage.aggregate?.state).toBe("published");
  });
});
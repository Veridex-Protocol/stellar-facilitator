import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  aggregateWithoutSignature,
  createSignedProviderAggregate,
  createSignedProviderObservation,
  verifyProviderAggregate,
  verifyProviderObservation,
} from "../provider-quality/crypto.js";
import { buildProviderAggregate, wilsonUpperBound } from "../provider-quality/aggregator.js";
import { ProviderAggregateSchema, ProviderObservationSchema } from "../provider-quality/types.js";
import type { ProviderObservationRecord } from "../provider-quality/store.js";

const signer = Keypair.random();
const resource = "https://provider.example/fx";
const payTo = signer.publicKey();
const digest = "sha256:" + "a".repeat(64);

function observation(overrides: Partial<ProviderObservationRecord> = {}): ProviderObservationRecord {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    resource,
    payTo,
    requestDigest: digest,
    responseDigest: digest,
    observedAt: new Date(1_700_000_000_000),
    usable: true,
    providerAtFault: false,
    attributable: "unknown",
    reasonCode: "ok",
    signer: payTo,
    signature: "signature",
    createdAt: new Date(1_700_000_000_000),
    ...overrides,
  };
}

describe("provider-quality crypto and aggregation", () => {
  it("rejects inconsistent attribution at the wire boundary", () => {
    expect(() => ProviderObservationSchema.parse({
      v: "veridex/provider-outcome/1",
      resource,
      payTo,
      requestDigest: digest,
      responseDigest: digest,
      observedAt: 1_700_000_000,
      usable: false,
      providerAtFault: true,
      attributable: "caller",
      reasonCode: "data_stale",
      signer: payTo,
      signature: "sig",
    })).toThrow(/providerAtFault requires provider attribution/);
  });

  it("verifies a payee-bound signed observation and rejects tampering", () => {
    const signedObservation = createSignedProviderObservation({
      resource,
      payTo,
      requestDigest: digest,
      responseDigest: digest,
      observedAt: 1_700_000_000,
      usable: false,
      providerAtFault: true,
      attributable: "provider" as const,
      reasonCode: "data_stale",
    }, signer.secret());
    expect(verifyProviderObservation(signedObservation, {
      expectedResource: resource,
      expectedPayTo: payTo,
      nowSeconds: 1_700_000_100,
    }).valid).toBe(true);
    expect(verifyProviderObservation({ ...signedObservation, responseDigest: digest.replace(/a/g, "b") }, {
      nowSeconds: 1_700_000_100,
    }).valid).toBe(false);
  });

  it("generates the three configured evidence states", () => {
    expect(buildProviderAggregate(resource, payTo, [], signer.secret(), { nowSeconds: 1_700_000_000 }).state).toBe("insufficient_data");
    const provisional = Array.from({ length: 20 }, (_, index) => observation({
      id: `00000000-0000-0000-0000-${String(index + 2).padStart(12, "0")}`,
      observedAt: new Date(1_700_000_000_000),
    }));
    expect(buildProviderAggregate(resource, payTo, provisional, signer.secret(), { nowSeconds: 1_700_000_000 }).state).toBe("provisional");
    const published = Array.from({ length: 100 }, (_, index) => observation({
      id: `00000000-0000-0000-0000-${String(index + 2).padStart(12, "0")}`,
      observedAt: new Date(1_700_000_000_000),
    }));
    expect(buildProviderAggregate(resource, payTo, published, signer.secret(), { nowSeconds: 1_700_000_000 }).state).toBe("published");
  });

  it("computes a conservative Wilson upper bound", () => {
    expect(wilsonUpperBound(0, 34)).toBeCloseTo(0.102, 2);
    expect(wilsonUpperBound(5, 34)).toBeCloseTo(0.301, 2);
    expect(() => wilsonUpperBound(2, 1)).toThrow();
  });

  it("signs aggregate payloads over all quality fields", () => {
    const aggregate = createSignedProviderAggregate({
      endpoint: resource,
      payTo,
      state: "published",
      faultRateUpperBound: 0.12,
      faultsObserved: 8,
      n: 100,
      window: "30d",
      retrievedAt: 1_700_000_000,
    }, signer.secret());
    expect(verifyProviderAggregate(aggregate, { expectedEndpoint: resource, expectedPayTo: payTo, nowSeconds: 1_700_000_100 })).toEqual({ valid: true });
    expect(aggregateWithoutSignature({ ...aggregate, n: 101 }).n).toBe(101);
    expect(verifyProviderAggregate({ ...aggregate, n: 101 }, { nowSeconds: 1_700_000_100 }).valid).toBe(false);
    expect(ProviderAggregateSchema.parse(aggregate).state).toBe("published");
  });

  it("accepts only configured aggregate issuers", () => {
    const issuer = Keypair.random();
    const aggregate = createSignedProviderAggregate({
      endpoint: resource,
      payTo,
      state: "provisional",
      faultRateUpperBound: 0.2,
      faultsObserved: 5,
      n: 20,
      window: "30d",
      retrievedAt: 1_700_000_000,
    }, issuer.secret());
    expect(verifyProviderAggregate(aggregate, {
      nowSeconds: 1_700_000_100,
      authorizedIssuers: [Keypair.random().publicKey()],
    }).valid).toBe(false);
    expect(verifyProviderAggregate(aggregate, {
      nowSeconds: 1_700_000_100,
      authorizedIssuers: [issuer.publicKey()],
    }).valid).toBe(true);
  });
});
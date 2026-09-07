import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { ProviderQualityStore } from "../provider-quality/store.js";
import { createSignedProviderObservation } from "../provider-quality/crypto.js";

const signer = Keypair.random();
const resource = "https://provider.example/fx";
const requestDigest = `sha256:${"a".repeat(64)}`;
const responseDigest = `sha256:${"b".repeat(64)}`;

function row(source: "in_band" | "independent", overrides: Record<string, unknown> = {}) {
  return {
    id: source === "in_band" ? "00000000-0000-0000-0000-000000000001" : "00000000-0000-0000-0000-000000000002",
    resource,
    pay_to: signer.publicKey(),
    request_digest: requestDigest,
    response_digest: responseDigest,
    observed_at: new Date(1_700_000_000_000),
    usable: true,
    provider_at_fault: false,
    attributable: "unknown",
    reason_code: "ok",
    usage_atomic: null,
    response_status: 200,
    tool_name: null,
    route: null,
    call_id: "call-1",
    settlement_tx: null,
    signer: signer.publicKey(),
    signature: `${source}-signature`,
    observation_source: source,
    created_at: new Date(1_700_000_000_000),
    ...overrides,
  };
}

function signedObservation(overrides: Record<string, unknown> = {}) {
  return createSignedProviderObservation({
    resource,
    payTo: signer.publicKey(),
    requestDigest,
    responseDigest,
    observedAt: 1_700_000_000,
    usable: true,
    providerAtFault: false,
    attributable: "unknown",
    reasonCode: "ok",
    responseStatus: 200,
    callId: "call-1",
    ...overrides,
  }, signer.secret());
}

describe("provider observation evidence sources", () => {
  it("persists independent source and records cross-source factual disagreement", async () => {
    const queries: Array<{ text: string; params?: unknown[] }> = [];
    const independent = row("independent", {
      usable: false,
      provider_at_fault: true,
      attributable: "provider",
      reason_code: "bad_data",
    });
    const database = {
      query: async (text: string, params?: unknown[]) => {
        queries.push({ text, params });
        if (text.includes("INSERT INTO provider_observations")) return { rows: [independent] };
        if (text.includes("SELECT * FROM provider_observations")) return { rows: [row("in_band")] };
        return { rows: [], rowCount: 1 };
      },
    };
    const store = new ProviderQualityStore(database as any);

    const recorded = await store.recordObservation({
      observation: signedObservation({
        usable: false,
        providerAtFault: true,
        attributable: "provider",
        reasonCode: "bad_data",
      }),
      source: "independent",
    });

    expect(recorded).toMatchObject({ source: "independent", disagreementRecorded: true });
    expect(queries.find(({ text }) => text.includes("INSERT INTO provider_observations"))?.params?.[17]).toBe("independent");
    const disagreement = queries.find(({ text }) => text.includes("INSERT INTO provider_observation_disagreements"));
    expect(disagreement?.params?.[5]).toEqual(["usable", "providerAtFault", "attributable", "reasonCode"]);
  });

  it("prefers one independent sample per signed request occurrence for aggregation", async () => {
    const queries: string[] = [];
    const database = {
      query: async (text: string) => {
        queries.push(text);
        return { rows: [row("independent")] };
      },
    };
    const store = new ProviderQualityStore(database as any);

    const observations = await store.listObservationsForAggregate(resource, signer.publicKey(), 300, 1_700_000_100);

    expect(observations).toHaveLength(1);
    expect(observations[0].source).toBe("independent");
    expect(queries[0]).toContain("PARTITION BY resource, pay_to, request_digest");
    expect(queries[0]).toContain("COALESCE('call:' || call_id, 'row:' || id::text)");
    expect(queries[0]).toContain("WHEN 'independent' THEN 0");
  });

  it("does not record a disagreement when in-band and independent facts match", async () => {
    const queries: string[] = [];
    const database = {
      query: async (text: string) => {
        queries.push(text);
        if (text.includes("INSERT INTO provider_observations")) return { rows: [row("independent")] };
        if (text.includes("SELECT * FROM provider_observations")) return { rows: [row("in_band")] };
        return { rows: [], rowCount: 0 };
      },
    };
    const store = new ProviderQualityStore(database as any);
    const recorded = await store.recordObservation({ observation: signedObservation(), source: "independent" });

    expect(recorded.disagreementRecorded).toBe(false);
    expect(queries.some((text) => text.includes("INSERT INTO provider_observation_disagreements"))).toBe(false);
  });
});
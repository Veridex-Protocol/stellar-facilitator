import { afterEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { BazaarService } from "../server.js";
import { createSignedProviderAggregate, createSignedProviderObservation } from "../provider-quality/crypto.js";

const token = "test-internal-token-that-is-long-enough";
const observerToken = "test-observer-token-that-is-long-enough";

function makeConfig() {
  return {
    port: 0,
    host: "127.0.0.1",
    database: { host: "127.0.0.1", port: 5432, database: "test", user: "test", password: "test" },
    p2p: { listenAddrs: [], heartbeatIntervalMs: 30_000, maxMissedHeartbeats: 3 },
    horizonUrl: "https://horizon-testnet.stellar.org",
    internalToken: token,
    announcedResources: [],
    providerAggregatePublishedThreshold: 100,
    providerAggregateProvisionalThreshold: 20,
  } as any;
}

afterEach(() => vi.restoreAllMocks());

describe("provider-quality HTTP surface", () => {
  it("requires internal authentication for observation writes", async () => {
    const service = new BazaarService(makeConfig());
    const response = await service.getApp().request("/provider-quality/observations", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    expect(response.status).toBe(401);
  });

  it("derives in-band source from the internal credential instead of the request body", async () => {
    const payee = Keypair.random();
    const observation = signedObservation(payee, payee.publicKey());
    const service = new BazaarService(makeConfig());
    const record = vi.spyOn((service as any).providerQualityStore, "recordObservation")
      .mockResolvedValue({ id: "observation-1", disagreementRecorded: false });
    const response = await service.getApp().request("/provider-quality/observations", {
      method: "POST",
      body: JSON.stringify({ observation, source: "independent" }),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(202);
    expect(record).toHaveBeenCalledWith({ observation, source: "in_band" });
  });

  it("accepts independent evidence only from the observer credential and signer allowlist", async () => {
    const payee = Keypair.random();
    const observer = Keypair.random();
    const observation = signedObservation(observer, payee.publicKey());
    const service = new BazaarService({
      ...makeConfig(),
      providerObserverToken: observerToken,
      providerObserverAuthorizedSigners: [observer.publicKey()],
    });
    const record = vi.spyOn((service as any).providerQualityStore, "recordObservation")
      .mockResolvedValue({ id: "observation-2", disagreementRecorded: false });
    const response = await service.getApp().request("/provider-quality/observations", {
      method: "POST",
      body: JSON.stringify({ observation }),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${observerToken}` },
    });

    expect(response.status).toBe(202);
    expect(record).toHaveBeenCalledWith({ observation, source: "independent" });
  });

  it("returns an explicit insufficient_data state before any aggregate exists", async () => {
    const service = new BazaarService(makeConfig());
    const db = (service as any).providerQualityStore;
    vi.spyOn(db, "getAggregate").mockResolvedValue(null);
    const response = await service.getApp().request("/v1/provider?endpoint=https%3A%2F%2Fprovider.example%2Ffx");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      endpoint: "https://provider.example/fx",
      state: "insufficient_data",
    });
  });

  it("exposes a signed aggregate without raw observations", async () => {
    const issuer = Keypair.random();
    const payTo = Keypair.random().publicKey();
    const aggregate = createSignedProviderAggregate({
      endpoint: "https://provider.example/fx",
      payTo,
      state: "provisional",
      faultRateUpperBound: 0.12,
      faultsObserved: 2,
      n: 20,
      window: "30d",
      retrievedAt: Math.floor(Date.now() / 1000),
    }, issuer.secret());
    const service = new BazaarService(makeConfig());
    vi.spyOn((service as any).providerQualityStore, "getAggregate").mockResolvedValue(aggregate);
    const response = await service.getApp().request("/v1/provider?endpoint=https%3A%2F%2Fprovider.example%2Ffx");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: "provisional", n: 20, faultsObserved: 2 });
  });
});

function signedObservation(signer: Keypair, payTo: string) {
  const digest = `sha256:${"a".repeat(64)}`;
  return createSignedProviderObservation({
    resource: "https://provider.example/fx",
    payTo,
    requestDigest: digest,
    responseDigest: digest,
    observedAt: Math.floor(Date.now() / 1000),
    usable: true,
    providerAtFault: false,
    attributable: "unknown",
    reasonCode: "ok",
    callId: "call-1",
  }, signer.secret());
}
import { Keypair } from "@stellar/stellar-sdk";
import { createProviderAggregate } from "@veridex/stellar";
import { describe, expect, it, vi } from "vitest";
import { createGatewayProviderPolicyController } from "../provider-policy.js";
import type { GatewayConfig } from "../types.js";

const seller = Keypair.random();
const issuer = Keypair.random();
const resource = "https://gateway.example.com/data";
const now = 1_700_000_100_000;

function config(): GatewayConfig {
  return {
    id: "gateway-policy-test",
    upstream: "https://api.example.com",
    publicBaseUrl: "https://gateway.example.com",
    facilitatorUrl: "https://facilitator.example.com",
    payTo: seller.publicKey(),
    network: "stellar:testnet",
    asset: `C${"A".repeat(55)}`,
    price: "50000",
    bazaarUrl: "https://bazaar.example.com",
    routes: [{ path: "/data", methods: ["GET"] }],
    providerPolicy: {
      enabled: true,
      authorizedIssuers: [issuer.publicKey()],
      warnMax: 0.1,
      holdMax: 0.15,
      refreshIntervalMs: 60_000,
    },
  };
}

describe("gateway provider policy controller", () => {
  it("holds sales from a trusted published aggregate above holdMax", async () => {
    const aggregate = createProviderAggregate({
      endpoint: resource,
      payTo: seller.publicKey(),
      state: "published",
      faultRateUpperBound: 0.2,
      faultsObserved: 20,
      n: 100,
      window: "30d",
      retrievedAt: Math.floor(now / 1000),
    }, issuer.secret());
    const controller = createGatewayProviderPolicyController(config(), {
      now: () => now,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(Response.json(aggregate)),
    });
    await vi.waitFor(() => expect(controller?.decision(resource).action).toBe("hold"));
    expect(controller?.decision(resource).reason).toContain("faultRateUpperBound=0.2000");
    controller?.stop();
  });

  it("rejects an otherwise valid aggregate from an unauthorized issuer", async () => {
    const untrusted = Keypair.random();
    const aggregate = createProviderAggregate({
      endpoint: resource,
      payTo: seller.publicKey(),
      state: "published",
      faultRateUpperBound: 0.2,
      faultsObserved: 20,
      n: 100,
      window: "30d",
      retrievedAt: Math.floor(now / 1000),
    }, untrusted.secret());
    const controller = createGatewayProviderPolicyController(config(), {
      now: () => now,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(Response.json(aggregate)),
    });
    await vi.waitFor(() => expect(controller?.decision(resource).reason).toContain("issuer is not authorized"));
    expect(controller?.decision(resource).action).toBe("sell");
    controller?.stop();
  });

  it("preserves payment availability when the aggregate indexer is offline", async () => {
    const controller = createGatewayProviderPolicyController(config(), {
      now: () => now,
      fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")),
    });
    await vi.waitFor(() => expect(controller?.decision(resource).reason).toBe("offline"));
    expect(controller?.decision(resource).action).toBe("sell");
    controller?.stop();
  });
});
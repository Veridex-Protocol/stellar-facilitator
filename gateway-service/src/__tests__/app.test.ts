import { Keypair } from "@stellar/stellar-sdk";
import { Hono } from "hono";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { serve, type ServerType } from "@hono/node-server";
import { createGatewayApp } from "../app.js";
import { InMemoryGatewayEventStore } from "../store.js";
import type { GatewayConfig } from "../types.js";

let facilitator: ServerType;
let facilitatorUrl: string;
const calls: string[] = [];

beforeAll(async () => {
  const app = new Hono();
  app.get("/supported", (context) => context.json({
    kinds: [{ x402Version: 2, scheme: "exact", network: "stellar:testnet" }],
    extensions: [],
    signers: {},
  }));
  app.post("/verify", async (context) => {
    calls.push("verify");
    return context.json({ isValid: true, payer: Keypair.random().publicKey() });
  });
  app.post("/settle", async (context) => {
    calls.push("settle");
    return context.json({
      success: true,
      transaction: "a".repeat(64),
      network: "stellar:testnet",
      payer: Keypair.random().publicKey(),
    });
  });
  facilitator = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((resolve) => facilitator.once("listening", resolve));
  const address = facilitator.address();
  if (!address || typeof address === "string") throw new Error("test facilitator did not bind");
  facilitatorUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(() => facilitator.close());

function gatewayConfig(): GatewayConfig {
  return {
    id: "gateway_test",
    upstream: "https://api.example.com",
    publicBaseUrl: "https://gateway.example.com",
    facilitatorUrl,
    payTo: Keypair.random().publicKey(),
    network: "stellar:testnet",
    asset: `C${"A".repeat(55)}`,
    price: "50000",
    routes: [{ path: "/demo", methods: ["GET"] }],
  };
}

describe("gateway payment gate", () => {
  it("never forwards an unpaid protected request", async () => {
    const upstreamFetch = vi.fn<typeof fetch>();
    const app = createGatewayApp(gatewayConfig(), { fetch: upstreamFetch });

    const response = await app.request("https://gateway.example.com/demo");

    expect(response.status).toBe(402);
    expect(response.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("verifies, forwards, and settles a paid request exactly once", async () => {
    calls.length = 0;
    const store = new InMemoryGatewayEventStore();
    const upstreamFetch = vi.fn<typeof fetch>().mockImplementation(async () => {
      calls.push("upstream");
      return Response.json({ ok: true });
    });
    const config = gatewayConfig();
    const app = createGatewayApp(config, { fetch: upstreamFetch, eventStore: store });
    const paymentPayload = {
      x402Version: 2,
      resource: { url: "https://gateway.example.com/demo" },
      accepted: {
        scheme: "exact",
        network: config.network,
        asset: config.asset,
        amount: config.price,
        payTo: config.payTo,
        maxTimeoutSeconds: 120,
      },
      payload: { transaction: "opaque-test-authorization" },
    };

    const response = await app.request("https://gateway.example.com/demo", {
      headers: {
        "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(paymentPayload)).toString("base64"),
      },
    });

    expect(response.status).toBe(200);
    expect(calls).toEqual(["verify", "upstream", "settle"]);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    expect(store.providerOutcomes).toHaveLength(1);
  });
});
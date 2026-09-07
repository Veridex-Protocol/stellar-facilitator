import { Keypair } from "@stellar/stellar-sdk";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import { Hono } from "hono";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { serve, type ServerType } from "@hono/node-server";
import { createGatewayApp } from "../app.js";
import { InMemoryGatewayEventStore } from "../store.js";
import type { GatewayConfig } from "../types.js";

let facilitator: ServerType;
let facilitatorUrl: string;
const calls: string[] = [];
const publicDns = async () => ["93.184.216.34"];

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

async function paymentHeader(
  app: Awaited<ReturnType<typeof createGatewayApp>>,
  url = "https://gateway.example.com/demo",
  method = "GET",
): Promise<string> {
  const challenge = await app.request(url, { method });
  const requiredHeader = challenge.headers.get("PAYMENT-REQUIRED");
  if (!requiredHeader) throw new Error("gateway did not return PAYMENT-REQUIRED");
  const paymentRequired = decodePaymentRequiredHeader(requiredHeader);
  return encodePaymentSignatureHeader({
    x402Version: 2,
    resource: paymentRequired.resource,
    accepted: paymentRequired.accepts[0],
    payload: { transaction: "opaque-test-authorization" },
    extensions: paymentRequired.extensions,
  });
}

describe("gateway payment gate", () => {
  it("never forwards an unpaid protected request", async () => {
    const upstreamFetch = vi.fn<typeof fetch>();
    const store = new InMemoryGatewayEventStore();
    const app = await createGatewayApp(gatewayConfig(), {
      fetch: upstreamFetch,
      eventStore: store,
      resolveHostname: publicDns,
    });

    const response = await app.request("https://gateway.example.com/demo");

    expect(response.status).toBe(402);
    const requiredHeader = response.headers.get("PAYMENT-REQUIRED");
    expect(requiredHeader).toBeTruthy();
    const required = decodePaymentRequiredHeader(requiredHeader!);
    expect((required.extensions?.bazaar as any).info.input.method).toBe("GET");
    expect(upstreamFetch).not.toHaveBeenCalled();
    expect(store.paymentEvents.at(-1)?.status).toBe("challenged");
  });

  it("verifies, settles, and then forwards a paid request", async () => {
    calls.length = 0;
    const store = new InMemoryGatewayEventStore();
    const upstreamFetch = vi.fn<typeof fetch>().mockImplementation(async () => {
      calls.push("upstream");
      return Response.json({ ok: true });
    });
    const config = gatewayConfig();
    const app = await createGatewayApp(config, {
      fetch: upstreamFetch,
      eventStore: store,
      resolveHostname: publicDns,
    });
    const signature = await paymentHeader(app);
    calls.length = 0;

    const response = await app.request("https://gateway.example.com/demo", {
      headers: { "PAYMENT-SIGNATURE": signature },
    });

    expect(response.status).toBe(200);
    expect(calls).toEqual(["verify", "settle", "upstream"]);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    expect(store.providerOutcomes).toHaveLength(1);
    expect(store.paymentEvents.map((event) => event.status)).toEqual([
      "challenged",
      "verified",
      "settled",
    ]);
    const paymentResponse = response.headers.get("PAYMENT-RESPONSE");
    expect(paymentResponse && decodePaymentResponseHeader(paymentResponse).transaction).toBe("a".repeat(64));
  });

  it("settles a replay once and forwards a stable upstream idempotency key", async () => {
    calls.length = 0;
    const idempotencyKeys: string[] = [];
    const upstreamFetch = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      calls.push("upstream");
      idempotencyKeys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
      return Response.json({ ok: true });
    });
    const app = await createGatewayApp(gatewayConfig(), {
      fetch: upstreamFetch,
      eventStore: new InMemoryGatewayEventStore(),
      resolveHostname: publicDns,
    });
    const signature = await paymentHeader(app);
    calls.length = 0;

    await app.request("https://gateway.example.com/demo", {
      headers: { "PAYMENT-SIGNATURE": signature },
    });
    await app.request("https://gateway.example.com/demo", {
      headers: { "PAYMENT-SIGNATURE": signature },
    });

    expect(calls).toEqual(["verify", "settle", "upstream", "upstream"]);
    expect(idempotencyKeys[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(idempotencyKeys[1]).toBe(idempotencyKeys[0]);
  });

  it("preserves method, path, query, safe headers, and body", async () => {
    let forwardedUrl = "";
    let forwardedInit: RequestInit | undefined;
    const upstreamFetch = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      calls.push("upstream");
      forwardedUrl = String(url);
      forwardedInit = init;
      return Response.json({ ok: true });
    });
    const config = gatewayConfig();
    config.upstream = "https://api.example.com/base";
    config.routes = [{ path: "/demo", methods: ["POST"] }];
    const app = await createGatewayApp(config, {
      fetch: upstreamFetch,
      resolveHostname: publicDns,
    });
    const signature = await paymentHeader(app, "https://gateway.example.com/demo?mode=full", "POST");

    const response = await app.request("https://gateway.example.com/demo?mode=full", {
      method: "POST",
      headers: {
        "PAYMENT-SIGNATURE": signature,
        Authorization: "Bearer must-not-forward",
        "X-Forwarded-Host": "must-not-forward",
        "X-Custom": "safe",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ hello: "gateway" }),
    });

    const headers = new Headers(forwardedInit?.headers);
    expect(response.status).toBe(200);
    expect(forwardedUrl).toBe("https://api.example.com/base/demo?mode=full");
    expect(forwardedInit?.method).toBe("POST");
    expect(headers.get("Authorization")).toBeNull();
    expect(headers.get("PAYMENT-SIGNATURE")).toBeNull();
    expect(headers.get("X-Forwarded-Host")).toBeNull();
    expect(headers.get("X-Custom")).toBe("safe");
    expect(Buffer.from(forwardedInit?.body as ArrayBuffer).toString("utf8")).toBe('{"hello":"gateway"}');
  });

  it("returns settlement proof when the upstream fails after settlement", async () => {
    calls.length = 0;
    const upstreamFetch = vi.fn<typeof fetch>().mockImplementation(async () => {
      calls.push("upstream");
      throw new Error("offline");
    });
    const store = new InMemoryGatewayEventStore();
    const app = await createGatewayApp(gatewayConfig(), {
      fetch: upstreamFetch,
      eventStore: store,
      resolveHostname: publicDns,
    });
    const signature = await paymentHeader(app);
    calls.length = 0;

    const response = await app.request("https://gateway.example.com/demo", {
      headers: { "PAYMENT-SIGNATURE": signature },
    });
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(calls).toEqual(["verify", "settle", "upstream"]);
    expect(body.payment).toEqual({ status: "settled", transactionHash: "a".repeat(64) });
    expect(response.headers.get("PAYMENT-RESPONSE")).toBeTruthy();
    expect(store.providerOutcomes.at(-1)?.reasonCode).toBe("upstream_unreachable");
  });

  it("blocks a hostname that resolves to a private address", async () => {
    await expect(createGatewayApp(gatewayConfig(), {
      resolveHostname: async () => ["127.0.0.1"],
    })).rejects.toThrow("private or reserved IPv4");
  });

  it("exposes metrics and authenticated portal contracts", async () => {
    const app = await createGatewayApp(gatewayConfig(), {
      resolveHostname: publicDns,
      managementToken: "test-management-token",
    });

    const unauthorized = await app.request("https://gateway.example.com/v1/gateways/gateway_test");
    const snapshot = await app.request("https://gateway.example.com/v1/gateways/gateway_test", {
      headers: { Authorization: "Bearer test-management-token" },
    });
    const metrics = await app.request("https://gateway.example.com/metrics");

    expect(unauthorized.status).toBe(401);
    expect(snapshot.status).toBe(200);
    expect((await snapshot.json()).schemaVersion).toBe("veridex.portal.stellar-gateway/v1");
    expect(await metrics.text()).toContain("veridex_gateway_settlements_total");
  });

  it.each(["GET", "POST", "PUT", "PATCH", "DELETE"] as const)(
    "forwards paid %s requests",
    async (method) => {
      let forwardedMethod = "";
      const upstreamFetch = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
        forwardedMethod = init?.method ?? "";
        return Response.json({ ok: true });
      });
      const config = gatewayConfig();
      config.routes = [{ path: "/demo", methods: [method] }];
      const app = await createGatewayApp(config, { fetch: upstreamFetch, resolveHostname: publicDns });
      const signature = await paymentHeader(app, "https://gateway.example.com/demo", method);
      const response = await app.request("https://gateway.example.com/demo", {
        method,
        headers: { "PAYMENT-SIGNATURE": signature, "Content-Type": "application/json" },
        body: method === "GET" ? undefined : "{}",
      });

      expect(response.status).toBe(200);
      expect(forwardedMethod).toBe(method);
    },
  );

  it("rejects an oversized request before verify or settlement", async () => {
    calls.length = 0;
    const config = gatewayConfig();
    config.maxRequestBodyBytes = 4;
    config.routes = [{ path: "/demo", methods: ["POST"] }];
    const upstreamFetch = vi.fn<typeof fetch>();
    const app = await createGatewayApp(config, { fetch: upstreamFetch, resolveHostname: publicDns });
    const signature = await paymentHeader(app, "https://gateway.example.com/demo", "POST");
    calls.length = 0;

    const response = await app.request("https://gateway.example.com/demo", {
      method: "POST",
      headers: { "PAYMENT-SIGNATURE": signature, "Content-Type": "text/plain" },
      body: "too-large",
    });

    expect(response.status).toBe(413);
    expect(calls).toEqual([]);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("enforces paused, expired, and rate-limited lifecycle states", async () => {
    const paused = gatewayConfig();
    paused.state = "paused";
    const pausedApp = await createGatewayApp(paused, { resolveHostname: publicDns });
    expect((await pausedApp.request("https://gateway.example.com/demo")).status).toBe(503);

    const expired = gatewayConfig();
    expired.expiresAt = "2020-01-01T00:00:00.000Z";
    const expiredApp = await createGatewayApp(expired, { resolveHostname: publicDns });
    expect((await expiredApp.request("https://gateway.example.com/demo")).status).toBe(410);

    const limited = gatewayConfig();
    limited.rateLimit = { windowMs: 60_000, max: 1 };
    const limitedApp = await createGatewayApp(limited, { resolveHostname: publicDns });
    expect((await limitedApp.request("https://gateway.example.com/demo")).status).toBe(402);
    expect((await limitedApp.request("https://gateway.example.com/demo")).status).toBe(429);
  });

  it.each([
    [400, "caller", false],
    [401, "caller", false],
    [403, "caller", false],
    [404, "caller", false],
    [429, "caller", false],
    [500, "provider", true],
    [502, "provider", true],
  ] as const)("attributes upstream HTTP %s", async (status, attributable, providerAtFault) => {
    const store = new InMemoryGatewayEventStore();
    const app = await createGatewayApp(gatewayConfig(), {
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response("upstream", { status })),
      eventStore: store,
      resolveHostname: publicDns,
    });
    const signature = await paymentHeader(app);
    await app.request("https://gateway.example.com/demo", {
      headers: { "PAYMENT-SIGNATURE": signature },
    });

    expect(store.providerOutcomes.at(-1)).toMatchObject({ attributable, providerAtFault, upstreamStatus: status });
  });

  it("reports a signed provider outcome and settlement correlation asynchronously", async () => {
    const seller = Keypair.random();
    const reportedPaths: string[] = [];
    const config = gatewayConfig();
    config.payTo = seller.publicKey();
    config.bazaarUrl = "https://bazaar.example.com";
    const upstreamFetch = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      const target = new URL(String(url));
      if (target.origin === "https://bazaar.example.com") {
        reportedPaths.push(target.pathname);
        return Response.json({ status: "accepted" }, { status: 202 });
      }
      return Response.json({ ok: true });
    });
    const app = await createGatewayApp(config, {
      fetch: upstreamFetch,
      resolveHostname: publicDns,
      providerOutcomeSecretKey: seller.secret(),
      providerObserverToken: "internal-token",
    });
    const signature = await paymentHeader(app);
    const response = await app.request("https://gateway.example.com/demo", {
      headers: { "PAYMENT-SIGNATURE": signature },
    });

    expect(response.headers.get("X-Veridex-Provider-Outcome")).toBeTruthy();
    await vi.waitFor(() => expect(reportedPaths).toEqual([
      "/provider-quality/observations",
      "/provider-quality/observations/settlement",
    ]));
  });
});
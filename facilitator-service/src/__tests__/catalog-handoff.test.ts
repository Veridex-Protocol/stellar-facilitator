import { afterEach, describe, expect, it, vi } from "vitest";
import { FacilitatorService, postCatalogIngest } from "../server.js";
import { makeConfig, recordingLogger } from "./helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.BAZAAR_URL;
  delete process.env.BAZAAR_INTERNAL_TOKEN;
});

describe("post-settlement catalog handoff", () => {
  it("abandons an unavailable indexer at the configured deadline", async () => {
    const startedAt = Date.now();
    await expect(postCatalogIngest(
      new URL("https://bazaar.example/catalog/ingest"),
      { method: "POST", body: "{}" },
      20,
      ((_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      })) as typeof fetch,
    )).rejects.toMatchObject({ name: "TimeoutError" });

    expect(Date.now() - startedAt).toBeLessThan(250);
  });

  it("returns the catalog response when it completes inside the deadline", async () => {
    const response = await postCatalogIngest(
      new URL("https://bazaar.example/catalog/ingest"),
      { method: "POST", body: "{}" },
      100,
      (async () => new Response("accepted", { status: 202 })) as typeof fetch,
    );

    expect(response.status).toBe(202);
  });

  it("returns a successful settlement when Bazaar is unavailable", async () => {
    process.env.BAZAAR_URL = "https://bazaar.example";
    process.env.BAZAAR_INTERNAL_TOKEN = "test-internal-token";
    vi.stubGlobal("fetch", ((_url: URL, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch);
    const { config } = makeConfig({ catalogHandoffTimeoutMs: 20 });
    const service = new FacilitatorService(config, recordingLogger().logger);
    vi.spyOn((service as any).x402Facilitator, "settle").mockResolvedValue({
      success: true,
      transaction: "a".repeat(64),
      network: "stellar:testnet",
      payer: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    });
    const requirements = {
      scheme: "exact",
      network: "stellar:testnet",
      asset: "CC7AMNLQWIEKWMSGKXC7DFEXHDTNMQ6JL2BBPRBM6RQXYZXCNKD75CVB",
      amount: "100000",
      payTo: "GCNNJJV3XUXWCVV3WBKILBCUUGKSDZ2BL4HHNV7AISYMW6PJQX47DZYU",
      maxTimeoutSeconds: 60,
      extra: {},
    };
    const paymentPayload = {
      x402Version: 2,
      accepted: requirements,
      resource: {
        url: "https://seller.example/paid-resource",
        description: "Paid resource",
        mimeType: "application/json",
      },
      extensions: {
        bazaar: {
          info: { input: { type: "http", method: "GET" } },
          schema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
              input: {
                type: "object",
                properties: {
                  type: { type: "string", const: "http" },
                  method: { type: "string", enum: ["GET"] },
                },
                required: ["type", "method"],
              },
            },
            required: ["input"],
          },
        },
      },
      payload: { transaction: "AAAAAg==" },
    };

    const startedAt = Date.now();
    const response = await service.getApp().request("/settle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paymentPayload, paymentRequirements: requirements }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, transaction: "a".repeat(64) });
    expect(Date.now() - startedAt).toBeLessThan(300);
  });
});
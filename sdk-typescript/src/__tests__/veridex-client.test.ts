import { describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { createVeridexClient, VeridexClientError } from "../veridex-client.js";

const { createUptoPaymentPayload } = vi.hoisted(() => ({
  createUptoPaymentPayload: vi.fn(async () => ({
    x402Version: 2,
    payload: { transaction: "UPTO_PAYMENT" },
  })),
}));

vi.mock("@x402/stellar/exact/client", () => ({
  ExactStellarScheme: class {
    readonly scheme = "exact";

    async createPaymentPayload() {
      return { x402Version: 2, payload: { transaction: "TEST_PAYMENT" } };
    }
  },
}));

vi.mock("../upto-client.js", () => ({
  createUptoStellarClient: () => ({
    scheme: "upto",
    createPaymentPayload: createUptoPaymentPayload,
  }),
}));

const PRIVATE_KEY = Keypair.random().secret();
const PAY_TO = Keypair.random().publicKey();
const ASSET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

function response(status: number, headers: Record<string, string>, body = "{}"): Response {
  return new Response(body, { status, headers });
}

describe("VeridexClient", () => {
  it("constructs an official x402 buyer facade", () => {
    expect(createVeridexClient({ network: "stellar:testnet", privateKey: PRIVATE_KEY })).toBeDefined();
  });

  it("performs the 402 challenge and retry through the official wrapper", async () => {
    let calls = 0;
    const fetchImpl = async (input: Parameters<typeof globalThis.fetch>[0], _init?: RequestInit) => {
      calls++;
      if (calls === 1) {
        return response(402, {
          "payment-required": Buffer.from(JSON.stringify({
            x402Version: 2,
            resource: { url: "https://seller.example/data" },
            accepts: [{
              scheme: "exact",
              network: "stellar:testnet",
              asset: ASSET,
              amount: "1",
              payTo: PAY_TO,
              maxTimeoutSeconds: 60,
              extra: { areFeesSponsored: true },
            }],
          })).toString("base64"),
        });
      }
      const headers = input instanceof Request ? input.headers : new Headers();
      expect(headers.has("PAYMENT-SIGNATURE")).toBe(true);
      return response(200, { "content-type": "application/json" }, '{"ok":true}');
    };

    const client = createVeridexClient({ network: "stellar:testnet", privateKey: PRIVATE_KEY, fetch: fetchImpl });
    const result = await client.fetch("https://seller.example/data");
    expect(calls).toBe(2);
    expect(await result.json()).toEqual({ ok: true });
  });

  it("selects upto when explicitly requested", async () => {
    let calls = 0;
    const fetchImpl = async (input: Parameters<typeof globalThis.fetch>[0]) => {
      calls++;
      if (calls === 1) {
        return response(402, {
          "payment-required": Buffer.from(JSON.stringify({
            x402Version: 2,
            resource: { url: "https://seller.example/metered" },
            accepts: [
              {
                scheme: "exact",
                network: "stellar:testnet",
                asset: ASSET,
                amount: "1000",
                payTo: PAY_TO,
                maxTimeoutSeconds: 60,
                extra: { areFeesSponsored: true },
              },
              {
                scheme: "upto",
                network: "stellar:testnet",
                asset: ASSET,
                amount: "1000",
                payTo: PAY_TO,
                maxTimeoutSeconds: 60,
                extra: {
                  areFeesSponsored: true,
                  contractId: "CAHV6TIAOVSICUJHI6OBZSW2N5ZKRPGKHE2SH6OAEJHPHCLF5DXWAGG2",
                  facilitator: PAY_TO,
                  requestDigest: `sha256:${"0".repeat(64)}`,
                },
              },
            ],
          })).toString("base64"),
        });
      }
      const headers = input instanceof Request ? input.headers : new Headers();
      expect(headers.has("PAYMENT-SIGNATURE")).toBe(true);
      return response(200, { "content-type": "application/json" }, '{"metered":true}');
    };

    const client = createVeridexClient({
      network: "stellar:testnet",
      privateKey: PRIVATE_KEY,
      scheme: "upto",
      fetch: fetchImpl,
    });
    const result = await client.fetch("https://seller.example/metered");

    expect(calls).toBe(2);
    expect(createUptoPaymentPayload).toHaveBeenCalledTimes(1);
    expect(await result.json()).toEqual({ metered: true });
  });

  it("normalizes missing buyer configuration", () => {
    expect(() => createVeridexClient({ network: "stellar:testnet", privateKey: "" })).toThrowError(
      expect.objectContaining({ code: "invalid_configuration" }),
    );
  });

  it("normalizes upstream fetch failures", async () => {
    const client = createVeridexClient({
      network: "stellar:testnet",
      privateKey: PRIVATE_KEY,
      fetch: async () => { throw new Error("fetch failed"); },
    });
    await expect(client.fetch("https://seller.example/data")).rejects.toBeInstanceOf(VeridexClientError);
    await expect(client.fetch("https://seller.example/data")).rejects.toMatchObject({
      code: "facilitator_unavailable",
      retryable: true,
    });
  });
});
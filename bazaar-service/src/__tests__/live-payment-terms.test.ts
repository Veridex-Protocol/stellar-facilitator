import { describe, expect, it } from "vitest";
import {
  validateLivePaymentTerms,
  type ExpectedPaymentTerms,
} from "../catalog/live-payment-terms.js";

const expected: ExpectedPaymentTerms = {
  resourceUrl: "https://seller.example/weather",
  network: "stellar:testnet",
  scheme: "exact",
  asset: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
  payTo: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  amount: "100000",
};

function challenge(overrides: Record<string, unknown> = {}): Response {
  const paymentRequired = {
    x402Version: 2,
    resource: {
      url: expected.resourceUrl,
      description: "Weather",
      mimeType: "application/json",
    },
    accepts: [{
      network: expected.network,
      scheme: expected.scheme,
      asset: expected.asset,
      payTo: expected.payTo,
      amount: expected.amount,
      maxTimeoutSeconds: 120,
      extra: {},
      ...overrides,
    }],
  };
  return new Response(null, {
    status: 402,
    headers: {
      "payment-required": Buffer.from(JSON.stringify(paymentRequired)).toString("base64"),
    },
  });
}

const publicDns = async () => ["8.8.8.8"];

describe("live catalog payment-term validation", () => {
  it("accepts a listing when one live payment alternative matches every submitted term", async () => {
    const result = await validateLivePaymentTerms(expected, {
      resolveHost: publicDns,
      fetchImpl: async () => challenge(),
    });

    expect(result).toEqual({ valid: true });
  });

  it.each([
    ["payTo", "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBW7", "catalog_live_payment_payto_mismatch"],
    ["amount", "100001", "catalog_live_payment_amount_mismatch"],
    ["network", "stellar:pubnet", "catalog_live_payment_network_mismatch"],
    ["asset", "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBXE", "catalog_live_payment_asset_mismatch"],
    ["scheme", "upto", "catalog_live_payment_scheme_mismatch"],
  ])("rejects a forged live %s", async (field, value, code) => {
    const result = await validateLivePaymentTerms(expected, {
      resolveHost: publicDns,
      fetchImpl: async () => challenge({ [field]: value }),
    });

    expect(result).toMatchObject({ valid: false, code, retryable: false });
  });

  it("rejects a challenge bound to another resource", async () => {
    const paymentRequired = {
      x402Version: 2,
      resource: { url: "https://seller.example/other" },
      accepts: [{ ...expected }],
    };
    const result = await validateLivePaymentTerms(expected, {
      resolveHost: publicDns,
      fetchImpl: async () => new Response(null, {
        status: 402,
        headers: { "payment-required": Buffer.from(JSON.stringify(paymentRequired)).toString("base64") },
      }),
    });

    expect(result.code).toBe("catalog_live_payment_resource_mismatch");
  });

  it("rejects a resource that no longer presents a payment challenge", async () => {
    const result = await validateLivePaymentTerms(expected, {
      resolveHost: publicDns,
      fetchImpl: async () => new Response("gone", { status: 404 }),
    });

    expect(result).toMatchObject({
      valid: false,
      code: "catalog_live_payment_challenge_missing",
      retryable: false,
    });
  });

  it("classifies a bounded validation timeout as retryable", async () => {
    const result = await validateLivePaymentTerms(expected, {
      resolveHost: publicDns,
      fetchImpl: async () => {
        throw new DOMException("timed out", "TimeoutError");
      },
    });

    expect(result).toMatchObject({
      valid: false,
      code: "catalog_live_payment_timeout",
      retryable: true,
    });
  });

  it("does not follow redirects during validation", async () => {
    let redirectMode: RequestRedirect | undefined;
    const result = await validateLivePaymentTerms(expected, {
      resolveHost: publicDns,
      fetchImpl: async (_input, init) => {
        redirectMode = init?.redirect;
        throw new TypeError("redirect mode is set to error");
      },
    });

    expect(redirectMode).toBe("error");
    expect(result.code).toBe("catalog_live_payment_unavailable");
  });

  it("blocks private targets unless their exact origin is explicitly allowed", async () => {
    const privateExpected = { ...expected, resourceUrl: "http://demo-server:3003/paid-resource" };
    const blocked = await validateLivePaymentTerms(privateExpected, {
      resolveHost: async () => ["172.20.0.4"],
      fetchImpl: async () => challenge(),
    });
    expect(blocked.code).toBe("catalog_live_payment_url_unsafe");

    let called = false;
    await validateLivePaymentTerms(privateExpected, {
      allowedOrigins: ["http://demo-server:3003"],
      fetchImpl: async () => {
        called = true;
        return challenge();
      },
    });
    expect(called).toBe(true);
  });

  it("blocks reserved documentation address ranges", async () => {
    const result = await validateLivePaymentTerms(expected, {
      resolveHost: async () => ["203.0.113.10"],
      fetchImpl: async () => challenge(),
    });

    expect(result.code).toBe("catalog_live_payment_url_unsafe");
  });

  it("can use an explicit internal transport origin without changing resource identity", async () => {
    const publicExpected = { ...expected, resourceUrl: "http://localhost:3203/paid-resource" };
    let fetchedUrl = "";
    const result = await validateLivePaymentTerms(publicExpected, {
      allowedOrigins: ["http://localhost:3203"],
      transportOriginMap: { "http://localhost:3203": "http://demo-server:3003" },
      fetchImpl: async (input) => {
        fetchedUrl = String(input);
        const paymentRequired = {
          x402Version: 2,
          resource: { url: publicExpected.resourceUrl },
          accepts: [{ ...expected }],
        };
        return new Response(null, {
          status: 402,
          headers: { "payment-required": Buffer.from(JSON.stringify(paymentRequired)).toString("base64") },
        });
      },
    });

    expect(result).toEqual({ valid: true });
    expect(fetchedUrl).toBe("http://demo-server:3003/paid-resource");
  });

  it("accepts a challenge that names the exact configured transport URL", async () => {
    const publicExpected = { ...expected, resourceUrl: "http://localhost:3203/paid-resource" };
    const result = await validateLivePaymentTerms(publicExpected, {
      allowedOrigins: ["http://localhost:3203"],
      transportOriginMap: { "http://localhost:3203": "http://demo-server:3003" },
      fetchImpl: async () => {
        const paymentRequired = {
          x402Version: 2,
          resource: { url: "http://demo-server:3003/paid-resource" },
          accepts: [{ ...expected }],
        };
        return new Response(null, {
          status: 402,
          headers: { "payment-required": Buffer.from(JSON.stringify(paymentRequired)).toString("base64") },
        });
      },
    });

    expect(result).toEqual({ valid: true });
  });
});
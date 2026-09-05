import { afterEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { BazaarClient, createBazaarClient } from "../bazaar-client.js";
import { FacilitatorClient, createFacilitatorClient } from "../facilitator-client.js";

const BAZAAR_URL = "http://bazaar.test";
const FACILITATOR_URL = "http://facilitator.test";

/**
 * Replaces global fetch with a recording stub.
 *
 * @param body - The JSON body every request resolves to
 * @param status - The HTTP status to return
 * @returns The requests the code under test made
 */
function stubFetch(body: unknown, status = 200): { url: string; init?: RequestInit }[] {
  const seen: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    seen.push({ url: String(input), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  return seen;
}

afterEach(() => vi.unstubAllGlobals());

describe("BazaarClient", () => {
  it("searches the configured catalog", async () => {
    const seen = stubFetch({ results: [], total: 0, limit: 20, offset: 0 });

    await createBazaarClient({ bazaarUrl: BAZAAR_URL }).search({ query: "weather forecast" });

    const url = new URL(seen[0].url);
    expect(url.origin).toBe(BAZAAR_URL);
    expect(url.pathname).toBe("/discovery/search");
    expect(url.searchParams.get("q")).toBe("weather forecast");
  });

  it("passes filters through to the wire", async () => {
    const seen = stubFetch({ results: [], total: 0 });

    await createBazaarClient({ bazaarUrl: BAZAAR_URL }).search({
      query: "storage",
      network: "stellar:testnet",
      limit: 5,
      minUptimeRatio: 0,
    });

    const url = new URL(seen[0].url);
    expect(url.searchParams.get("network")).toBe("stellar:testnet");
    expect(url.searchParams.get("limit")).toBe("5");
  });

  it("applies the configured default network when a call does not name one", async () => {
    const seen = stubFetch({ results: [], total: 0 });

    await createBazaarClient({
      bazaarUrl: BAZAAR_URL,
      defaultNetwork: "stellar:testnet",
    }).search({ query: "a" });

    expect(new URL(seen[0].url).searchParams.get("network")).toBe("stellar:testnet");
  });

  it("returns the results the catalog sent", async () => {
    stubFetch({
      results: [{ resourceUrl: "http://seller.test/a", payTo: "GABC", network: "stellar:testnet" }],
      total: 1,
    });

    const response = await createBazaarClient({ bazaarUrl: BAZAAR_URL }).search({ query: "a" });

    expect(response.results).toHaveLength(1);
    expect(response.results[0].resourceUrl).toBe("http://seller.test/a");
  });

  it("surfaces a failure rather than returning an empty result set", async () => {
    // A catalog that is down must not look like a catalog with no matches.
    stubFetch({ error: "Search failed" }, 500);

    await expect(
      createBazaarClient({ bazaarUrl: BAZAAR_URL }).search({ query: "a" }),
    ).rejects.toThrow();
  });

  it("lists catalog entries", async () => {
    const seen = stubFetch({ results: [], total: 0 });

    await createBazaarClient({ bazaarUrl: BAZAAR_URL }).list({ limit: 10 });

    expect(new URL(seen[0].url).pathname).toBe("/discovery/resources");
  });

  it("is constructible directly as well as through the factory", () => {
    expect(new BazaarClient({ bazaarUrl: BAZAAR_URL })).toBeInstanceOf(BazaarClient);
    expect(createBazaarClient({ bazaarUrl: BAZAAR_URL })).toBeInstanceOf(BazaarClient);
  });

  it("reads explicit insufficient provider-quality data", async () => {
    const seen = stubFetch({
      v: "veridex/provider-aggregate/1",
      endpoint: "https://provider.example/fx",
      state: "insufficient_data",
      faultRateUpperBound: 1,
      faultsObserved: 0,
      n: 0,
      window: "30d",
      retrievedAt: 1_700_000_000,
    });
    const result = await createBazaarClient({ bazaarUrl: BAZAAR_URL }).providerQuality("https://provider.example/fx");
    expect(new URL(seen[0].url).pathname).toBe("/v1/provider");
    expect(result.state).toBe("insufficient_data");
  });

  it("reads digest-only provider observations", async () => {
    const seen = stubFetch({ endpoint: "https://provider.example/fx", observations: [] });
    const result = await createBazaarClient({ bazaarUrl: BAZAAR_URL }).providerObservations(
      "https://provider.example/fx",
      { limit: 5 },
    );
    expect(new URL(seen[0].url).pathname).toBe("/v1/provider/observations");
    expect(new URL(seen[0].url).searchParams.get("limit")).toBe("5");
    expect(result.observations).toEqual([]);
  });
});

describe("FacilitatorClient", () => {
  const config = { facilitatorUrl: FACILITATOR_URL, network: "testnet" as const };

  it("reads the advertised capabilities", async () => {
    const seen = stubFetch({
      kinds: [
        {
          x402Version: 2,
          scheme: "exact",
          network: "stellar:testnet",
          extra: { areFeesSponsored: true },
        },
      ],
      signers: { "stellar:*": ["GABC"] },
    });

    const supported = await createFacilitatorClient(config).getSupportedSchemes();

    expect(new URL(seen[0].url).pathname).toBe("/supported");
    expect(supported.kinds[0].scheme).toBe("exact");
    // A buyer reads this to know whether it needs XLM for fees.
    expect(supported.kinds[0].extra?.areFeesSponsored).toBe(true);
  });

  it("does not claim sponsored fees when the facilitator does not advertise them", async () => {
    stubFetch({
      kinds: [{ x402Version: 2, scheme: "exact", network: "stellar:testnet", extra: { areFeesSponsored: false } }],
      signers: { "stellar:*": ["GABC"] },
    });
    await expect(createFacilitatorClient({
      ...config,
      clientSecretKey: Keypair.random().secret(),
      requireSponsoredFees: true,
    }).pay({
      resourceUrl: "https://seller.example/data",
      amountStroops: "1",
      payTo: "GABC",
    })).rejects.toThrow(/sponsored fees/);
  });

  it("reads the capability descriptor", async () => {
    const seen = stubFetch({
      ccd: "x402ccd/0",
      runtime: { attested: false },
      receipts: { format: "x402job/1", canonicalization: "RFC8785" },
      jobs: [],
    });

    const descriptor = await createFacilitatorClient(config).getCapabilityDescriptor();

    expect(new URL(seen[0].url).pathname).toBe("/.well-known/x402");
    expect(descriptor.ccd).toBe("x402ccd/0");
    // The honesty rule: never claim an attested runtime without a TEE claim.
    expect(descriptor.runtime?.attested).toBe(false);
  });

  it("posts a verification to /verify", async () => {
    const seen = stubFetch({ isValid: true });

    await createFacilitatorClient(config).verify("AAAAAgAAAA==", {
      scheme: "exact",
      network: "stellar:testnet",
    } as never);

    expect(new URL(seen[0].url).pathname).toBe("/verify");
    expect(seen[0].init?.method).toBe("POST");
  });

  it("preserves the rejection reason instead of collapsing it to a boolean", async () => {
    // The reason is the point: an integrator needs to know which check failed.
    stubFetch({
      isValid: false,
      invalidReason: "invalid_exact_stellar_payload_wrong_amount",
      invalidMessage:
        "The amount in the signed transaction does not equal the amount in the payment requirements.",
    });

    const result = await createFacilitatorClient(config).verify("AAAAAgAAAA==", {
      scheme: "exact",
      network: "stellar:testnet",
    } as never);

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_stellar_payload_wrong_amount");
    expect(result.invalidMessage).toContain("does not equal");
  });

  it("looks a settlement up by transaction hash", async () => {
    const seen = stubFetch({ found: true, successful: true, ledger: 4294937 });

    const status = await createFacilitatorClient(config).getTransactionStatus("abc123");

    expect(new URL(seen[0].url).pathname).toBe("/transaction/abc123");
    expect(status.successful).toBe(true);
  });

  it("reports health", async () => {
    const seen = stubFetch({ status: "ok", network: "stellar:testnet" });

    await createFacilitatorClient(config).health();

    expect(new URL(seen[0].url).pathname).toBe("/health");
  });

  it("is constructible directly as well as through the factory", () => {
    expect(new FacilitatorClient(config)).toBeInstanceOf(FacilitatorClient);
    expect(createFacilitatorClient(config)).toBeInstanceOf(FacilitatorClient);
  });
});

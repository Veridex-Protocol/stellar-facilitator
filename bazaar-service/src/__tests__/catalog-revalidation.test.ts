import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { CatalogIngestionWorker } from "../catalog/ingestion.js";
import type { LivePaymentTermsResult } from "../catalog/live-payment-terms.js";

const row = {
  id: "00000000-0000-0000-0000-000000000001",
  validation_url: "https://seller.example/weather/london",
  network: "stellar:testnet",
  scheme: "exact",
  asset: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
  pay_to: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  amount: "100000",
};

function workerFor(validation: LivePaymentTermsResult) {
  const queries: Array<{ text: string; params?: unknown[] }> = [];
  const client = {
    query: async (text: string, params?: unknown[]) => {
      queries.push({ text, params });
      return text.includes("SELECT id, validation_url") ? { rows: [row] } : { rows: [] };
    },
    release: () => undefined,
  };
  const pool = {
    connect: async () => client,
    end: async () => undefined,
  } as unknown as Pool;
  return {
    queries,
    worker: new CatalogIngestionWorker(
      { host: "unused", port: 5432, database: "unused", user: "unused", password: "" },
      {
        horizonUrl: "https://horizon.example",
        sorobanRpcUrl: "https://rpc.example",
        pool,
        validateLiveTerms: async () => validation,
      },
    ),
  };
}

describe("periodic catalog revalidation", () => {
  it("refreshes a valid listing without removing it from search", async () => {
    const { worker, queries } = workerFor({ valid: true });

    const result = await worker.revalidateStale({ staleAfterMs: 60_000, limit: 10 });

    expect(result).toEqual({ checked: 1, refreshed: 1, quarantined: 0, failures: {} });
    const update = queries.find(({ text }) => text.includes("last_verified_at = now()"));
    expect(update?.text).toContain("verification_status = 'verified'");
    expect(update?.text).not.toContain("soft_dropped = true");
    expect(update?.params).toEqual([row.id]);
  });

  it.each([
    ["catalog_live_payment_challenge_missing", false],
    ["catalog_live_payment_timeout", true],
  ])("quarantines a stale listing after %s", async (code, retryable) => {
    const { worker, queries } = workerFor({
      valid: false,
      code,
      reason: "resource could not be revalidated",
      retryable,
    });

    const result = await worker.revalidateStale({ staleAfterMs: 60_000 });

    expect(result).toMatchObject({ checked: 1, refreshed: 0, quarantined: 1 });
    expect(result.failures).toEqual({ [code]: 1 });
    const update = queries.find(({ text }) => text.includes("soft_dropped = true"));
    expect(update?.text).toContain("verification_status = 'quarantined'");
    expect(update?.params).toEqual([row.id, `${code}: resource could not be revalidated`]);
  });
});
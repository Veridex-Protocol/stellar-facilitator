import { describe, expect, it } from "vitest";
import { verifySettlement } from "../catalog/settlement-proof.js";

const HORIZON = "https://horizon-testnet.stellar.org";
const TX = "b983f668ab4d2c1e0f9a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e";
const PAY_TO = "GCNNJJV3XUXWCVV3WBKILBCUUGKSDZ2BL4HHNV7AISYMW6PJQX47DZYU";

/**
 * Builds a fetch stub that answers the transaction and effects lookups.
 *
 * @param transaction - Body for the /transactions/:hash call, or null for 404
 * @param effects - Effect records for the /effects call
 * @returns A fetch implementation
 */
function stubFetch(transaction: unknown | null, effects: unknown[] = []) {
  return (async (url: string | URL) => {
    const href = String(url);
    if (href.includes("/effects")) {
      return new Response(JSON.stringify({ _embedded: { records: effects } }), { status: 200 });
    }
    if (transaction === null) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(transaction), { status: 200 });
  }) as unknown as typeof fetch;
}

const RECENT = { successful: true, ledger: 4104581, created_at: new Date().toISOString() };
const CREDITED = [{ type: "account_credited", account: PAY_TO, amount: "0.01" }];

describe("settlement proof", () => {
  it("accepts a successful, recent transaction that credited payTo", async () => {
    const result = await verifySettlement(TX, PAY_TO, {
      horizonUrl: HORIZON,
      fetchImpl: stubFetch(RECENT, CREDITED),
    });
    expect(result).toMatchObject({ valid: true, ledger: 4104581 });
  });

  it("rejects a hash that is not a Stellar transaction hash", async () => {
    const result = await verifySettlement("not-a-hash", PAY_TO, {
      horizonUrl: HORIZON,
      fetchImpl: stubFetch(RECENT, CREDITED),
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/not a Stellar transaction hash/);
  });

  it("rejects a transaction that does not exist", async () => {
    // The exact case the conformance harness probes: an entry naming an
    // all-zeros hash must not reach the catalog.
    const result = await verifySettlement("0".repeat(64), PAY_TO, {
      horizonUrl: HORIZON,
      fetchImpl: stubFetch(null),
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/does not exist on this network/);
  });

  it("rejects a transaction the network rejected", async () => {
    const result = await verifySettlement(TX, PAY_TO, {
      horizonUrl: HORIZON,
      fetchImpl: stubFetch({ ...RECENT, successful: false }, CREDITED),
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/the network rejected it/);
  });

  it("rejects a settlement that credited someone else", async () => {
    // A real payment to a different account must not let an attacker list a
    // resource under their own payTo.
    const result = await verifySettlement(TX, PAY_TO, {
      horizonUrl: HORIZON,
      fetchImpl: stubFetch(RECENT, [
        { type: "account_credited", account: "GBERBZMV6FCS3PURFN5YQC2U32YXVWXGW343IZ4HI2LRLIAQO2QHUXA4" },
      ]),
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/credited no value to/);
  });

  it("rejects a settlement with no credit effects at all", async () => {
    const result = await verifySettlement(TX, PAY_TO, {
      horizonUrl: HORIZON,
      fetchImpl: stubFetch(RECENT, [{ type: "account_debited", account: PAY_TO }]),
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/credited no value to/);
  });

  it("accepts a contract_credited effect for a contract payTo", async () => {
    const contract = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    const result = await verifySettlement(TX, contract, {
      horizonUrl: HORIZON,
      fetchImpl: stubFetch(RECENT, [{ type: "contract_credited", contract }]),
    });
    expect(result.valid).toBe(true);
  });

  it("rejects a settlement older than the freshness window", async () => {
    const old = { ...RECENT, created_at: new Date(Date.now() - 48 * 3600_000).toISOString() };
    const result = await verifySettlement(TX, PAY_TO, {
      horizonUrl: HORIZON,
      fetchImpl: stubFetch(old, CREDITED),
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/older than 24h/);
  });

  it("does not list anything when Horizon is unreachable", async () => {
    // Failing closed matters here: an outage must not become an open catalog.
    const result = await verifySettlement(TX, PAY_TO, {
      horizonUrl: HORIZON,
      fetchImpl: (async () => {
        throw new Error("fetch failed");
      }) as unknown as typeof fetch,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/could not be reached/);
  });

  it("requires a matching Settled event for upto catalog proof", async () => {
    const contractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
    const token = "CBUSYNQKASUYFWYC3M2GUEDMX4AIVWPALDBYJPNK6554BREHTGZ2IUNF";
    const resultDigest = "sha256:" + "b".repeat(64);
    const event = {
      contractId,
      topics: ["settled", "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGO6V", PAY_TO, "settlement-id"],
      data: {
        token,
        max_amount: 1000n,
        actual: 375n,
        result_digest: Buffer.from("b".repeat(64), "hex"),
      },
    };
    const proofOptions = {
      horizonUrl: HORIZON,
      scheme: "upto",
      uptoContractId: contractId,
      expectedToken: token,
      expectedMaxAmount: "1000",
      expectedActual: "375",
      expectedResultDigest: resultDigest,
      fetchImpl: stubFetch(RECENT, CREDITED),
      fetchUptoTransaction: async () => ({
        status: "SUCCESS",
        ledger: 4104581,
        createdAt: RECENT.created_at,
        events: [event],
      }),
    } as const;

    await expect(verifySettlement(TX, PAY_TO, proofOptions)).resolves.toMatchObject({ valid: true });
    await expect(verifySettlement(TX, PAY_TO, {
      ...proofOptions,
      expectedResultDigest: "sha256:" + "c".repeat(64),
    })).resolves.toMatchObject({ valid: false, reason: expect.stringMatching(/result digest/) });
  });
});

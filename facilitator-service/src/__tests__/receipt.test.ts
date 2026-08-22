import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  canonicalClaimBytes,
  computeSha256Digest,
  generateJobReceipt,
  verifyJobReceipt,
  type JobReceipt,
} from "../stellar/receipt.js";

/**
 * Issues a receipt with sensible defaults.
 *
 * @param overrides - Fields to replace
 * @returns The receipt and the signer that issued it
 */
function issue(overrides: Record<string, unknown> = {}) {
  const signer = Keypair.random();
  const receipt = generateJobReceipt({
    serviceUrl: "https://facilitator.example",
    jobId: "oracle/read",
    requestBody: { feed: "XLM/USD", mode: "oracle" },
    resultBody: { feedId: "XLM/USD", value: "0.12345", blockNumber: 123456 },
    txHash: "b983f668ab4d2c1e0f9a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e",
    payer: "GCNNJJV3XUXWCVV3WBKILBCUUGKSDZ2BL4HHNV7AISYMW6PJQX47DZYU",
    asset: "CC7AMNLQWIEKWMSGKXC7DFEXHDTNMQ6JL2BBPRBM6RQXYZXCNKD75CVB",
    amount: "50000",
    network: "stellar:testnet",
    signerSecretKey: signer.secret(),
    signerPublicKey: signer.publicKey(),
    ...overrides,
  } as any);
  return { signer, receipt };
}

describe("x402job/1 recomputable compute receipts (#3117)", () => {
  it("generates and verifies a receipt with matching digests", () => {
    const request = { feed: "XLM/USD", mode: "oracle" };
    const result = { feedId: "XLM/USD", value: "0.12345", blockNumber: 123456 };
    const { receipt } = issue();

    expect(receipt.claims.v).toBe("x402job/1");
    expect(receipt.claims.requestDigest).toBe(computeSha256Digest(request));
    expect(receipt.claims.resultDigest).toBe(computeSha256Digest(result));

    expect(verifyJobReceipt(receipt, request, result)).toMatchObject({
      valid: true,
      requestDigestMatches: true,
      resultDigestMatches: true,
      signatureValid: true,
    });
  });

  // ── The bug this file exists to prevent recurring ──────────────────────────
  //
  // The signature previously covered `JSON.stringify(claims,
  // Object.keys(claims).sort())`. The array replacer is an allowlist applied at
  // every level, so `settlement` — whose keys are absent from the top-level key
  // list — serialized as `{}`. Every field below could be rewritten at will
  // while the signature stayed valid.

  it("covers settlement.tx: rewriting the transaction hash breaks the signature", () => {
    const { receipt } = issue();
    const forged: JobReceipt = {
      ...receipt,
      claims: {
        ...receipt.claims,
        settlement: { ...receipt.claims.settlement, tx: "0000000000000000000000000000000000000000000000000000000000000000" },
      },
    };
    expect(verifyJobReceipt(forged, { feed: "XLM/USD", mode: "oracle" }, {
      feedId: "XLM/USD",
      value: "0.12345",
      blockNumber: 123456,
    }).signatureValid).toBe(false);
  });

  it("covers settlement.amount: inflating the amount breaks the signature", () => {
    const { receipt } = issue();
    const forged: JobReceipt = {
      ...receipt,
      claims: {
        ...receipt.claims,
        settlement: { ...receipt.claims.settlement, amount: "999999999" },
      },
    };
    expect(verifyJobReceipt(forged, { feed: "XLM/USD", mode: "oracle" }, {
      feedId: "XLM/USD",
      value: "0.12345",
      blockNumber: 123456,
    }).signatureValid).toBe(false);
  });

  it("covers settlement.payer, asset and network", () => {
    const request = { feed: "XLM/USD", mode: "oracle" };
    const result = { feedId: "XLM/USD", value: "0.12345", blockNumber: 123456 };
    const { receipt } = issue();

    for (const [field, value] of [
      ["payer", "GBERBZMV6FCS3PURFN5YQC2U32YXVWXGW343IZ4HI2LRLIAQO2QHUXA4"],
      ["asset", "CBEWVAYRO7ZAZDU4QI54ZBQEJPWFT6UCZ25X4L3KE4AFP25NSSICTG73"],
      ["network", "stellar:pubnet"],
    ] as const) {
      const forged: JobReceipt = {
        ...receipt,
        claims: {
          ...receipt.claims,
          settlement: { ...receipt.claims.settlement, [field]: value },
        },
      };
      expect(
        verifyJobReceipt(forged, request, result).signatureValid,
        `signature must not survive a rewritten settlement.${field}`,
      ).toBe(false);
    }
  });

  it("gives different signed bytes to receipts differing only in nested settlement", () => {
    const { receipt } = issue();
    const other = {
      ...receipt.claims,
      settlement: { ...receipt.claims.settlement, tx: "different", amount: "1" },
    };
    expect(canonicalClaimBytes(receipt.claims)).not.toBe(canonicalClaimBytes(other));
  });

  it("digests nested request bodies rather than collapsing them", () => {
    const a = { x402Version: 2, accepted: { amount: "1", payTo: "GA" }, payload: { transaction: "XDR_A" } };
    const b = { x402Version: 2, accepted: { amount: "9999", payTo: "GEVIL" }, payload: { transaction: "XDR_B" } };
    expect(computeSha256Digest(a)).not.toBe(computeSha256Digest(b));
  });

  it("detects a tampered result body", () => {
    const request = { feed: "XLM/USD", mode: "oracle" };
    const { receipt } = issue();
    const verification = verifyJobReceipt(receipt, request, { feedId: "XLM/USD", value: "9.99999" });
    expect(verification.valid).toBe(false);
    expect(verification.resultDigestMatches).toBe(false);
  });

  it("verifies against re-canonicalized claims, not the bytes the receipt carries", () => {
    // A forger who rewrites the claims and leaves a matching canonicalClaims
    // string behind must still fail, because verification never trusts it.
    const { receipt } = issue();
    const forgedClaims = {
      ...receipt.claims,
      settlement: { ...receipt.claims.settlement, amount: "1" },
    };
    const forged: JobReceipt = {
      claims: forgedClaims,
      signature: receipt.signature,
      canonicalClaims: canonicalClaimBytes(receipt.claims),
    };
    expect(verifyJobReceipt(forged, { feed: "XLM/USD", mode: "oracle" }, {
      feedId: "XLM/USD",
      value: "0.12345",
      blockNumber: 123456,
    }).signatureValid).toBe(false);
  });

  it("refuses to issue a receipt with an unknown settlement field", () => {
    expect(() => issue({ payer: "" })).toThrow(/settlement field 'payer' is unknown/);
    expect(() => issue({ asset: "" })).toThrow(/settlement field 'asset' is unknown/);
  });

  it("refuses to issue a receipt whose signing key is not the advertised signer", () => {
    expect(() => issue({ signerPublicKey: Keypair.random().publicKey() })).toThrow(
      /Receipt signer mismatch/,
    );
  });

  it("refuses to issue an unsigned receipt", () => {
    expect(() => issue({ signerSecretKey: "" })).toThrow(/without a signing key/);
  });

  it("digests a raw string body as its own bytes", () => {
    expect(computeSha256Digest("hello")).toBe(computeSha256Digest("hello"));
    expect(computeSha256Digest("hello")).not.toBe(computeSha256Digest('"hello"'));
  });
});

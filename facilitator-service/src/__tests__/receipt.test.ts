import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { generateJobReceipt, verifyJobReceipt, computeSha256Digest } from "../stellar/receipt.js";

describe("x402job/1 recomputable compute receipts (#3117)", () => {
  it("generates and verifies a valid signed receipt with matching digests", () => {
    const signer = Keypair.random();
    const req = { feed: "XLM/USD", mode: "oracle" };
    const res = { feedId: "XLM/USD", value: "0.12345", blockNumber: 123456 };

    const receipt = generateJobReceipt({
      serviceUrl: "https://facilitator.veridex.io",
      jobId: "oracle/read",
      requestBody: req,
      resultBody: res,
      txHash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      payer: "GBOTN25T3HPF6UKAYX5EO7BE3HGGLPNMV4GEWV75PRL6I7NFDHQSQD3Q",
      asset: "USDC",
      amount: "50000",
      network: "stellar:testnet",
      signerSecretKey: signer.secret(),
      signerPublicKey: signer.publicKey(),
    });

    expect(receipt.claims.v).toBe("x402job/1");
    expect(receipt.claims.requestDigest).toBe(computeSha256Digest(req));
    expect(receipt.claims.resultDigest).toBe(computeSha256Digest(res));

    const verification = verifyJobReceipt(receipt, req, res);
    expect(verification.valid).toBe(true);
    expect(verification.requestDigestMatches).toBe(true);
    expect(verification.resultDigestMatches).toBe(true);
    expect(verification.signatureValid).toBe(true);
  });

  it("detects tampered result body during receipt verification", () => {
    const signer = Keypair.random();
    const req = { feed: "XLM/USD" };
    const res = { feedId: "XLM/USD", value: "0.12345" };

    const receipt = generateJobReceipt({
      serviceUrl: "https://facilitator.veridex.io",
      jobId: "oracle/read",
      requestBody: req,
      resultBody: res,
      txHash: "0x123",
      payer: "GBOTN...",
      asset: "USDC",
      amount: "50000",
      network: "stellar:testnet",
      signerSecretKey: signer.secret(),
      signerPublicKey: signer.publicKey(),
    });

    const tamperedRes = { feedId: "XLM/USD", value: "9.99999" };
    const verification = verifyJobReceipt(receipt, req, tamperedRes);

    expect(verification.valid).toBe(false);
    expect(verification.resultDigestMatches).toBe(false);
  });
});

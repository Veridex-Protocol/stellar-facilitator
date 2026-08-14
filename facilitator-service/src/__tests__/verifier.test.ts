/**
 * Veridex Facilitator Service - Verifier & Settler Tests
 * License: Apache-2.0
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import { StellarTransactionVerifier } from "../stellar/verifier.js";
import type { StellarNetworkConfig, X402StellarRequest } from "../stellar/types.js";

describe("StellarTransactionVerifier", () => {
  let verifier: StellarTransactionVerifier;
  let facilitatorKeypair: Keypair;
  let config: StellarNetworkConfig;

  beforeEach(() => {
    facilitatorKeypair = Keypair.random();
    config = {
      network: "testnet",
      networkPassphrase: Networks.TESTNET,
      horizonUrl: "https://horizon-testnet.stellar.org",
      rpcUrl: "https://soroban-testnet.stellar.org",
      facilitatorPublicKey: facilitatorKeypair.publicKey(),
      facilitatorSecretKey: facilitatorKeypair.secret(),
    };
    verifier = new StellarTransactionVerifier(config);
  });

  it("should fail validation on network mismatch", async () => {
    const request: X402StellarRequest = {
      scheme: "stellar",
      network: "pubnet",
      resourceServer: Keypair.random().publicKey(),
      transactionXdr: "AAAA...",
    };

    const result = await verifier.verify(request, "1000000");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Network mismatch");
  });

  it("should validate facilitator public key configuration", () => {
    expect(config.facilitatorPublicKey).toBeDefined();
    expect(config.facilitatorPublicKey.startsWith("G")).toBe(true);
  });

  it("should convert XLM to stroops correctly", () => {
    // Access private method via test casting or test helpers
    const stroops = (verifier as any).xlmToStroops("0.1");
    expect(stroops).toBe(1_000_000);
  });

  it("should convert stroops to XLM correctly", () => {
    const xlm = verifier.stroopsToXlm(10_000_000);
    expect(xlm).toBe("1.0000000");
  });
});

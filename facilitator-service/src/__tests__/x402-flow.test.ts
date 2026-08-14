/**
 * Veridex Facilitator Service - x402 Flow Integration Tests
 * License: Apache-2.0
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import { ChannelAccountPool } from "../channel/pool.js";
import { X402Facilitator } from "../stellar/x402-facilitator.js";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { STELLAR_TESTNET_CAIP2 } from "@x402/stellar";

describe("x402 Flow Integration", () => {
  let channelPool: ChannelAccountPool;
  let x402Facilitator: X402Facilitator;
  let facilitatorKeypair: Keypair;

  beforeEach(() => {
    facilitatorKeypair = Keypair.random();

    channelPool = new ChannelAccountPool({
      poolSize: 2,
      networkPassphrase: Networks.TESTNET,
      horizonUrl: "https://horizon-testnet.stellar.org",
      sourceSecretKey: facilitatorKeypair.secret(),
      cooldownMs: 1000,
      channelStartingBalance: "5",
      refillThreshold: "2",
      refillAmount: "3",
    });

    x402Facilitator = new X402Facilitator({
      channelPool,
      networkPassphrase: Networks.TESTNET,
      feeBumpSignerSecret: facilitatorKeypair.secret(),
      rpcUrl: "https://horizon-testnet.stellar.org",
    });
  });

  it("should identify supported networks correctly", () => {
    expect(x402Facilitator.supported(STELLAR_TESTNET_CAIP2 as any)).toBe(true);
    expect(x402Facilitator.schemeId).toBe("exact");
  });

  it("should reject invalid payment payloads gracefully during verification", async () => {
    const invalidRequirements: PaymentRequirements = {
      scheme: "exact",
      network: STELLAR_TESTNET_CAIP2 as any,
      asset: "native",
      amount: "1000000",
      payTo: Keypair.random().publicKey(),
      maxTimeoutSeconds: 60,
      extra: {},
    };

    const invalidPayload: PaymentPayload = {
      x402Version: 2,
      accepted: invalidRequirements,
      payload: {
        transaction: "INVALID_BASE64_XDR",
      },
    };

    const result = await x402Facilitator.verify(invalidPayload, invalidRequirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBeDefined();
  });

  it("should handle legacy requests and convert them to x402 payloads", async () => {
    const legacyReq = {
      scheme: "stellar" as const,
      network: "testnet",
      resourceServer: Keypair.random().publicKey(),
      transactionXdr: "AAAAAG...",
    };

    const res = await x402Facilitator.verifyLegacy(legacyReq, "1000000");
    expect(res).toBeDefined();
    expect(res.valid).toBe(false); // Invalid XDR, expected
  });
});

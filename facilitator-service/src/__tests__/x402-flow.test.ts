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

const ASSET = "CC7AMNLQWIEKWMSGKXC7DFEXHDTNMQ6JL2BBPRBM6RQXYZXCNKD75CVB";

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
      areFeesSponsored: false,
      rpcUrl: "https://soroban-testnet.stellar.org",
    });
  });

  it("identifies supported networks correctly", () => {
    expect(x402Facilitator.supported(STELLAR_TESTNET_CAIP2 as any)).toBe(true);
    expect(x402Facilitator.schemeId).toBe("exact");
  });

  it("rejects an invalid payment payload with a reason, not an exception", async () => {
    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: STELLAR_TESTNET_CAIP2 as any,
      asset: ASSET,
      amount: "1000000",
      payTo: Keypair.random().publicKey(),
      maxTimeoutSeconds: 60,
      extra: {},
    };

    const payload: PaymentPayload = {
      x402Version: 2,
      accepted: requirements,
      payload: { transaction: "INVALID_BASE64_XDR" },
    };

    const result = await x402Facilitator.verify(payload, requirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBeDefined();
    expect(result.invalidReason).not.toBe("");
  });

  it("only advertises fee sponsorship once it has been turned on deliberately", () => {
    // Sponsorship used to be inferred from "a secret key is configured", which
    // is always true. It is now an explicit, separately established fact.
    expect(x402Facilitator.areFeesSponsored).toBe(false);
    expect(x402Facilitator.getExtra(STELLAR_TESTNET_CAIP2 as any)).toMatchObject({
      areFeesSponsored: false,
    });

    x402Facilitator.setFeeSponsorship(true);

    expect(x402Facilitator.areFeesSponsored).toBe(true);
    expect(x402Facilitator.getExtra(STELLAR_TESTNET_CAIP2 as any)).toMatchObject({
      areFeesSponsored: true,
    });
  });
});

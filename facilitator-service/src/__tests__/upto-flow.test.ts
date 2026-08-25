/**
 * Veridex Facilitator Service - Upto Scheme Flow & Routing Tests
 * License: Apache-2.0
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import { ChannelAccountPool } from "../channel/pool.js";
import { X402Facilitator } from "../stellar/x402-facilitator.js";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { STELLAR_TESTNET_CAIP2 } from "@x402/stellar";

const ASSET = "CC7AMNLQWIEKWMSGKXC7DFEXHDTNMQ6JL2BBPRBM6RQXYZXCNKD75CVB";
const UPTO_CONTRACT = "CAHV6TIAOVSICUJHI6OBZSW2N5ZKRPGKHE2SH6OAEJHPHCLF5DXWAGG2";

describe("Upto Scheme Flow & Routing", () => {
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
      areFeesSponsored: true,
      rpcUrl: "https://soroban-testnet.stellar.org",
    });
  });

  it("routes exact scheme by default and does not advertise upto without contract", () => {
    expect(x402Facilitator.supportedSchemes).toEqual(["exact"]);
  });

  it("rejects upto verification when upto contract is not configured", async () => {
    const requirements: PaymentRequirements = {
      scheme: "upto",
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
      payload: { transaction: "DUMMY_XDR" },
    };

    const result = await x402Facilitator.verify(payload, requirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("upto_scheme_not_configured");
  });

  it("enables upto routing and verification when contract is configured", async () => {
    x402Facilitator.setUptoContract(UPTO_CONTRACT);
    expect(x402Facilitator.supportedSchemes).toContain("upto");

    const requirements: PaymentRequirements = {
      scheme: "upto",
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
    // It should route to UptoStellarScheme and fail with malformed payload, not unsupported_scheme
    expect(result.invalidReason).toBe("invalid_upto_stellar_payload_malformed");
  });

  it("rejects unsupported scheme with unsupported_scheme error", async () => {
    const requirements: PaymentRequirements = {
      scheme: "unsupported_xyz" as any,
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
      payload: { transaction: "DUMMY" },
    };

    const result = await x402Facilitator.verify(payload, requirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("unsupported_scheme");

    const settleResult = await x402Facilitator.settle(payload, requirements);
    expect(settleResult.success).toBe(false);
    expect(settleResult.errorReason).toBe("unsupported_scheme");
  });
});

/**
 * Veridex Facilitator Service - Upto Scheme Flow & Routing Tests
 * License: Apache-2.0
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import { ChannelAccountPool } from "../channel/pool.js";
import { X402Facilitator } from "../stellar/x402-facilitator.js";
import { UptoStellarScheme } from "../stellar/upto-scheme.js";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { STELLAR_TESTNET_CAIP2 } from "@x402/stellar";

const ASSET = "CC7AMNLQWIEKWMSGKXC7DFEXHDTNMQ6JL2BBPRBM6RQXYZXCNKD75CVB";
const UPTO_CONTRACT = "CAHV6TIAOVSICUJHI6OBZSW2N5ZKRPGKHE2SH6OAEJHPHCLF5DXWAGG2";

function contractStruct(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  return xdr.ScVal.scvMap(
    Object.keys(fields).sort().map((key) => new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol(key),
      val: fields[key],
    })),
  );
}

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

  it("extracts the facilitator authorized by the payer before scheduling", () => {
    const payer = Keypair.random();
    const facilitator = Keypair.random();
    const fakeSigner = {
      address: facilitator.publicKey(),
      signAuthEntry: async () => ({ signedAuthEntry: "" }),
      signTransaction: async () => "",
    } as any;
    const terms = contractStruct({
      pay_to: new Address(Keypair.random().publicKey()).toScVal(),
      token: new Address(ASSET).toScVal(),
      max_amount: nativeToScVal(1_000_000n, { type: "i128" }),
      valid_after: nativeToScVal(1, { type: "u32" }),
      deadline: nativeToScVal(100, { type: "u32" }),
      facilitator: new Address(facilitator.publicKey()).toScVal(),
      settlement_id: xdr.ScVal.scvBytes(Buffer.alloc(32)),
      request_digest: xdr.ScVal.scvBytes(Buffer.alloc(32)),
    });
    const attestation = contractStruct({
      settlement_id: xdr.ScVal.scvBytes(Buffer.alloc(32)),
      actual: nativeToScVal(0n, { type: "i128" }),
      result_digest: xdr.ScVal.scvBytes(Buffer.alloc(32)),
    });
    const operation = Operation.invokeHostFunction({
      func: xdr.HostFunction.hostFunctionTypeInvokeContract(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(UPTO_CONTRACT).toScAddress(),
          functionName: "settle",
          args: [new Address(payer.publicKey()).toScVal(), terms, attestation],
        }),
      ),
      auth: [],
    });
    const transaction = new TransactionBuilder(
      new Account(facilitator.publicKey(), "1"),
      { fee: "100", networkPassphrase: Networks.TESTNET },
    ).addOperation(operation).setTimeout(60).build();
    const scheme = new UptoStellarScheme([fakeSigner], { contractId: UPTO_CONTRACT });
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
      payload: { transaction: transaction.toXDR() },
    };

    expect(scheme.getAuthorizedFacilitator(payload, requirements)).toBe(facilitator.publicKey());
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

/**
 * Experimental Stellar `upto` client scheme for x402 v2.
 * License: Apache-2.0
 */

import { randomBytes } from "node:crypto";
import {
  Account,
  Address,
  Contract,
  Networks,
  TransactionBuilder,
  authorizeEntry,
  nativeToScVal,
  rpc,
  StrKey,
  xdr,
} from "@stellar/stellar-sdk";
import type { PaymentPayloadResult, PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import type { ClientStellarSigner } from "@x402/stellar";

export interface UptoStellarClientOptions {
  signer: ClientStellarSigner;
  contractId?: string;
  rpcUrl?: string;
  validityLedgers?: number;
}

const DEFAULT_RPC_URL = "https://soroban-testnet.stellar.org";
const DEFAULT_VALIDITY_LEDGERS = 100;
const BASE_FEE = "1000000";

function struct(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  const entries = Object.keys(fields).sort().map((key) => new xdr.ScMapEntry({
    key: xdr.ScVal.scvSymbol(key),
    val: fields[key],
  }));
  return xdr.ScVal.scvMap(entries);
}

function networkPassphrase(network: string): string {
  if (network === "stellar:testnet") return Networks.TESTNET;
  if (network === "stellar:pubnet") return Networks.PUBLIC;
  throw new Error(`upto does not support network ${network}`);
}

function digestBytes(value: string): xdr.ScVal {
  if (!/^sha256:[0-9a-f]{64}$/i.test(value)) throw new Error("upto requires a sha256 requestDigest");
  return xdr.ScVal.scvBytes(Buffer.from(value.slice("sha256:".length), "hex"));
}

export class UptoStellarClientScheme implements SchemeNetworkClient {
  readonly scheme = "upto";

  constructor(private readonly options: UptoStellarClientOptions) {}

  async createPaymentPayload(x402Version: number, requirements: PaymentRequirements): Promise<PaymentPayloadResult> {
    if (x402Version !== 2 || requirements.scheme !== "upto") {
      throw new Error("upto client requires x402 v2 upto payment requirements");
    }
    const extra = requirements.extra ?? {};
    if (extra.areFeesSponsored !== true) {
      throw new Error("upto requires a facilitator that sponsors transaction fees");
    }
    const contractId = this.options.contractId ?? extra.contractId;
    const facilitator = extra.facilitator;
    const requestDigest = extra.requestDigest;
    if (typeof contractId !== "string" || !StrKey.isValidContract(contractId)) {
      throw new Error("upto payment requirements must advertise a valid contractId");
    }
    if (typeof facilitator !== "string" || !StrKey.isValidEd25519PublicKey(facilitator)) {
      throw new Error("upto payment requirements must advertise a facilitator signer");
    }
    if (typeof requestDigest !== "string") throw new Error("upto payment requirements must advertise requestDigest");

    const passphrase = networkPassphrase(requirements.network);
    const rpcUrl = this.options.rpcUrl ?? (
      requirements.network === "stellar:testnet" ? DEFAULT_RPC_URL : undefined
    );
    if (!rpcUrl) throw new Error("upto pubnet requires an explicit Soroban RPC URL");
    const server = new rpc.Server(rpcUrl);
    const latest = await server.getLatestLedger();
    const validAfter = Math.max(0, latest.sequence - 1);
    const deadline = latest.sequence + (this.options.validityLedgers ?? DEFAULT_VALIDITY_LEDGERS);
    const settlementId = randomBytes(32);
    const payer = this.options.signer.address;

    // The facilitator is the transaction source. The payer remains an explicit
    // Soroban authorization entry and signs only its bounded terms.
    const source = await server.getAccount(facilitator);
    const terms = struct({
      pay_to: new Address(requirements.payTo).toScVal(),
      token: new Address(requirements.asset).toScVal(),
      max_amount: nativeToScVal(BigInt(requirements.amount), { type: "i128" }),
      valid_after: nativeToScVal(validAfter, { type: "u32" }),
      deadline: nativeToScVal(deadline, { type: "u32" }),
      facilitator: new Address(facilitator).toScVal(),
      settlement_id: xdr.ScVal.scvBytes(settlementId),
      request_digest: digestBytes(requestDigest),
    });
    const placeholderAttestation = struct({
      settlement_id: xdr.ScVal.scvBytes(settlementId),
      actual: nativeToScVal(0n, { type: "i128" }),
      result_digest: xdr.ScVal.scvBytes(Buffer.alloc(32)),
    });
    const transaction = new TransactionBuilder(new Account(facilitator, source.sequenceNumber()), {
      fee: BASE_FEE,
      networkPassphrase: passphrase,
    })
      .addOperation(new Contract(contractId).call("settle", new Address(payer).toScVal(), terms, placeholderAttestation))
      .setTimeout(180)
      .build();
    const simulated = await server.simulateTransaction(transaction);
    if (rpc.Api.isSimulationError(simulated)) throw new Error(`upto simulation failed: ${simulated.error}`);

    const payerAuth = (simulated.result?.auth ?? []).find((entry) => {
      if (entry.credentials().switch() !== xdr.SorobanCredentialsType.sorobanCredentialsAddress()) return false;
      return Address.fromScAddress(entry.credentials().address().address()).toString() === payer;
    });
    if (!payerAuth) throw new Error("upto simulation did not return a payer authorization entry");
    const signedPayerAuth = await authorizeEntry(payerAuth, async (preimage) => {
      const signed = await this.options.signer.signAuthEntry(preimage.toXDR("base64"), {
        networkPassphrase: passphrase,
        address: payer,
      });
      if (signed.error) throw signed.error;
      return Buffer.from(signed.signedAuthEntry, "base64");
    }, deadline, passphrase);

    const envelope = transaction.toEnvelope();
    // The facilitator signs its attestation after the provider response is known.
    envelope.v1().tx().operations()[0].body().invokeHostFunctionOp().auth([signedPayerAuth]);
    return { x402Version, payload: { transaction: envelope.toXDR("base64") } };
  }
}

export function createUptoStellarClient(options: UptoStellarClientOptions): UptoStellarClientScheme {
  return new UptoStellarClientScheme(options);
}

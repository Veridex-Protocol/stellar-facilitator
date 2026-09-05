/**
 * Veridex Facilitator Service - Upto Scheme Implementation
 * License: Apache-2.0
 *
 * Implements verification and settlement for the Stellar `upto` scheme against
 * the Soroban `upto-settlement` contract (see scheme_upto_stellar.md).
 *
 * The payer authorizes terms with require_auth_for_args covering ceiling, recipient,
 * token, validity window, and request digest.
 * The facilitator attests and signs the actual amount charged and result digest.
 */

import {
  Account,
  Address,
  BASE_FEE,
  FeeBumpTransaction,
  Operation,
  SignerKey,
  Transaction,
  TransactionBuilder,
  authorizeEntry,
  hash,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { Api } from "@stellar/stellar-sdk/rpc";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import {
  getEstimatedLedgerCloseTimeSeconds,
  getNetworkPassphrase,
  getRpcClient,
  isStellarNetwork,
  STELLAR_WILDCARD_CAIP2,
  gatherAuthEntrySignatureStatus,
  type FacilitatorStellarSigner,
  type RpcConfig,
} from "@x402/stellar";

const DEFAULT_TIMEOUT_SECONDS = 60;
const SUPPORTED_X402_VERSION = 2;
const DEFAULT_MAX_TRANSACTION_FEE_STROOPS = 1_000_000;
const SIGNATURE_EXPIRATION_LEDGER_TOLERANCE = 2;

export interface UptoFacilitatorOptions {
  contractId: string;
  rpcConfig?: RpcConfig;
  areFeesSponsored?: boolean;
  maxTransactionFeeStroops?: number;
  selectSigner?: (addresses: readonly string[]) => string;
  feeBumpSigner?: FacilitatorStellarSigner;
}

export interface ParsedUptoTerms {
  payer: string;
  payTo: string;
  token: string;
  maxAmount: bigint;
  validAfter: number;
  deadline: number;
  facilitator: string;
  settlementId: Buffer;
  requestDigest: Buffer;
}

export interface ParsedUptoAttestation {
  settlementId: Buffer;
  actual: bigint;
  resultDigest: Buffer;
}

function struct(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  const entries = Object.keys(fields)
    .sort()
    .map((key) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val: fields[key] }));
  return xdr.ScVal.scvMap(entries);
}

const addrVal = (value: string) => new Address(value).toScVal();
const i128Val = (value: bigint | number | string) => nativeToScVal(BigInt(value), { type: "i128" });
const u32Val = (value: number) => nativeToScVal(value, { type: "u32" });
const bytes32Val = (buf: Uint8Array | Buffer) => xdr.ScVal.scvBytes(Buffer.from(buf));

export class UptoStellarScheme implements SchemeNetworkFacilitator {
  readonly scheme = "upto";
  readonly caipFamily = STELLAR_WILDCARD_CAIP2;

  public readonly contractId: string;
  public readonly signingAddresses: ReadonlySet<string>;
  public readonly areFeesSponsored: boolean;
  public readonly rpcConfig?: RpcConfig;
  public readonly maxTransactionFeeStroops: number;
  public readonly feeBumpSigner?: FacilitatorStellarSigner;
  private readonly signerMap: Map<string, FacilitatorStellarSigner>;
  private readonly selectSigner: (addresses: readonly string[]) => string;

  constructor(
    signers: FacilitatorStellarSigner[],
    options: UptoFacilitatorOptions,
  ) {
    if (!signers || signers.length === 0) {
      throw new Error("At least one signer is required for UptoStellarScheme");
    }
    this.contractId = options.contractId;
    this.signerMap = new Map(signers.map((s) => [s.address, s]));
    this.signingAddresses = new Set(this.signerMap.keys());
    this.rpcConfig = options.rpcConfig;
    this.areFeesSponsored = options.areFeesSponsored ?? true;
    this.maxTransactionFeeStroops =
      options.maxTransactionFeeStroops ?? DEFAULT_MAX_TRANSACTION_FEE_STROOPS;
    this.selectSigner = options.selectSigner ?? ((addrs) => addrs[0]);
    this.feeBumpSigner = options.feeBumpSigner;
  }

  getExtra(_: Network): Record<string, unknown> | undefined {
    return {
      contractId: this.contractId,
      areFeesSponsored: this.areFeesSponsored,
    };
  }

  getSigners(_: string): string[] {
    const signers = [...this.signingAddresses];
    if (this.feeBumpSigner && !this.signingAddresses.has(this.feeBumpSigner.address)) {
      signers.push(this.feeBumpSigner.address);
    }
    return signers;
  }

  getAuthorizedFacilitator(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): string | undefined {
    try {
      if (payload.accepted.scheme !== "upto" || requirements.scheme !== "upto") return undefined;
      const stellarPayload = payload.payload as { transaction?: string };
      if (typeof stellarPayload.transaction !== "string") return undefined;
      const transaction = new Transaction(
        stellarPayload.transaction,
        getNetworkPassphrase(requirements.network),
      );
      if (transaction.operations.length !== 1 || transaction.operations[0].type !== "invokeHostFunction") return undefined;
      const invokeOp = transaction.operations[0] as Operation.InvokeHostFunction;
      const func = invokeOp.func;
      if (!func || func.switch().name !== "hostFunctionTypeInvokeContract") return undefined;
      const invokeContractArgs = func.invokeContract();
      if (Address.fromScAddress(invokeContractArgs.contractAddress()).toString() !== this.contractId) return undefined;
      if (invokeContractArgs.functionName().toString() !== "settle") return undefined;
      const rawArgs = invokeContractArgs.args();
      if (rawArgs.length < 2) return undefined;
      const terms = scValToNative(rawArgs[1]) as Record<string, unknown>;
      return typeof terms.facilitator === "string" ? terms.facilitator : undefined;
    } catch {
      return undefined;
    }
  }

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const result = await this._verify(payload, requirements);
    return result.response;
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const server = getRpcClient(requirements.network, this.rpcConfig);
    const networkPassphrase = getNetworkPassphrase(requirements.network);
    let payer: string | undefined;
    let txHash: string | undefined;

    try {
      // 1. Verify before settlement
      const { response: verifyResult, parsedTerms, simResponse } = await this._verify(
        payload,
        requirements,
      );

      if (!verifyResult.isValid || !parsedTerms) {
        return {
          success: false,
          network: payload.accepted.network,
          transaction: "",
          errorReason: verifyResult.invalidReason ?? "verification_failed",
          payer: verifyResult.payer,
        };
      }

      payer = verifyResult.payer!;

      // 2. Select signer account from pool
      const selectedSignerAddress = this.selectSigner([...this.signingAddresses]);
      if (selectedSignerAddress !== parsedTerms.facilitator) {
        return {
          success: false,
          network: payload.accepted.network,
          transaction: "",
          errorReason: "settle_upto_stellar_facilitator_selection_mismatch",
          payer,
        };
      }
      const signer = this.signerMap.get(selectedSignerAddress);
      if (!signer) {
        return {
          success: false,
          network: payload.accepted.network,
          transaction: "",
          errorReason: "settle_upto_stellar_signer_selection_failed",
          payer,
        };
      }

      const facilitatorAccount = await server.getAccount(signer.address);
      const sourceSequence = facilitatorAccount.sequenceNumber();

      // 3. Determine actual amount and result digest
      // Actual charged amount defaults to requirements.amount or payload settlement metadata
      const actualAmount = BigInt(requirements.amount);
      if (actualAmount < 0n) {
        return {
          success: false,
          network: payload.accepted.network,
          transaction: "",
          errorReason: "invalid_upto_actual_amount",
          payer,
        };
      }
      if (actualAmount > parsedTerms.maxAmount) {
        return {
          success: false,
          network: payload.accepted.network,
          transaction: "",
          errorReason: "invalid_upto_actual_exceeds_maximum",
          payer,
        };
      }

      const resultDigest = this.readResultDigest(payload, parsedTerms);
      if (!resultDigest) {
        return {
          success: false,
          network: payload.accepted.network,
          transaction: "",
          errorReason: "settle_upto_missing_result_digest",
          payer,
        };
      }

      // 4. Build contract invocation args
      const termsVal = struct({
        pay_to: addrVal(parsedTerms.payTo),
        token: addrVal(parsedTerms.token),
        max_amount: i128Val(parsedTerms.maxAmount),
        valid_after: u32Val(parsedTerms.validAfter),
        deadline: u32Val(parsedTerms.deadline),
        facilitator: addrVal(parsedTerms.facilitator),
        settlement_id: bytes32Val(parsedTerms.settlementId),
        request_digest: bytes32Val(parsedTerms.requestDigest),
      });

      const attestationVal = struct({
        settlement_id: bytes32Val(parsedTerms.settlementId),
        actual: i128Val(actualAmount),
        result_digest: bytes32Val(resultDigest),
      });

      const contractAddr = new Address(this.contractId);
      const invokeOp = Operation.invokeHostFunction({
        func: xdr.HostFunction.hostFunctionTypeInvokeContract(
          new xdr.InvokeContractArgs({
            contractAddress: contractAddr.toScAddress(),
            functionName: "settle",
            args: [addrVal(payer), termsVal, attestationVal],
          }),
        ),
        auth: [],
      });

      // 5. Build preliminary transaction for auth signing & simulation
      const initialTx = new TransactionBuilder(new Account(signer.address, sourceSequence), {
        fee: BASE_FEE,
        networkPassphrase,
      })
        .setTimeout(requirements.maxTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS)
        .addOperation(invokeOp)
        .build();

      const initialSim = await server.simulateTransaction(initialTx);
      if (!rpc.Api.isSimulationSuccess(initialSim)) {
        return {
          success: false,
          network: payload.accepted.network,
          transaction: "",
          errorReason: "settle_upto_simulation_failed",
          payer,
        };
      }

      // 6. Authorize auth entries: preserve payer's existing auth and sign facilitator's auth
      const stellarPayload = payload.payload as { transaction: string };
      const clientTx = new Transaction(stellarPayload.transaction, networkPassphrase);
      const clientAuthEntries = (clientTx.operations[0] as Operation.InvokeHostFunction).auth || [];

      const signedAuthEntries = await Promise.all(
        (initialSim.result?.auth ?? []).map(async (entry) => {
          if (
            entry.credentials().switch() !==
            xdr.SorobanCredentialsType.sorobanCredentialsAddress()
          ) {
            return entry;
          }
          const authAddr = Address.fromScAddress(
            entry.credentials().address().address(),
          ).toString();

          // If this entry belongs to payer, find client's signed entry
          if (authAddr === payer) {
            const matchingClientAuth = clientAuthEntries.find(
              (cAuth) =>
                cAuth.credentials().switch() ===
                  xdr.SorobanCredentialsType.sorobanCredentialsAddress() &&
                Address.fromScAddress(cAuth.credentials().address().address()).toString() === payer,
            );
            if (matchingClientAuth) return matchingClientAuth;
          }

          // If this entry belongs to facilitator, sign it with facilitator's key
          if (this.signingAddresses.has(authAddr) || authAddr === signer.address) {
            return authorizeEntry(
              entry,
              async (preimage) => {
                const signed = await signer.signAuthEntry(preimage.toXDR("base64"), {
                  networkPassphrase,
                  address: signer.address,
                });
                if (signed.error) throw signed.error;
                return Buffer.from(signed.signedAuthEntry, "base64");
              },
              parsedTerms.deadline,
              networkPassphrase,
            );
          }

          return entry;
        }),
      );

      // 7. Assemble rebuilt transaction with refreshed soroban resource data
      const finalOp = Operation.invokeHostFunction({
        func: invokeOp.body().invokeHostFunctionOp().hostFunction(),
        auth: signedAuthEntries,
      });

      const authorizedTx = new TransactionBuilder(new Account(signer.address, sourceSequence), {
        fee: BASE_FEE,
        networkPassphrase,
      })
        .setTimeout(requirements.maxTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS)
        .addOperation(finalOp)
        .build();

      // The unsigned verification simulation does not include the nonce
      // ledger entries needed by the now-signed auth entries. Re-simulate the
      // assembled authorization and build the final footprint from that
      // result, as required for a submit-ready Soroban transaction.
      const preparedSim = await server.simulateTransaction(authorizedTx);
      if (!rpc.Api.isSimulationSuccess(preparedSim)) {
        return {
          success: false,
          network: payload.accepted.network,
          transaction: "",
          errorReason: "settle_upto_simulation_failed",
          errorMessage: preparedSim.error,
          payer,
        };
      }
      const preparedTx = rpc.assembleTransaction(authorizedTx, preparedSim).build();
      const rebuiltTx = this.applyAuthEntries(preparedTx, signedAuthEntries, networkPassphrase);

      // 8. Sign transaction envelope
      const { signedTxXdr, error: signError } = await signer.signTransaction(rebuiltTx.toXDR(), {
        networkPassphrase,
      });

      if (signError) {
        return {
          success: false,
          network: payload.accepted.network,
          transaction: "",
          errorReason: "settle_upto_stellar_transaction_signing_failed",
          payer,
        };
      }

      // 9. Submit transaction
      let txToSubmit: Transaction | FeeBumpTransaction;
      if (this.feeBumpSigner) {
        const signedInnerTx = TransactionBuilder.fromXDR(signedTxXdr, networkPassphrase) as Transaction;
        const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
          this.feeBumpSigner.address,
          BASE_FEE,
          signedInnerTx,
          networkPassphrase,
        );
        const { signedTxXdr: signedFeeBumpXdr, error: feeBumpSignError } =
          await this.feeBumpSigner.signTransaction(feeBumpTx.toXDR(), { networkPassphrase });
        if (feeBumpSignError) {
          return {
            success: false,
            network: payload.accepted.network,
            transaction: "",
            errorReason: "settle_upto_stellar_fee_bump_signing_failed",
            payer,
          };
        }
        txToSubmit = TransactionBuilder.fromXDR(signedFeeBumpXdr, networkPassphrase) as FeeBumpTransaction;
      } else {
        txToSubmit = TransactionBuilder.fromXDR(signedTxXdr, networkPassphrase) as Transaction;
      }

      const sendResult = await server.sendTransaction(txToSubmit);
      if (sendResult.status !== "PENDING") {
        const detail = "errorResult" in sendResult
          ? JSON.stringify(sendResult.errorResult)
          : `status=${sendResult.status}`;
        return {
          success: false,
          network: payload.accepted.network,
          transaction: sendResult.hash || "",
          errorReason: "settle_upto_stellar_transaction_submission_failed",
          errorMessage: detail,
          payer,
        };
      }

      txHash = sendResult.hash;
      const maxPollAttempts = requirements.maxTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
      const confirmResult = await this.pollForTransaction(server, txHash, maxPollAttempts);

      if (!confirmResult.success) {
        return {
          success: false,
          network: payload.accepted.network,
          transaction: txHash,
          errorReason: "settle_upto_stellar_transaction_failed",
          payer,
        };
      }

      return {
        success: true,
        transaction: txHash,
        network: payload.accepted.network,
        payer,
      };
    } catch (error) {
      console.error("Unexpected upto settlement error:", error);
      return {
        success: false,
        network: payload.accepted.network,
        transaction: txHash || "",
        errorReason: "unexpected_settle_error",
        payer,
      };
    }
  }

  private async _verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<{
    response: VerifyResponse;
    parsedTerms?: ParsedUptoTerms;
    simResponse?: rpc.Api.SimulateTransactionSuccessResponse;
  }> {
    let fromAddress: string | undefined;

    try {
      // 1. Version, scheme, network validation
      if (payload.x402Version !== SUPPORTED_X402_VERSION) {
        return { response: { isValid: false, invalidReason: "invalid_x402_version" } };
      }
      if (payload.accepted.scheme !== "upto" || requirements.scheme !== "upto") {
        return { response: { isValid: false, invalidReason: "unsupported_scheme" } };
      }
      if (requirements.network !== payload.accepted.network) {
        return { response: { isValid: false, invalidReason: "network_mismatch" } };
      }
      if (!isStellarNetwork(requirements.network)) {
        return { response: { isValid: false, invalidReason: "invalid_network" } };
      }

      const networkPassphrase = getNetworkPassphrase(requirements.network);
      const server = getRpcClient(requirements.network, this.rpcConfig);

      // 2. Decode payload transaction XDR
      const stellarPayload = payload.payload as { transaction?: string };
      if (!stellarPayload || typeof stellarPayload.transaction !== "string") {
        return {
          response: { isValid: false, invalidReason: "invalid_upto_stellar_payload_malformed" },
        };
      }

      let transaction: Transaction;
      try {
        transaction = new Transaction(stellarPayload.transaction, networkPassphrase);
      } catch (error) {
        return {
          response: { isValid: false, invalidReason: "invalid_upto_stellar_payload_malformed" },
        };
      }

      // 3. Validate transaction structure
      if (transaction.operations.length !== 1) {
        return {
          response: { isValid: false, invalidReason: "invalid_upto_stellar_payload_wrong_operation" },
        };
      }

      const operation = transaction.operations[0];
      if (operation.type !== "invokeHostFunction") {
        return {
          response: { isValid: false, invalidReason: "invalid_upto_stellar_payload_wrong_operation" },
        };
      }

      const invokeOp = operation as Operation.InvokeHostFunction;
      const func = invokeOp.func;
      if (!func || func.switch().name !== "hostFunctionTypeInvokeContract") {
        return {
          response: { isValid: false, invalidReason: "invalid_upto_stellar_payload_wrong_operation" },
        };
      }

      const invokeContractArgs = func.invokeContract();
      const contractAddress = Address.fromScAddress(invokeContractArgs.contractAddress()).toString();
      const functionName = invokeContractArgs.functionName().toString();

      if (contractAddress !== this.contractId) {
        return {
          response: { isValid: false, invalidReason: "invalid_upto_stellar_wrong_contract" },
        };
      }

      if (functionName !== "settle") {
        return {
          response: { isValid: false, invalidReason: "invalid_upto_stellar_wrong_function" },
        };
      }

      const rawArgs = invokeContractArgs.args();
      if (rawArgs.length < 2) {
        return {
          response: { isValid: false, invalidReason: "invalid_upto_stellar_payload_malformed" },
        };
      }

      // 4. Parse terms
      fromAddress = scValToNative(rawArgs[0]) as string;
      const termsObj = scValToNative(rawArgs[1]) as Record<string, any>;

      const parsedTerms: ParsedUptoTerms = {
        payer: fromAddress,
        payTo: typeof termsObj.pay_to === "string" ? termsObj.pay_to : String(termsObj.pay_to),
        token: typeof termsObj.token === "string" ? termsObj.token : String(termsObj.token),
        maxAmount: BigInt(termsObj.max_amount),
        validAfter: Number(termsObj.valid_after),
        deadline: Number(termsObj.deadline),
        facilitator:
          typeof termsObj.facilitator === "string"
            ? termsObj.facilitator
            : String(termsObj.facilitator),
        settlementId: Buffer.isBuffer(termsObj.settlement_id)
          ? termsObj.settlement_id
          : Buffer.from(termsObj.settlement_id || []),
        requestDigest: Buffer.isBuffer(termsObj.request_digest)
          ? termsObj.request_digest
          : Buffer.from(termsObj.request_digest || []),
      };

      // 5. Validate terms vs requirements
      if (this.signingAddresses.has(fromAddress)) {
        return {
          response: {
            isValid: false,
            invalidReason: "invalid_upto_stellar_facilitator_is_payer",
          },
        };
      }

      if (parsedTerms.payTo !== requirements.payTo) {
        return {
          response: {
            isValid: false,
            invalidReason: "invalid_upto_stellar_wrong_recipient",
            payer: fromAddress,
          },
        };
      }

      if (parsedTerms.token !== requirements.asset) {
        return {
          response: {
            isValid: false,
            invalidReason: "invalid_upto_stellar_wrong_asset",
            payer: fromAddress,
          },
        };
      }

      // During response-aware settlement, x402 may pass an effective amount
      // override in `requirements.amount`. The payer's signed ceiling remains
      // the amount in `payload.accepted`; compare the parsed terms to that
      // original authorization, not the metered charge.
      const expectedAmount = BigInt(payload.accepted.amount);
      if (parsedTerms.maxAmount !== expectedAmount) {
        return {
          response: {
            isValid: false,
            invalidReason: "invalid_upto_stellar_wrong_max_amount",
            payer: fromAddress,
          },
        };
      }

      // Check facilitator designation
      if (!this.signingAddresses.has(parsedTerms.facilitator)) {
        return {
          response: {
            isValid: false,
            invalidReason: "invalid_upto_stellar_wrong_facilitator",
            payer: fromAddress,
          },
        };
      }

      // Check ledger validity bounds
      const latestLedger = await server.getLatestLedger();
      const currentLedger = latestLedger.sequence;
      if (currentLedger < parsedTerms.validAfter) {
        return {
          response: {
            isValid: false,
            invalidReason: "invalid_upto_stellar_not_yet_valid",
            payer: fromAddress,
          },
        };
      }
      if (currentLedger > parsedTerms.deadline) {
        return {
          response: {
            isValid: false,
            invalidReason: "invalid_upto_stellar_signature_expired",
            payer: fromAddress,
          },
        };
      }

      // 6. Simulation & auth entry verification
      // Soroban treats a partially authorized transaction as an attempted
      // invocation and can return InvalidAction instead of describing the
      // remaining auth entries. Simulate an equivalent envelope without auth
      // entries, then compare the returned payer entry with the signed entry
      // carried by the client payload below.
      const simulationTransaction = this.withoutAuthEntries(transaction, networkPassphrase);
      const simResponse = await server.simulateTransaction(simulationTransaction);
      if (!rpc.Api.isSimulationSuccess(simResponse)) {
        return {
          response: {
            isValid: false,
            invalidReason: "invalid_upto_stellar_simulation_failed",
            payer: fromAddress,
          },
        };
      }

      // Check fee ceiling
      const minResourceFee = parseInt(simResponse.minResourceFee, 10);
      const settlementFeeStroops = minResourceFee + parseInt(BASE_FEE, 10);
      if (settlementFeeStroops > this.maxTransactionFeeStroops) {
        return {
          response: {
            isValid: false,
            invalidReason: "invalid_upto_stellar_fee_exceeds_maximum",
            payer: fromAddress,
          },
        };
      }

      // 7. Validate auth entries
      const authValidation = this.validateAuthEntries(
        invokeOp,
        fromAddress,
        parsedTerms.deadline,
        transaction,
        simResponse,
      );
      if (authValidation) {
        return { response: authValidation };
      }

      return {
        response: { isValid: true, payer: fromAddress },
        parsedTerms,
        simResponse,
      };
    } catch (error) {
      console.error("Unexpected upto verification error:", error);
      return {
        response: {
          isValid: false,
          invalidReason: "unexpected_verify_error",
          payer: fromAddress,
        },
      };
    }
  }

  private validateAuthEntries(
    invokeOp: Operation.InvokeHostFunction,
    fromAddress: string,
    maxLedger: number,
    transaction: Transaction,
    simResponse: rpc.Api.SimulateTransactionSuccessResponse,
  ): VerifyResponse | undefined {
    if (!invokeOp.auth || invokeOp.auth.length === 0) {
      return {
        isValid: false,
        invalidReason: "invalid_upto_stellar_no_auth_entries",
        payer: fromAddress,
      };
    }

    for (const auth of invokeOp.auth) {
      const credentialsType = auth.credentials().switch();
      if (credentialsType !== xdr.SorobanCredentialsType.sorobanCredentialsAddress()) {
        return {
          isValid: false,
          invalidReason: "invalid_upto_stellar_unsupported_credential_type",
          payer: fromAddress,
        };
      }

      const addressCredentials = auth.credentials().address();
      const authAddress = Address.fromScAddress(addressCredentials.address()).toString();

      if (this.signingAddresses.has(authAddress)) {
        return {
          isValid: false,
          invalidReason: "invalid_upto_stellar_facilitator_in_auth",
          payer: fromAddress,
        };
      }

      const expirationLedger = addressCredentials.signatureExpirationLedger();
      if (expirationLedger > maxLedger + SIGNATURE_EXPIRATION_LEDGER_TOLERANCE) {
        return {
          isValid: false,
          invalidReason: "invalid_upto_stellar_expiration_too_far",
          payer: fromAddress,
        };
      }
    }

    const authStatus = gatherAuthEntrySignatureStatus({
      transaction,
      simulationResponse: simResponse,
    });

    if (!authStatus.alreadySigned.includes(fromAddress)) {
      return {
        isValid: false,
        invalidReason: "invalid_upto_stellar_missing_payer_signature",
        payer: fromAddress,
      };
    }

    return undefined;
  }

  private withoutAuthEntries(transaction: Transaction, networkPassphrase: string): Transaction {
    return this.applyAuthEntries(transaction, [], networkPassphrase);
  }

  private applyAuthEntries(
    transaction: Transaction,
    auth: xdr.SorobanAuthorizationEntry[],
    networkPassphrase: string,
  ): Transaction {
    const envelope = transaction.toEnvelope();
    envelope.v1().tx().operations()[0].body().invokeHostFunctionOp().auth(auth);
    return TransactionBuilder.fromXDR(envelope.toXDR("base64"), networkPassphrase) as Transaction;
  }

  private async pollForTransaction(
    server: rpc.Server,
    txHash: string,
    maxPollAttempts = 15,
    delayMs = 1000,
  ): Promise<{ success: boolean }> {
    for (let i = 0; i < maxPollAttempts; i++) {
      try {
        const txResult = await server.getTransaction(txHash);
        if (txResult.status === "SUCCESS") {
          return { success: true };
        } else if (txResult.status === "FAILED") {
          return { success: false };
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      } catch (error: unknown) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return { success: false };
  }

  private readResultDigest(
    payload: PaymentPayload,
    parsedTerms: ParsedUptoTerms,
  ): Buffer | undefined {
    const encoded = (payload.payload as { resultDigest?: unknown }).resultDigest;
    if (typeof encoded !== "string" || !/^sha256:[0-9a-f]{64}$/i.test(encoded)) {
      return undefined;
    }
    const digest = Buffer.from(encoded.slice("sha256:".length), "hex");
    return digest.length === 32 ? digest : undefined;
  }
}

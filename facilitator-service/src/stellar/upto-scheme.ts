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
  Address,
  Api,
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
const bytes32Val = (buf: Uint8Array | Buffer) => xdr.ScVal.scvBytes(buf);

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
      const signer = this.signerMap.get(this.selectSigner([...this.signingAddresses]));
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

      // 3. Determine actual amount and result digest
      // Actual charged amount defaults to requirements.amount or payload settlement metadata
      const actualAmount = BigInt(requirements.amount);
      if (actualAmount > parsedTerms.maxAmount) {
        return {
          success: false,
          network: payload.accepted.network,
          transaction: "",
          errorReason: "invalid_upto_actual_exceeds_maximum",
          payer,
        };
      }

      const resultDigest = parsedTerms.requestDigest; // Use request digest or computed output digest

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
      const initialTx = new TransactionBuilder(facilitatorAccount, {
        fee: BASE_FEE,
        networkPassphrase,
      })
        .setTimeout(requirements.maxTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS)
        .addOperation(invokeOp)
        .build();

      const initialSim = await server.simulateTransaction(initialTx);
      if (!Api.isSimulationSuccess(initialSim)) {
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
                const preimageHash = hash(preimage.toXDR());
                const sig = await signer.sign(preimageHash);
                return sig;
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
        func: invokeOp.func,
        auth: signedAuthEntries,
      });

      const sorobanData = initialSim.transactionData.build();

      const rebuiltTx = new TransactionBuilder(facilitatorAccount, {
        fee: BASE_FEE,
        networkPassphrase,
        sorobanData,
      })
        .setTimeout(requirements.maxTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS)
        .addOperation(finalOp)
        .build();

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
      if (sendResult.status !== "PENDING" && sendResult.status !== "SUCCESS") {
        return {
          success: false,
          network: payload.accepted.network,
          transaction: sendResult.hash || "",
          errorReason: "settle_upto_stellar_transaction_submission_failed",
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
    simResponse?: Api.SimulateTransactionSuccessResponse;
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

      const expectedAmount = BigInt(requirements.amount);
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
      const simResponse = await server.simulateTransaction(transaction);
      if (!Api.isSimulationSuccess(simResponse)) {
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
    simResponse: Api.SimulateTransactionSuccessResponse,
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
}

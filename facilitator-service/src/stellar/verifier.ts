/**
 * Veridex Facilitator Service - Stellar Transaction Verifier
 * License: Apache-2.0
 *
 * Verifies x402 Stellar transactions before settlement:
 * - Validates transaction structure
 * - Checks payment operation exists
 * - Verifies destination is facilitator
 * - Validates amount matches resource pricing
 */

import {
  Transaction,
  TransactionBuilder,
  Networks,
  Keypair,
  xdr,
} from "@stellar/stellar-sdk";
import type {
  X402StellarRequest,
  ParsedStellarTransaction,
  VerificationResult,
  StellarNetworkConfig,
} from "./types.js";

/**
 * Stellar Transaction Verifier
 *
 * Validates x402 payment transactions before settlement.
 */
export class StellarTransactionVerifier {
  private config: StellarNetworkConfig;
  private facilitatorPublicKey: string;

  constructor(config: StellarNetworkConfig) {
    this.config = config;
    this.facilitatorPublicKey = config.facilitatorPublicKey;
  }

  /**
   * Verify an x402 Stellar transaction
   *
   * @param request - x402 Stellar request
   * @param expectedAmount - Expected payment amount in stroops (optional)
   * @returns Verification result
   */
  async verify(
    request: X402StellarRequest,
    expectedAmount?: string
  ): Promise<VerificationResult> {
    try {
      // Validate network
      if (request.network !== this.config.network) {
        return {
          valid: false,
          error: `Network mismatch: expected ${this.config.network}, got ${request.network}`,
        };
      }

      // Parse transaction from XDR only after cheap request-level validation.
      const parsed = this.parseTransaction(request.transactionXdr);

      // Validate transaction structure
      const structureCheck = this.validateStructure(parsed);
      if (!structureCheck.valid) {
        return structureCheck;
      }

      // Validate payment operation
      const paymentCheck = this.validatePayment(parsed, expectedAmount);
      if (!paymentCheck.valid) {
        return paymentCheck;
      }

      // Validate signatures (basic check - will be validated by network)
      const signatureCheck = this.validateSignatures(parsed);
      if (!signatureCheck.valid) {
        return signatureCheck;
      }

      return {
        valid: true,
        transaction: parsed,
        expectedAmount,
        facilitatorAccount: this.facilitatorPublicKey,
      };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : "Unknown verification error",
      };
    }
  }

  /**
   * Parse transaction from XDR
   */
  private parseTransaction(transactionXdr: string): ParsedStellarTransaction {
    const transaction = TransactionBuilder.fromXDR(
      transactionXdr,
      this.config.networkPassphrase
    ) as Transaction;

    const operations = transaction.operations.map((op) => {
      const opType = op.type;
      const opData: any = { type: opType };

      // Extract operation-specific data
      if (opType === "payment") {
        opData.destination = (op as any).destination;
        opData.asset = (op as any).asset;
        opData.amount = (op as any).amount;
      } else if (opType === "pathPaymentStrictSend" || opType === "pathPaymentStrictReceive") {
        opData.destination = (op as any).destination;
        opData.sendAsset = (op as any).sendAsset;
        opData.destAsset = (op as any).destAsset;
        opData.sendAmount = (op as any).sendAmount;
        opData.destAmount = (op as any).destAmount;
      }

      return opData;
    });

    let memo: { type: string; value: string } | undefined;
    if (transaction.memo && transaction.memo.type !== "none") {
      memo = {
        type: transaction.memo.type,
        value: transaction.memo.value ? String(transaction.memo.value) : "",
      };
    }

    return {
      sourceAccount: transaction.source,
      sequence: transaction.sequence,
      operations,
      fee: transaction.fee,
      memo,
      transaction,
    };
  }

  /**
   * Validate transaction structure
   */
  private validateStructure(parsed: ParsedStellarTransaction): VerificationResult {
    // Must have at least one operation
    if (parsed.operations.length === 0) {
      return {
        valid: false,
        error: "Transaction has no operations",
      };
    }

    // Fee must be reasonable (< 1 XLM)
    const feeStroops = parseInt(parsed.fee, 10);
    if (feeStroops > 10_000_000) {
      return {
        valid: false,
        error: `Fee too high: ${feeStroops} stroops`,
      };
    }

    return { valid: true };
  }

  /**
   * Validate payment operation
   */
  private validatePayment(
    parsed: ParsedStellarTransaction,
    expectedAmount?: string
  ): VerificationResult {
    // Find payment operation to facilitator
    const paymentOp = parsed.operations.find((op) => {
      if (op.type === "payment") {
        return op.destination === this.facilitatorPublicKey;
      }
      return false;
    });

    if (!paymentOp) {
      return {
        valid: false,
        error: `No payment operation to facilitator (${this.facilitatorPublicKey})`,
      };
    }

    // Validate asset is native XLM
    if (paymentOp.asset && typeof paymentOp.asset === "object" && "code" in paymentOp.asset && (paymentOp.asset as any).code !== undefined) {
      return {
        valid: false,
        error: "Payment must be in native XLM",
      };
    }

    // Validate amount if specified
    if (expectedAmount && paymentOp.amount) {
      const actualStroops = this.xlmToStroops(paymentOp.amount);
      const expectedStroops = parseInt(expectedAmount, 10);

      if (actualStroops < expectedStroops) {
        return {
          valid: false,
          error: `Insufficient payment: ${actualStroops} stroops (expected ${expectedStroops})`,
        };
      }
    }

    return { valid: true };
  }

  /**
   * Validate transaction signatures
   */
  private validateSignatures(parsed: ParsedStellarTransaction): VerificationResult {
    // Check that transaction has at least one signature
    const signatures = parsed.transaction.signatures;

    if (!signatures || signatures.length === 0) {
      return {
        valid: false,
        error: "Transaction has no signatures",
      };
    }

    return { valid: true };
  }

  /**
   * Convert XLM to stroops
   */
  private xlmToStroops(xlm: string): number {
    return Math.floor(parseFloat(xlm) * 10_000_000);
  }

  /**
   * Convert stroops to XLM
   */
  stroopsToXlm(stroops: string | number): string {
    const stroopsNum = typeof stroops === "string" ? parseInt(stroops, 10) : stroops;
    return (stroopsNum / 10_000_000).toFixed(7);
  }
}

/**
 * Create verifier with configuration
 */
export function createVerifier(config: StellarNetworkConfig): StellarTransactionVerifier {
  return new StellarTransactionVerifier(config);
}

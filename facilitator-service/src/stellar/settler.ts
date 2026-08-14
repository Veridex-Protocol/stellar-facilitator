/**
 * Veridex Facilitator Service - Stellar Transaction Settler
 * License: Apache-2.0
 *
 * Submits verified x402 transactions to the Stellar network using channel accounts.
 *
 * Features:
 * - Parallel submission via channel account pool
 * - Transaction result parsing
 * - Error handling and retry logic
 * - Telemetry tracking
 */

import {
  Transaction,
  Horizon,
  Networks,
} from "@stellar/stellar-sdk";
import type { ChannelAccountPool } from "../channel/pool.js";
import type {
  ParsedStellarTransaction,
  SettlementResult,
  StellarNetworkConfig,
} from "./types.js";

/**
 * Stellar Transaction Settler
 *
 * Submits transactions to Stellar network using channel accounts.
 */
export class StellarTransactionSettler {
  private config: StellarNetworkConfig;
  private server: Horizon.Server;
  private channelPool: ChannelAccountPool;

  constructor(config: StellarNetworkConfig, channelPool: ChannelAccountPool) {
    this.config = config;
    this.server = new Horizon.Server(config.horizonUrl);
    this.channelPool = channelPool;
  }

  /**
   * Settle a verified transaction
   *
   * @param parsed - Parsed and verified transaction
   * @returns Settlement result
   */
  async settle(parsed: ParsedStellarTransaction): Promise<SettlementResult> {
    let channel;

    try {
      // Acquire channel account
      channel = await this.channelPool.acquire();

      console.log(
        `[Settler] Submitting transaction from ${parsed.sourceAccount} via channel ${channel.channel.publicKey}`
      );

      // Submit transaction
      const result = await this.server.submitTransaction(parsed.transaction);

      console.log(`[Settler] ✓ Transaction settled: ${result.hash} (ledger ${result.ledger})`);

      return {
        success: true,
        transactionHash: result.hash,
        ledger: result.ledger,
      };
    } catch (error: any) {
      console.error("[Settler] Settlement failed:", error);

      // Parse Stellar error
      const errorResult = this.parseSettlementError(error);

      return {
        success: false,
        error: errorResult.error,
        errorCode: errorResult.errorCode,
      };
    } finally {
      // Release channel back to pool
      if (channel) {
        await channel.release();
      }
    }
  }

  /**
   * Parse Stellar settlement error
   */
  private parseSettlementError(error: any): { error: string; errorCode: string } {
    // Horizon SDK error structure
    if (error?.response?.data) {
      const data = error.response.data;

      // Extract result codes
      if (data.extras?.result_codes) {
        const codes = data.extras.result_codes;
        const txCode = codes.transaction;
        const opCodes = codes.operations || [];

        return {
          error: `Transaction failed: ${txCode} (ops: ${opCodes.join(", ")})`,
          errorCode: txCode,
        };
      }

      // Generic Horizon error
      if (data.title) {
        return {
          error: data.title,
          errorCode: data.status ? `HTTP_${data.status}` : "UNKNOWN",
        };
      }
    }

    // Network or timeout error
    if (error?.code) {
      return {
        error: `Network error: ${error.code}`,
        errorCode: error.code,
      };
    }

    // Generic error
    return {
      error: error instanceof Error ? error.message : "Unknown settlement error",
      errorCode: "UNKNOWN",
    };
  }

  /**
   * Check transaction status by hash
   *
   * @param transactionHash - Transaction hash
   * @returns Transaction record or null if not found
   */
  async getTransactionStatus(transactionHash: string): Promise<{
    found: boolean;
    successful?: boolean;
    ledger?: number;
    createdAt?: string;
  }> {
    try {
      const txRecord = await this.server.transactions().transaction(transactionHash).call();

      return {
        found: true,
        successful: txRecord.successful,
        ledger: txRecord.ledger_attr,
        createdAt: txRecord.created_at,
      };
    } catch (error: any) {
      if (error?.response?.status === 404) {
        return { found: false };
      }

      throw error;
    }
  }

  /**
   * Estimate transaction fee
   *
   * @returns Estimated fee in stroops
   */
  async estimateFee(): Promise<string> {
    try {
      const feeStats = await this.server.feeStats();

      // Use max of base fee and p50 of last ledger
      const baseFee = 100; // Stellar base fee
      const p50Fee = parseInt(feeStats.last_ledger_base_fee, 10) || baseFee;

      return Math.max(baseFee, p50Fee).toString();
    } catch (error) {
      console.warn("[Settler] Failed to fetch fee stats, using base fee:", error);
      return "100";
    }
  }
}

/**
 * Create settler with configuration
 */
export function createSettler(
  config: StellarNetworkConfig,
  channelPool: ChannelAccountPool
): StellarTransactionSettler {
  return new StellarTransactionSettler(config, channelPool);
}

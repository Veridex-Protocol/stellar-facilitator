/**
 * Veridex Facilitator Service - Stellar x402 Types
 * License: Apache-2.0
 *
 * Type definitions for Stellar x402 protocol integration.
 */

import type { Transaction } from "@stellar/stellar-sdk";

/**
 * x402 Stellar Request Format
 *
 * Based on @x402/stellar specification
 */
export interface X402StellarRequest {
  /** x402 scheme identifier */
  scheme: "stellar";

  /** Network identifier (pubnet, testnet, futurenet) */
  network: string;

  /** Resource server public key (G...) */
  resourceServer: string;

  /** XDR-encoded transaction envelope (base64) */
  transactionXdr: string;

  /** Optional metadata */
  metadata?: {
    /** Resource URL being accessed */
    resourceUrl?: string;

    /** Tool name (for MCP resources) */
    toolName?: string;

    /** Session identifier */
    sessionId?: string;
  };
}

/**
 * x402 Stellar Response Format
 */
export interface X402StellarResponse {
  /** Status */
  status: "success" | "error";

  /** Settlement transaction hash (if successful) */
  transactionHash?: string;

  /** Ledger number */
  ledger?: number;

  /** Error message (if failed) */
  error?: string;

  /** Error code */
  errorCode?: string;
}

/**
 * Parsed Stellar transaction for verification
 */
export interface ParsedStellarTransaction {
  /** Source account */
  sourceAccount: string;

  /** Sequence number */
  sequence: string;

  /** Operations */
  operations: Array<{
    type: string;
    destination?: string;
    asset?: string;
    amount?: string;
    [key: string]: any;
  }>;

  /** Fee (stroops) */
  fee: string;

  /** Memo */
  memo?: {
    type: string;
    value: string;
  };

  /** Transaction object */
  transaction: Transaction;
}

/**
 * Settlement verification result
 */
export interface VerificationResult {
  /** Is valid */
  valid: boolean;

  /** Error message if invalid */
  error?: string;

  /** Parsed transaction */
  transaction?: ParsedStellarTransaction;

  /** Expected payment amount (stroops) */
  expectedAmount?: string;

  /** Facilitator destination account */
  facilitatorAccount?: string;
}

/**
 * Settlement result
 */
export interface SettlementResult {
  /** Success flag */
  success: boolean;

  /** Transaction hash */
  transactionHash?: string;

  /** Ledger number */
  ledger?: number;

  /** Error message */
  error?: string;

  /** Error code */
  errorCode?: string;

  /** Diagnostic details / evidence */
  extra?: Record<string, unknown>;
}

/**
 * Stellar network configuration
 */
export interface StellarNetworkConfig {
  /** Network identifier */
  network: "pubnet" | "testnet" | "futurenet";

  /** Network passphrase */
  networkPassphrase: string;

  /** Horizon URL */
  horizonUrl: string;

  /** Soroban RPC URL */
  rpcUrl: string;

  /** Ordered independent Soroban RPC providers. Multi-provider mode is testnet-only until the local coordinator has TLS. */
  rpcUrls?: string[];

  /** Facilitator account public key */
  facilitatorPublicKey: string;

  /** Facilitator account secret key */
  facilitatorSecretKey: string;
}

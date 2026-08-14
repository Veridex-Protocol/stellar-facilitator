/**
 * Veridex Facilitator Service - Channel Account Types
 * License: Apache-2.0
 *
 * Type definitions for Stellar channel account management.
 */

import { Keypair } from "@stellar/stellar-sdk";

/**
 * Channel account state
 */
export enum ChannelAccountState {
  AVAILABLE = "AVAILABLE",
  IN_USE = "IN_USE",
  COOLDOWN = "COOLDOWN",
  ERROR = "ERROR",
}

/**
 * Channel account metadata
 */
export interface ChannelAccount {
  /** Stellar public key (G...) */
  publicKey: string;

  /** Keypair instance (includes secret) */
  keypair: Keypair;

  /** Current state */
  state: ChannelAccountState;

  /** Number of transactions submitted via this channel */
  transactionCount: number;

  /** Last used timestamp (unix milliseconds) */
  lastUsedAt: number;

  /** Current sequence number (for optimistic submission) */
  sequence?: string;

  /** Error message if state is ERROR */
  error?: string;
}

/**
 * Channel pool configuration
 */
export interface ChannelPoolConfig {
  /** Number of channel accounts to maintain */
  poolSize: number;

  /** Network passphrase (pubnet/testnet) */
  networkPassphrase: string;

  /** Horizon server URL */
  horizonUrl: string;

  /** Source account secret key (funds the channels) */
  sourceSecretKey: string;

  /** Durable channel account secrets supplied by the operator */
  channelSecretKeys?: string[];

  /** Permit ephemeral channel generation (development only) */
  autoCreateChannels?: boolean;

  /** Cooldown period after use (milliseconds) */
  cooldownMs: number;

  /** Starting balance for each channel account (XLM) */
  channelStartingBalance: string;

  /** Minimum balance threshold for refill (XLM) */
  refillThreshold: string;

  /** Refill amount (XLM) */
  refillAmount: string;
}

/**
 * Channel acquisition request
 */
export interface ChannelAcquisition {
  /** Acquired channel account */
  channel: ChannelAccount;

  /** Release function to return channel to pool */
  release: () => Promise<void>;
}

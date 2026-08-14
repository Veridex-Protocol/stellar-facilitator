/**
 * Veridex Facilitator Service - Channel Signer Adapter
 * License: Apache-2.0
 *
 * Adapts Veridex ChannelAccountPool to x402 FacilitatorStellarSigner interface.
 * This allows x402 to use channel accounts for parallel transaction submission.
 */

import { Keypair } from "@stellar/stellar-sdk";
import { basicNodeSigner, SignAuthEntry, SignTransaction } from "@stellar/stellar-sdk/contract";
import type { FacilitatorStellarSigner } from "@x402/stellar";
import type { ChannelAccountPool } from "../channel/pool.js";

/**
 * Creates FacilitatorStellarSigners from a ChannelAccountPool.
 *
 * Each channel account becomes a separate signer that x402 can select from
 * using round-robin or custom selection strategies.
 *
 * @param pool - The channel account pool
 * @param networkPassphrase - Stellar network passphrase (e.g., "Test SDF Network ; September 2015")
 * @returns Array of FacilitatorStellarSigners (one per channel account)
 */
export function createSignersFromChannelPool(
  pool: ChannelAccountPool,
  networkPassphrase: string,
): FacilitatorStellarSigner[] {
  const channels = pool.getAllChannels();

  return channels.map((channel) => {
    const kp = channel.keypair;
    const { signAuthEntry, signTransaction } = basicNodeSigner(kp, networkPassphrase);

    return {
      address: channel.publicKey,
      signAuthEntry,
      signTransaction,
    };
  });
}

/**
 * Creates a single FacilitatorStellarSigner from a secret key.
 *
 * Used for the fee bump signer (sponsor account).
 *
 * @param secretKey - Stellar secret key (S...)
 * @param networkPassphrase - Stellar network passphrase
 * @returns FacilitatorStellarSigner
 */
export function createSignerFromSecret(
  secretKey: string,
  networkPassphrase: string,
): FacilitatorStellarSigner {
  const kp = Keypair.fromSecret(secretKey);
  const { signAuthEntry, signTransaction } = basicNodeSigner(kp, networkPassphrase);

  return {
    address: kp.publicKey(),
    signAuthEntry,
    signTransaction,
  };
}

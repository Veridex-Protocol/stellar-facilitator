/**
 * Veridex Facilitator Service - x402 Integration Wrapper
 * License: Apache-2.0
 *
 * Bridges the Veridex channel pool to the canonical `ExactStellarScheme` from
 * `@x402/stellar`. All protocol cryptography — authorization-entry validation,
 * transaction assembly, submission — belongs to that package. This wrapper owns
 * signer selection and nothing else.
 *
 * `areFeesSponsored` is a constructor input rather than something inferred from
 * whether a key happens to be configured. Holding a secret key does not mean
 * the account behind it is funded, and `/supported` advertises this value to
 * clients as a fact. `startup.ts` establishes it against Horizon before the
 * server binds; see `FacilitatorService.start()`.
 */

import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";
import { isStellarNetwork } from "@x402/stellar";
import type { FacilitatorStellarSigner } from "@x402/stellar";
import type {
  PaymentPayload,
  PaymentRequirements,
  VerifyResponse,
  SettleResponse,
  Network,
} from "@x402/core/types";
import type { ChannelAccountPool } from "../channel/pool.js";
import {
  createSignersFromChannelPool,
  createSignerFromSecret,
} from "./channel-signer-adapter.js";

export interface X402FacilitatorConfig {
  /** Channel account pool for parallel transaction submission. */
  channelPool: ChannelAccountPool;

  /** Network passphrase (e.g. "Test SDF Network ; September 2015"). */
  networkPassphrase: string;

  /** Secret key of the account that sponsors network fees. */
  feeBumpSignerSecret?: string;

  /**
   * Whether this deployment actually sponsors fees. Advertised verbatim on
   * `/supported`, so it must be established against the network, not assumed.
   */
  areFeesSponsored: boolean;

  /** Soroban RPC URL. */
  rpcUrl?: string;

  /** Ceiling on the network fee this facilitator will sponsor, in stroops. */
  maxTransactionFeeStroops?: number;
}

export class X402Facilitator {
  private scheme: ExactStellarScheme;
  private config: X402FacilitatorConfig;

  constructor(config: X402FacilitatorConfig) {
    this.config = config;
    this.scheme = this.buildScheme();
  }

  /**
   * Rebuilds the scheme from current configuration and pool state.
   *
   * @returns The configured scheme
   * @throws {Error} When no signer is available
   */
  private buildScheme(): ExactStellarScheme {
    const poolSigners = createSignersFromChannelPool(
      this.config.channelPool,
      this.config.networkPassphrase,
    );

    let feeBumpSigner: FacilitatorStellarSigner | undefined;
    if (this.config.feeBumpSignerSecret) {
      feeBumpSigner = createSignerFromSecret(
        this.config.feeBumpSignerSecret,
        this.config.networkPassphrase,
      );
    }

    const signers = poolSigners.length > 0 ? poolSigners : feeBumpSigner ? [feeBumpSigner] : [];
    if (signers.length === 0) {
      throw new Error("No signers available for X402Facilitator");
    }

    return new ExactStellarScheme(signers, {
      areFeesSponsored: this.config.areFeesSponsored,
      maxTransactionFeeStroops: this.config.maxTransactionFeeStroops,
      feeBumpSigner: this.config.areFeesSponsored ? feeBumpSigner : undefined,
      rpcConfig: this.config.rpcUrl ? { url: this.config.rpcUrl } : undefined,
    });
  }

  /**
   * Rebuilds the scheme after the channel pool has initialized.
   */
  public refreshSigners(): void {
    this.scheme = this.buildScheme();
  }

  /**
   * Sets whether this deployment sponsors fees and rebuilds the scheme.
   *
   * Called once at startup with the result of the Horizon funding check.
   *
   * @param enabled - Whether the sponsoring account is funded and will pay fees
   */
  public setFeeSponsorship(enabled: boolean): void {
    this.config.areFeesSponsored = enabled;
    this.scheme = this.buildScheme();
  }

  /** Whether this deployment currently claims fee sponsorship. */
  public get areFeesSponsored(): boolean {
    return this.config.areFeesSponsored;
  }

  /**
   * Verifies a payment payload against its requirements.
   *
   * @param payload - x402 payment payload
   * @param requirements - Payment requirements
   * @returns The scheme's verification response
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    return this.scheme.verify(payload, requirements);
  }

  /**
   * Settles a payment by submitting it to the Stellar network.
   *
   * @param payload - x402 payment payload
   * @param requirements - Payment requirements
   * @returns The scheme's settlement response
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    return this.scheme.settle(payload, requirements);
  }

  /**
   * Whether a network is served here.
   *
   * @param network - CAIP-2 network identifier
   * @returns True when supported
   */
  supported(network?: Network): boolean {
    if (!network) return true;
    return isStellarNetwork(network);
  }

  /**
   * Scheme metadata for `/supported`.
   *
   * @param network - CAIP-2 network identifier
   * @returns The `extra` block, including `areFeesSponsored`
   */
  getExtra(network: Network): Record<string, unknown> | undefined {
    return this.scheme.getExtra(network);
  }

  /**
   * Signer addresses for `/supported`.
   *
   * @param network - CAIP-2 network identifier
   * @returns Addresses that may appear as the source of a settlement
   */
  getSigners(network: string): string[] {
    return this.scheme.getSigners(network);
  }

  /** The scheme identifier this facilitator implements. */
  get schemeId(): string {
    return this.scheme.scheme;
  }
}

/**
 * Creates an x402 facilitator wrapper.
 *
 * @param config - Facilitator configuration
 * @returns The wrapper
 */
export function createX402Facilitator(config: X402FacilitatorConfig): X402Facilitator {
  return new X402Facilitator(config);
}

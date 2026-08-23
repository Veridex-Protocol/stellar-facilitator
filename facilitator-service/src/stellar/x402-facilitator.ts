/**
 * Veridex Facilitator Service - x402 Integration Wrapper
 * License: Apache-2.0
 *
 * Bridges the Veridex channel pool to canonical scheme implementations:
 *  - `ExactStellarScheme` from `@x402/stellar`
 *  - `UptoStellarScheme` for metered Soroban contract settlement
 *
 * All protocol cryptography - authorization-entry validation, transaction
 * assembly, submission - belongs to the respective scheme modules. This wrapper
 * owns multi-scheme routing, signer leasing, and concurrency scheduling.
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
import { SettleScheduler } from "../settle-scheduler.js";
import {
  createSignersFromChannelPool,
  createSignerFromSecret,
} from "./channel-signer-adapter.js";
import { UptoStellarScheme } from "./upto-scheme.js";

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

  /** How long a settlement may wait for a free signer before being refused. */
  settleQueueTimeoutMs?: number;

  /** Deployed Soroban upto settlement contract ID (if enabled). */
  uptoContractId?: string;
}

export class X402Facilitator {
  private exactScheme: ExactStellarScheme;
  private uptoScheme?: UptoStellarScheme;
  private config: X402FacilitatorConfig;
  /**
   * Serializes settlement per signer account. Stellar gives each account one
   * sequence number, so two concurrent settlements from the same account race
   * for it and one loses. See settle-scheduler.ts.
   */
  private readonly scheduler: SettleScheduler;

  constructor(config: X402FacilitatorConfig) {
    this.config = config;
    this.scheduler = new SettleScheduler([], config.settleQueueTimeoutMs ?? 30_000);
    this.buildSchemes();
    this.scheduler.setSigners([...this.exactScheme.signingAddresses]);
  }

  /**
   * Rebuilds scheme handlers from current configuration and pool state.
   *
   * @throws {Error} When no signer is available
   */
  private buildSchemes(): void {
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

    this.exactScheme = new ExactStellarScheme(signers, {
      areFeesSponsored: this.config.areFeesSponsored,
      maxTransactionFeeStroops: this.config.maxTransactionFeeStroops,
      feeBumpSigner: this.config.areFeesSponsored ? feeBumpSigner : undefined,
      rpcConfig: this.config.rpcUrl ? { url: this.config.rpcUrl } : undefined,
      selectSigner: this.scheduler.selectSigner,
    });

    if (this.config.uptoContractId) {
      this.uptoScheme = new UptoStellarScheme(signers, {
        contractId: this.config.uptoContractId,
        areFeesSponsored: this.config.areFeesSponsored,
        maxTransactionFeeStroops: this.config.maxTransactionFeeStroops,
        feeBumpSigner: this.config.areFeesSponsored ? feeBumpSigner : undefined,
        rpcConfig: this.config.rpcUrl ? { url: this.config.rpcUrl } : undefined,
        selectSigner: this.scheduler.selectSigner,
      });
    } else {
      this.uptoScheme = undefined;
    }
  }

  /**
   * Rebuilds the schemes after the channel pool has initialized.
   */
  public refreshSigners(): void {
    this.buildSchemes();
    this.scheduler.setSigners([...this.exactScheme.signingAddresses]);
  }

  /**
   * Sets or unsets the deployed upto settlement contract and updates routing.
   *
   * @param contractId - Deployed Soroban contract address or undefined
   */
  public setUptoContract(contractId?: string): void {
    this.config.uptoContractId = contractId;
    this.buildSchemes();
  }

  /**
   * Sets whether this deployment sponsors fees and rebuilds schemes.
   *
   * Called once at startup with the result of the Horizon funding check.
   *
   * @param enabled - Whether the sponsoring account is funded and will pay fees
   */
  public setFeeSponsorship(enabled: boolean): void {
    this.config.areFeesSponsored = enabled;
    this.buildSchemes();
    this.scheduler.setSigners([...this.exactScheme.signingAddresses]);
  }

  /** Whether this deployment currently claims fee sponsorship. */
  public get areFeesSponsored(): boolean {
    return this.config.areFeesSponsored;
  }

  /**
   * Routes payment verification to the appropriate scheme handler.
   *
   * @param payload - x402 payment payload
   * @param requirements - Payment requirements
   * @returns The selected scheme's verification response
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const scheme = requirements?.scheme || payload?.accepted?.scheme;

    if (scheme === "exact") {
      return this.exactScheme.verify(payload, requirements);
    }

    if (scheme === "upto") {
      if (!this.uptoScheme) {
        return {
          isValid: false,
          invalidReason: "upto_scheme_not_configured",
        };
      }
      return this.uptoScheme.verify(payload, requirements);
    }

    return {
      isValid: false,
      invalidReason: "unsupported_scheme",
    };
  }

  /**
   * Routes payment settlement to the appropriate scheme handler.
   *
   * @param payload - x402 payment payload
   * @param requirements - Payment requirements
   * @returns The selected scheme's settlement response
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const scheme = requirements?.scheme || payload?.accepted?.scheme;

    if (scheme === "exact") {
      return this.scheduler.withSigner(() => this.exactScheme.settle(payload, requirements));
    }

    if (scheme === "upto") {
      if (!this.uptoScheme) {
        return {
          success: false,
          network: payload?.accepted?.network || "stellar:testnet",
          transaction: "",
          errorReason: "upto_scheme_not_configured",
        };
      }
      return this.scheduler.withSigner(() => this.uptoScheme!.settle(payload, requirements));
    }

    return {
      success: false,
      network: payload?.accepted?.network || "stellar:testnet",
      transaction: "",
      errorReason: "unsupported_scheme",
    };
  }

  /** Settlement concurrency counters, for /stats. */
  getSchedulerStats() {
    return this.scheduler.getStats();
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
    return this.exactScheme.getExtra(network);
  }

  /**
   * Signer addresses for `/supported`.
   *
   * @param network - CAIP-2 network identifier
   * @returns Addresses that may appear as the source of a settlement
   */
  getSigners(network: string): string[] {
    return this.exactScheme.getSigners(network);
  }

  /** Primary scheme identifier this facilitator implements. */
  get schemeId(): string {
    return "exact";
  }

  /** Supported scheme identifiers. */
  get supportedSchemes(): string[] {
    const schemes = ["exact"];
    if (this.uptoScheme) {
      schemes.push("upto");
    }
    return schemes;
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

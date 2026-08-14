/**
 * Veridex Facilitator Service - x402 Integration Wrapper
 * License: Apache-2.0
 *
 * Integrates Veridex facilitator with canonical x402 protocol implementation.
 * Bridges between Veridex's channel pool and x402's ExactStellarScheme.
 */

import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";
import { isStellarNetwork, STELLAR_TESTNET_CAIP2, STELLAR_PUBNET_CAIP2 } from "@x402/stellar";
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
import type {
  X402StellarRequest,
  VerificationResult,
  SettlementResult,
} from "./types.js";

/**
 * x402 Facilitator Configuration
 */
export interface X402FacilitatorConfig {
  /** Channel account pool for parallel transaction submission */
  channelPool: ChannelAccountPool;

  /** Network passphrase (e.g., "Test SDF Network ; September 2015") */
  networkPassphrase: string;

  /** Optional fee bump signer secret key (for fee sponsorship) */
  feeBumpSignerSecret?: string;

  /** Optional RPC URL (defaults based on network) */
  rpcUrl?: string;

  /** Maximum transaction fee in stroops (default: 50,000) */
  maxTransactionFeeStroops?: number;
}

/**
 * Veridex x402 Facilitator Wrapper
 *
 * Provides a high-level interface to x402 protocol using Veridex infrastructure.
 */
export class X402Facilitator {
  private scheme: ExactStellarScheme;
  private networkPassphrase: string;
  private config: X402FacilitatorConfig;

  constructor(config: X402FacilitatorConfig) {
    this.config = config;
    this.networkPassphrase = config.networkPassphrase;

    // Create signers from channel pool
    const signers = createSignersFromChannelPool(config.channelPool, config.networkPassphrase);

    // Create fee bump signer if provided
    let feeBumpSigner: FacilitatorStellarSigner | undefined;
    if (config.feeBumpSignerSecret) {
      feeBumpSigner = createSignerFromSecret(
        config.feeBumpSignerSecret,
        config.networkPassphrase,
      );
    }

    const allSigners = signers.length > 0 ? signers : (feeBumpSigner ? [feeBumpSigner] : []);

    if (allSigners.length === 0) {
      throw new Error("No signers available for X402Facilitator");
    }

    // Initialize x402 ExactStellarScheme
    this.scheme = new ExactStellarScheme(allSigners, {
      areFeesSponsored: !!feeBumpSigner,
      maxTransactionFeeStroops: config.maxTransactionFeeStroops,
      feeBumpSigner,
      rpcConfig: config.rpcUrl
        ? {
            url: config.rpcUrl,
          }
        : undefined,
    });
  }

  /**
   * Refresh signers when channel pool is initialized or updated
   */
  public refreshSigners(): void {
    const signers = createSignersFromChannelPool(this.config.channelPool, this.networkPassphrase);
    let feeBumpSigner: FacilitatorStellarSigner | undefined;
    if (this.config.feeBumpSignerSecret) {
      feeBumpSigner = createSignerFromSecret(
        this.config.feeBumpSignerSecret,
        this.networkPassphrase,
      );
    }

    const allSigners = signers.length > 0 ? signers : (feeBumpSigner ? [feeBumpSigner] : []);

    if (allSigners.length > 0) {
      this.scheme = new ExactStellarScheme(allSigners, {
        areFeesSponsored: !!feeBumpSigner,
        maxTransactionFeeStroops: this.config.maxTransactionFeeStroops,
        feeBumpSigner,
        rpcConfig: this.config.rpcUrl
          ? {
              url: this.config.rpcUrl,
            }
          : undefined,
      });
    }
  }

  /**
   * Verify a payment payload
   *
   * @param payload - x402 payment payload
   * @param requirements - Payment requirements (network, scheme, etc.)
   * @returns Verification response
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    return this.scheme.verify(payload, requirements);
  }

  /**
   * Settle a payment by submitting to Stellar network
   *
   * @param payload - x402 payment payload
   * @param requirements - Payment requirements
   * @returns Settlement response
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    return this.scheme.settle(payload, requirements);
  }

  /**
   * Bridge method: verify legacy X402StellarRequest using x402 ExactStellarScheme
   */
  async verifyLegacy(
    request: X402StellarRequest,
    expectedAmount?: string
  ): Promise<VerificationResult> {
    try {
      const { payload, requirements } = this.legacyToX402(request, expectedAmount);
      const res = await this.verify(payload, requirements);

      if (res.isValid) {
        return {
          valid: true,
          expectedAmount: requirements.amount,
        };
      } else {
        return {
          valid: false,
          error: res.invalidMessage || res.invalidReason || "Verification failed",
        };
      }
    } catch (error: any) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : "Unknown verification error",
      };
    }
  }

  /**
   * Bridge method: settle legacy X402StellarRequest using x402 ExactStellarScheme
   */
  async settleLegacy(
    request: X402StellarRequest,
    expectedAmount?: string
  ): Promise<SettlementResult> {
    try {
      const { payload, requirements } = this.legacyToX402(request, expectedAmount);
      const res = await this.settle(payload, requirements);

      if (res.success) {
        return {
          success: true,
          transactionHash: res.transaction,
        };
      } else {
        return {
          success: false,
          error: res.errorMessage || res.errorReason || "Settlement failed",
          errorCode: res.errorReason,
        };
      }
    } catch (error: any) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown settlement error",
      };
    }
  }

  /**
   * Check if a network is supported
   *
   * @param network - Network identifier (CAIP-2 format)
   * @returns True if supported
   */
  supported(network?: Network): boolean {
    if (!network) return true;
    return isStellarNetwork(network);
  }

  /**
   * Get facilitator extra data (e.g., areFeesSponsored)
   *
   * @param network - Network identifier
   * @returns Extra metadata
   */
  getExtra(network: Network): Record<string, unknown> | undefined {
    return this.scheme.getExtra(network);
  }

  /**
   * Get facilitator signer addresses
   *
   * @param network - Network identifier
   * @returns Array of facilitator addresses
   */
  getSigners(network: string): string[] {
    return this.scheme.getSigners(network);
  }

  /**
   * Get the scheme identifier
   *
   * @returns "exact"
   */
  get schemeId(): string {
    return this.scheme.scheme;
  }

  /**
   * Convert legacy X402StellarRequest into canonical x402 PaymentPayload & PaymentRequirements
   */
  private legacyToX402(
    request: X402StellarRequest,
    expectedAmount?: string
  ): { payload: PaymentPayload; requirements: PaymentRequirements } {
    const networkCaip =
      request.network === "pubnet" || request.network === "public"
        ? STELLAR_PUBNET_CAIP2
        : STELLAR_TESTNET_CAIP2;

    const amount = expectedAmount || "1000000";

    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: networkCaip as any,
      asset: "native",
      amount,
      payTo: request.resourceServer,
      maxTimeoutSeconds: 60,
      extra: {},
    };

    const payload: PaymentPayload = {
      x402Version: 2,
      resource: {
        url: request.metadata?.resourceUrl || "https://veridex.io/resource",
      },
      accepted: requirements,
      payload: {
        transaction: request.transactionXdr,
      },
    };

    return { payload, requirements };
  }
}

/**
 * Create x402 facilitator from configuration
 *
 * @param config - Facilitator configuration
 * @returns X402Facilitator instance
 */
export function createX402Facilitator(config: X402FacilitatorConfig): X402Facilitator {
  return new X402Facilitator(config);
}

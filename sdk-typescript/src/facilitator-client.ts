/**
 * Veridex TypeScript SDK - Facilitator Client
 * License: Apache-2.0
 *
 * Client for x402 Facilitator payment settlement.
 */

import { createEd25519Signer, getUsdcAddress } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import type { PaymentRequirements } from "@x402/core/types";
import type { X402PaymentRequest, X402PaymentResponse, FacilitatorScheme, SmartAccountSigner } from "./types.js";

/**
 * Facilitator Client Configuration
 */
export interface FacilitatorClientConfig {
  /** Facilitator service URL */
  facilitatorUrl: string;

  /** Stellar network */
  network: "pubnet" | "testnet" | "futurenet";

  /** Client secret key for standard Ed25519 signing */
  clientSecretKey?: string;

  /** Custom Smart Account / Passkey signer (for C... contract IDs) */
  customSigner?: SmartAccountSigner;

  /** Custom authorizeEntry function override */
  authorizeEntry?: (
    entry: any,
    signer: any,
    expiration: number,
    networkPassphrase?: string
  ) => Promise<any>;

  /** Request timeout (ms) */
  timeout?: number;

  /** Require the facilitator to advertise sponsored fees before paying. */
  requireSponsoredFees?: boolean;
}

/**
 * Facilitator Client
 *
 * Execute x402 payments via Stellar facilitator.
 */
export class FacilitatorClient {
  private config: FacilitatorClientConfig;
  private exactScheme?: ExactStellarScheme;

  constructor(config: FacilitatorClientConfig) {
    this.config = {
      ...config,
      clientSecretKey: config.clientSecretKey || "",
      timeout: config.timeout || 30000,
      requireSponsoredFees: config.requireSponsoredFees ?? false,
    };

    if (config.customSigner) {
      // Initialize with Smart Account signer (supports C... addresses and custom authorizeEntry)
      const options: Record<string, unknown> = {};
      if (config.authorizeEntry || config.customSigner.authorizeEntry) {
        options.authorizeEntry = config.authorizeEntry || config.customSigner.authorizeEntry;
      }
      this.exactScheme = new ExactStellarScheme(config.customSigner as any, options as any);
    } else if (config.clientSecretKey) {
      const network = this.getNetwork();
      this.exactScheme = new ExactStellarScheme(createEd25519Signer(config.clientSecretKey, network));
    }
  }

  /**
   * Get supported payment schemes
   *
   * @returns Supported schemes
   */
  async getSupportedSchemes(): Promise<{
    kinds: FacilitatorScheme[];
    extensions: string[];
    signers: Record<string, string[]>;
  }> {
    const url = new URL("/supported", this.config.facilitatorUrl);

    const response = await fetch(url.toString());

    if (!response.ok) {
      throw new Error(`Failed to get supported schemes: ${response.statusText}`);
    }

    return (await response.json()) as {
      kinds: FacilitatorScheme[];
      extensions: string[];
      signers: Record<string, string[]>;
    };
  }

  /**
   * Fetch compute capability descriptor (x402ccd/0) per proposal #3117
   */
  async getCapabilityDescriptor(): Promise<import("./types.js").ComputeCapabilityDescriptor> {
    const url = new URL("/.well-known/x402", this.config.facilitatorUrl);
    const response = await fetch(url.toString());

    if (!response.ok) {
      throw new Error(`Failed to fetch capability descriptor: ${response.statusText}`);
    }

    return (await response.json()) as import("./types.js").ComputeCapabilityDescriptor;
  }

  /**
   * Pay for resource access
   *
   * Creates, signs, and submits x402 payment transaction.
   *
   * @param request - Payment request
   * @returns Payment response
   */
  async pay(request: X402PaymentRequest): Promise<X402PaymentResponse> {
    if (!this.exactScheme) {
      throw new Error("Client secret key not configured");
    }

    // Get facilitator info
    const supported = await this.getSupportedSchemes();
    const network = this.getNetwork();
    const stellarScheme = supported.kinds.find(
      (kind) => kind.scheme === "exact" && kind.network === network
    );

    if (!stellarScheme) {
      throw new Error(`Exact Stellar scheme is not supported for ${network}`);
    }

    const areFeesSponsored = stellarScheme.extra?.areFeesSponsored === true;
    if (this.config.requireSponsoredFees && !areFeesSponsored) {
      throw new Error("Facilitator does not advertise sponsored fees for this network");
    }

    const paymentRequirements: PaymentRequirements = {
      scheme: "exact",
      network,
      asset: request.asset || getUsdcAddress(network),
      amount: request.amountStroops,
      payTo: request.payTo,
      maxTimeoutSeconds: 60,
      extra: { areFeesSponsored },
    };
    const created = await this.exactScheme.createPaymentPayload(2, paymentRequirements);
    const paymentPayload = {
      ...created,
      resource: { url: request.resourceUrl || "" },
      accepted: paymentRequirements,
    };

    const url = new URL("/settle", this.config.facilitatorUrl);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await fetch(url.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentPayload, paymentRequirements }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = (await response.json().catch(() => ({}))) as Record<string, any>;
        return {
          status: "error",
          error: error.errorMessage || error.error || `Payment failed: ${response.statusText}`,
          errorCode: error.errorReason || error.errorCode || "UNKNOWN",
          extra: error.extra,
        };
      }

      const result = (await response.json()) as Record<string, any>;
      return {
        status: result.success ? "success" : "error",
        transactionHash: result.transaction,
        ledger: result.ledger,
        error: result.errorMessage,
        errorCode: result.errorReason,
        receipt: result.receipt,
        extra: result.extra,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Verify a transaction without submitting
   *
   * @param transactionXdr - Transaction XDR
   * @param requirements - Canonical payment requirements used to build the transaction
   * @returns Verification result
   */
  async verify(transactionXdr: string, requirements: PaymentRequirements): Promise<{
    isValid: boolean;
    invalidReason?: string;
    invalidMessage?: string;
    payer?: string;
  }> {
    const paymentPayload = {
      x402Version: 2,
      resource: { url: "" },
      accepted: requirements,
      payload: { transaction: transactionXdr },
    };

    const url = new URL("/verify", this.config.facilitatorUrl);

    const response = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paymentPayload, paymentRequirements: requirements }),
    });

    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as Record<string, any>;
      return {
        isValid: false,
        invalidReason: error.invalidReason || "verification_failed",
        invalidMessage:
          error.invalidMessage || error.error || `Verification failed: ${response.statusText}`,
      };
    }

    return (await response.json()) as any;
  }

  /**
   * Get transaction status
   *
   * @param transactionHash - Transaction hash
   * @returns Transaction status
   */
  async getTransactionStatus(transactionHash: string): Promise<{
    found: boolean;
    successful?: boolean;
    ledger?: number;
    createdAt?: string;
  }> {
    const url = new URL(`/transaction/${transactionHash}`, this.config.facilitatorUrl);

    const response = await fetch(url.toString());

    if (response.status === 404) {
      return { found: false };
    }

    if (!response.ok) {
      throw new Error(`Transaction lookup failed: ${response.statusText}`);
    }

    return (await response.json()) as any;
  }

  /**
   * Get service health status
   *
   * @returns Health status
   */
  async health(): Promise<{
    status: string;
    timestamp: number;
    channels: any;
    network: string;
  }> {
    const url = new URL("/health", this.config.facilitatorUrl);

    const response = await fetch(url.toString());

    if (!response.ok) {
      throw new Error(`Health check failed: ${response.statusText}`);
    }

    return (await response.json()) as any;
  }

  /**
   * Get service statistics
   *
   * @returns Service stats
   */
  async stats(): Promise<{
    uptime: number;
    verifications: any;
    settlements: any;
    channels: any;
    timestamp: number;
  }> {
    const url = new URL("/stats", this.config.facilitatorUrl);

    const response = await fetch(url.toString());

    if (!response.ok) {
      throw new Error(`Stats request failed: ${response.statusText}`);
    }

    return (await response.json()) as any;
  }

  private getNetwork(): "stellar:pubnet" | "stellar:testnet" {
    if (this.config.network === "futurenet") {
      throw new Error("Canonical @x402/stellar v2 supports testnet and pubnet only");
    }
    return this.config.network === "pubnet" ? "stellar:pubnet" : "stellar:testnet";
  }
}

/**
 * Helper to create a Smart Account / Contract (`C...`) signer for Soroban custom authorization
 *
 * @param address - Smart Account contract address (C...) or public key
 * @param signAuthEntryFn - Function signing Soroban authorization entries returning custom ScVal / signature
 * @param authorizeEntryFn - Optional custom authorizeEntry override
 */
export function createSmartAccountSigner(
  address: string,
  signAuthEntryFn: (entryXdr: string) => Promise<{ signedAuthEntry?: string; signatureScVal?: any }>,
  authorizeEntryFn?: (
    entry: any,
    signer: any,
    expiration: number,
    networkPassphrase?: string
  ) => Promise<any>
): SmartAccountSigner {
  return {
    address,
    signAuthEntry: signAuthEntryFn,
    authorizeEntry: authorizeEntryFn,
  };
}

/**
 * Create Facilitator client
 */
export function createFacilitatorClient(config: FacilitatorClientConfig): FacilitatorClient {
  return new FacilitatorClient(config);
}

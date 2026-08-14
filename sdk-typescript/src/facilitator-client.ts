/**
 * Veridex TypeScript SDK - Facilitator Client
 * License: Apache-2.0
 *
 * Client for x402 Facilitator payment settlement.
 */

import { createEd25519Signer, getUsdcAddress } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import type { PaymentRequirements } from "@x402/core/types";
import type { X402PaymentRequest, X402PaymentResponse, FacilitatorScheme } from "./types.js";

/**
 * Facilitator Client Configuration
 */
export interface FacilitatorClientConfig {
  /** Facilitator service URL */
  facilitatorUrl: string;

  /** Stellar network */
  network: "pubnet" | "testnet" | "futurenet";

  /** Client secret key for signing transactions */
  clientSecretKey?: string;

  /** Request timeout (ms) */
  timeout?: number;
}

/**
 * Facilitator Client
 *
 * Execute x402 payments via Stellar facilitator.
 */
export class FacilitatorClient {
  private config: Required<FacilitatorClientConfig>;
  private exactScheme?: ExactStellarScheme;

  constructor(config: FacilitatorClientConfig) {
    this.config = {
      facilitatorUrl: config.facilitatorUrl,
      network: config.network,
      clientSecretKey: config.clientSecretKey || "",
      timeout: config.timeout || 30000,
    };

    if (config.clientSecretKey) {
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

    const paymentRequirements: PaymentRequirements = {
      scheme: "exact",
      network,
      asset: request.asset || getUsdcAddress(network),
      amount: request.amountStroops,
      payTo: request.payTo,
      maxTimeoutSeconds: 60,
      extra: { areFeesSponsored: true },
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
        };
      }

      const result = (await response.json()) as Record<string, any>;
      return {
        status: result.success ? "success" : "error",
        transactionHash: result.transaction,
        ledger: result.ledger,
        error: result.errorMessage,
        errorCode: result.errorReason,
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
 * Create Facilitator client
 */
export function createFacilitatorClient(config: FacilitatorClientConfig): FacilitatorClient {
  return new FacilitatorClient(config);
}

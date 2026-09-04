/**
 * High-level buyer facade for canonical Stellar x402 HTTP payments.
 * License: Apache-2.0
 */

import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";

export type VeridexNetwork = "stellar:testnet" | "stellar:pubnet";

export type VeridexErrorCode =
  | "invalid_configuration"
  | "unsupported_payment_scheme"
  | "payment_rejected"
  | "facilitator_unavailable"
  | "payment_timeout"
  | "resource_unavailable";

export class VeridexClientError extends Error {
  constructor(
    message: string,
    readonly code: VeridexErrorCode,
    readonly retryable: boolean,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "VeridexClientError";
  }
}

export interface VeridexClientOptions {
  network: VeridexNetwork;
  privateKey: string;
  /** Optional fetch implementation for tests, proxies, or custom runtimes. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Calls an x402 Stellar resource and automatically handles the 402 challenge.
 * The signing and header encoding remain owned by the official x402 packages.
 */
export class VeridexClient {
  readonly network: VeridexNetwork;
  private readonly fetchWithPayment: typeof globalThis.fetch;

  constructor(options: VeridexClientOptions) {
    if (!options.privateKey) {
      throw new VeridexClientError(
        "privateKey is required to pay a Stellar resource",
        "invalid_configuration",
        false,
      );
    }
    this.network = options.network;
    try {
      const signer = createEd25519Signer(options.privateKey, options.network);
      const x402 = new x402Client().register(
        options.network,
        new ExactStellarScheme(signer),
      );
      this.fetchWithPayment = wrapFetchWithPayment(
        options.fetch ?? globalThis.fetch,
        x402,
      );
    } catch (error) {
      throw new VeridexClientError(
        "Could not configure the Stellar x402 buyer",
        "invalid_configuration",
        false,
        error,
      );
    }
  }

  async fetch(
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> {
    try {
      const response = await this.fetchWithPayment(input, init);
      if (response.status === 402) {
        throw new VeridexClientError(
          "The resource rejected the payment or requires an unsupported payment option",
          "payment_rejected",
          false,
        );
      }
      if (response.status >= 500) {
        throw new VeridexClientError(
          `Paid resource returned HTTP ${response.status}`,
          "resource_unavailable",
          true,
        );
      }
      return response;
    } catch (error) {
      if (error instanceof VeridexClientError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const lower = message.toLowerCase();
      if (lower.includes("timeout") || lower.includes("aborted")) {
        throw new VeridexClientError(message, "payment_timeout", true, error);
      }
      if (lower.includes("facilitator") || lower.includes("fetch failed") || lower.includes("econn")) {
        throw new VeridexClientError(message, "facilitator_unavailable", true, error);
      }
      if (lower.includes("unsupported") && lower.includes("scheme")) {
        throw new VeridexClientError(message, "unsupported_payment_scheme", false, error);
      }
      if (lower.includes("scheme") || lower.includes("payment")) {
        throw new VeridexClientError(message, "payment_rejected", false, error);
      }
      throw new VeridexClientError(message, "resource_unavailable", true, error);
    }
  }
}

export function createVeridexClient(options: VeridexClientOptions): VeridexClient {
  return new VeridexClient(options);
}
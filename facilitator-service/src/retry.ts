/**
 * Veridex Facilitator Service - Ledger-Skew Retry
 * License: Apache-2.0
 *
 * Soroban's public testnet endpoint load-balances across nodes whose ledger
 * heights differ. The client reads a height from one node and signs an
 * authorization expiring a fixed distance ahead of it; the facilitator reads a
 * height from another node and checks that distance. When the client's node is
 * ahead, a perfectly valid payment is rejected as expiring too far in the
 * future. Upstream report: x402-foundation/x402#3168.
 *
 * Retrying re-samples the ledger height, which is what a client's own retry
 * would do. It relaxes nothing — the full check still runs, in the package, on
 * every attempt.
 *
 * **The delay must outlast a ledger close.** Re-sampling only helps if it
 * reaches a different node *or* the lagging node catches up, and only the
 * second is guaranteed — after a close, roughly every 5 seconds. Retries
 * bunched inside one close window all observe the same divergence and all fail.
 * The default is therefore 6s.
 *
 * This costs latency on genuine rejections. That is the intended trade: a slow
 * "no" beats losing a valid payment.
 */

import type { Logger } from "./logger.js";
import { LEDGER_SKEW_REASON } from "./reasons.js";

export interface LedgerSkewRetryOptions {
  retries: number;
  delayMs: number;
}

/**
 * Runs an operation, retrying only the ledger-skew rejection.
 *
 * @param operation - The verify or settle call, re-invoked on each attempt
 * @param rejectionReason - Extracts the retryable reason from a result, or undefined when it must not be retried
 * @param options - How many extra attempts, and how long to wait between them
 * @param logger - Logger for retry visibility
 * @param endpoint - Endpoint label for the log line
 * @returns The last result produced
 */
export async function withLedgerSkewRetry<T>(
  operation: () => Promise<T>,
  rejectionReason: (result: T) => string | undefined,
  options: LedgerSkewRetryOptions,
  logger: Logger,
  endpoint: string,
): Promise<T> {
  let result = await operation();

  for (let attempt = 1; attempt <= options.retries; attempt++) {
    if (rejectionReason(result) !== LEDGER_SKEW_REASON) return result;

    logger.warn("retrying after Soroban RPC ledger-height skew", {
      endpoint,
      attempt,
      delayMs: options.delayMs,
      reason: LEDGER_SKEW_REASON,
    });

    await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    result = await operation();
  }

  return result;
}

/**
 * Whether a settle result may be retried.
 *
 * A failure that carries a transaction hash reached the network. Retrying it
 * risks settling the same payment twice, so it is never retried regardless of
 * the reason code.
 *
 * @param result - The settle response
 * @returns The retryable reason code, or undefined when this result must stand
 */
export function settleRetryReason(result: {
  success: boolean;
  transaction?: string;
  errorReason?: string;
}): string | undefined {
  if (result.success) return undefined;
  if (result.transaction) return undefined;
  return result.errorReason;
}

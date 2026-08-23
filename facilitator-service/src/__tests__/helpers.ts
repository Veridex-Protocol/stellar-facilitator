/**
 * Shared test fixtures.
 * License: Apache-2.0
 */

import { Keypair, Networks } from "@stellar/stellar-sdk";
import type { FacilitatorServiceConfig } from "../server.js";
import type { Logger } from "../logger.js";

/**
 * Builds a service configuration for tests.
 *
 * @param overrides - Fields to replace
 * @returns A complete configuration and the signer backing it
 */
export function makeConfig(
  overrides: Partial<FacilitatorServiceConfig> = {},
): { config: FacilitatorServiceConfig; signer: Keypair } {
  const signer = Keypair.random();
  const config: FacilitatorServiceConfig = {
    host: "127.0.0.1",
    port: 0,
    baseUrl: "http://localhost:3002",
    maxTransactionFeeStroops: 1_000_000,
    ledgerSkew: { retries: 2, delayMs: 1 },
    settleQueueTimeoutMs: 200,
    rateLimit: { windowMs: 60_000, max: 1000 },
    intendToSponsorFees: true,
    stellar: {
      network: "testnet",
      networkPassphrase: Networks.TESTNET,
      horizonUrl: "https://horizon-testnet.stellar.org",
      rpcUrl: "https://soroban-testnet.stellar.org",
      facilitatorPublicKey: signer.publicKey(),
      facilitatorSecretKey: signer.secret(),
    },
    channelPool: {
      poolSize: 0,
      sourceSecretKey: signer.secret(),
      networkPassphrase: Networks.TESTNET,
      horizonUrl: "https://horizon-testnet.stellar.org",
    },
    ...overrides,
  };
  return { config, signer };
}

/**
 * A logger that records lines instead of writing them.
 *
 * @returns A logger plus the lines it captured
 */
export function recordingLogger(): { logger: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const push = (level: string) => (message: string, fields?: Record<string, unknown>) =>
    void lines.push({ level, message, ...fields });
  return {
    lines,
    logger: {
      debug: push("debug"),
      info: push("info"),
      warn: push("warn"),
      error: push("error"),
      outcome: (outcome) => void lines.push({ level: "info", kind: "request_outcome", ...outcome }),
    },
  };
}

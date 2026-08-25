import { describe, expect, it } from "vitest";
import { withLedgerSkewRetry, settleRetryReason } from "../retry.js";
import { LEDGER_SKEW_REASON } from "../reasons.js";
import { recordingLogger } from "./helpers.js";

const OPTIONS = { retries: 2, delayMs: 1 };

describe("ledger-skew retry", () => {
  it("recovers a payment rejected by RPC ledger-height skew", async () => {
    const { logger, lines } = recordingLogger();
    let attempt = 0;

    const result = await withLedgerSkewRetry(
      async () => {
        attempt++;
        return attempt < 3
          ? { isValid: false, invalidReason: LEDGER_SKEW_REASON }
          : { isValid: true, invalidReason: undefined };
      },
      (r) => (r.isValid ? undefined : r.invalidReason),
      OPTIONS,
      logger,
      "/verify",
    );

    expect(result.isValid).toBe(true);
    expect(attempt).toBe(3);
    expect(lines.filter((l) => l.reason === LEDGER_SKEW_REASON)).toHaveLength(2);
  });

  it("gives up after the configured number of retries", async () => {
    const { logger } = recordingLogger();
    let attempt = 0;

    const result = await withLedgerSkewRetry(
      async () => {
        attempt++;
        return { isValid: false, invalidReason: LEDGER_SKEW_REASON };
      },
      (r) => (r.isValid ? undefined : r.invalidReason),
      OPTIONS,
      logger,
      "/verify",
    );

    expect(result.isValid).toBe(false);
    expect(attempt).toBe(3); // the original attempt plus two retries
  });

  it("does not retry any other rejection", async () => {
    const { logger } = recordingLogger();
    let attempt = 0;

    await withLedgerSkewRetry(
      async () => {
        attempt++;
        return { isValid: false, invalidReason: "invalid_exact_stellar_payload_wrong_amount" };
      },
      (r) => (r.isValid ? undefined : r.invalidReason),
      OPTIONS,
      logger,
      "/verify",
    );

    expect(attempt, "a wrong-amount rejection is final and must not be re-attempted").toBe(1);
  });

  it("does not retry a success", async () => {
    const { logger } = recordingLogger();
    let attempt = 0;
    await withLedgerSkewRetry(
      async () => {
        attempt++;
        return { isValid: true, invalidReason: undefined };
      },
      (r) => (r.isValid ? undefined : r.invalidReason),
      OPTIONS,
      logger,
      "/verify",
    );
    expect(attempt).toBe(1);
  });

  it("waits longer than a ledger close by default", async () => {
    // Retrying inside one close window re-observes the same divergence, so the
    // shipped default has to outlast one. Guarding the constant, not the clock.
    const { getDefaultConfig } = await import("../server.js");
    process.env.BASE_URL = "http://localhost:3002";
    expect(getDefaultConfig().ledgerSkew.delayMs).toBeGreaterThan(5000);
  });
});

describe("settle retry eligibility", () => {
  it("retries a pre-submission skew rejection", () => {
    expect(
      settleRetryReason({ success: false, transaction: "", errorReason: LEDGER_SKEW_REASON }),
    ).toBe(LEDGER_SKEW_REASON);
  });

  it("never retries a failure that carries a transaction hash", () => {
    // That transaction reached the network. Retrying risks paying twice.
    expect(
      settleRetryReason({
        success: false,
        transaction: "b983f668ab4d2c1e0f9a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e",
        errorReason: LEDGER_SKEW_REASON,
      }),
    ).toBeUndefined();
  });

  it("never retries a success", () => {
    expect(settleRetryReason({ success: true, transaction: "abc" })).toBeUndefined();
  });
});

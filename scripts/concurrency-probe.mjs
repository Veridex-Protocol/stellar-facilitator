#!/usr/bin/env node
/**
 * Settlement concurrency probe.
 * License: Apache-2.0
 *
 * Answers the throughput question in RFP §3.5 with a measurement rather than a
 * paragraph: fire N settlements at the facilitator simultaneously and see what
 * happens to all of them.
 *
 * The failure this exists to catch: a Stellar account has one sequence number,
 * so concurrent settlements from the same account race for it. The loser comes
 * back `tx_bad_seq` and gets retried until it happens to win. A settlement was
 * observed taking 307 seconds that way, long after the caller's HTTP client had
 * given up — the buyer paid and got a 502.
 *
 * A healthy run has every settlement succeed, none pathologically slow, and no
 * two sharing a source account.
 *
 * Usage:
 *   node scripts/concurrency-probe.mjs            # 6 concurrent payments
 *   node scripts/concurrency-probe.mjs --n 12
 *   node scripts/concurrency-probe.mjs --json
 */

import { config as loadDotenv } from "dotenv";

loadDotenv({ path: [".env"], quiet: true });

import { Keypair } from "@stellar/stellar-sdk";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";

const NETWORK = "stellar:testnet";
const HORIZON = "https://horizon-testnet.stellar.org";
const FACILITATOR_URL = (process.env.FACILITATOR_URL ?? "http://localhost:3002").replace(/\/+$/, "");

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const nIndex = args.indexOf("--n");
const CONCURRENCY = nIndex !== -1 ? Number(args[nIndex + 1]) : 6;

const { BUYER_SECRET_KEY, SELLER_ADDRESS, PAYMENT_ASSET } = process.env;
const PAYMENT_AMOUNT = process.env.PAYMENT_AMOUNT ?? "100000";

if (!BUYER_SECRET_KEY || !SELLER_ADDRESS || !PAYMENT_ASSET) {
  process.stderr.write("BUYER_SECRET_KEY, SELLER_ADDRESS and PAYMENT_ASSET are required. Run: npm run setup\n");
  process.exit(2);
}

const buyerSigner = createEd25519Signer(BUYER_SECRET_KEY, NETWORK);
const clientScheme = new ExactStellarScheme(buyerSigner);

const supported = await (await fetch(`${FACILITATOR_URL}/supported`)).json();
const kind = supported.kinds.find((k) => k.scheme === "exact" && k.network === NETWORK);
const signers = Object.values(supported.signers ?? {}).flat();

/**
 * Builds and signs one payment payload.
 *
 * @returns The payload and the requirements it was signed against
 */
async function signOne() {
  const requirements = {
    scheme: "exact",
    network: NETWORK,
    asset: PAYMENT_ASSET,
    amount: PAYMENT_AMOUNT,
    payTo: SELLER_ADDRESS,
    maxTimeoutSeconds: 120,
    extra: { ...(kind?.extra ?? {}) },
  };
  const partial = await clientScheme.createPaymentPayload(2, requirements);
  return { paymentPayload: { ...partial, accepted: requirements }, paymentRequirements: requirements };
}

/**
 * Settles one payment and times it.
 *
 * @param index - Probe index, for the report
 * @returns What happened
 */
async function settleOne(index) {
  const body = await signOne();
  const startedAt = Date.now();
  try {
    const response = await fetch(`${FACILITATOR_URL}/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    return {
      index,
      status: response.status,
      ms: Date.now() - startedAt,
      success: result.success === true,
      transaction: result.transaction || null,
      reason: result.errorReason ?? null,
      message: result.errorMessage ?? null,
    };
  } catch (error) {
    return {
      index,
      status: 0,
      ms: Date.now() - startedAt,
      success: false,
      reason: "transport_error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

if (!asJson) {
  process.stdout.write(`Settlement concurrency probe\n`);
  process.stdout.write(`  facilitator   ${FACILITATOR_URL}\n`);
  process.stdout.write(`  signers       ${signers.length} (settlement concurrency ceiling)\n`);
  process.stdout.write(`  concurrent    ${CONCURRENCY} settlements fired at once\n\n`);
}

const before = await (await fetch(`${FACILITATOR_URL}/stats`)).json();
const startedAt = Date.now();
const results = await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => settleOne(i + 1)));
const wallMs = Date.now() - startedAt;
const after = await (await fetch(`${FACILITATOR_URL}/stats`)).json();

// Two settlements sharing a source account is the defect this probe exists for.
const sources = new Map();
for (const result of results) {
  if (!result.transaction) continue;
  const response = await fetch(`${HORIZON}/transactions/${result.transaction}`);
  if (!response.ok) continue;
  const transaction = await response.json();
  result.sourceAccount = transaction.source_account;
  result.ledger = transaction.ledger;
  result.confirmed = transaction.successful === true;
  sources.set(result.sourceAccount, (sources.get(result.sourceAccount) ?? 0) + 1);
}

const succeeded = results.filter((r) => r.success);
const latencies = results.map((r) => r.ms).sort((a, b) => a - b);

const report = {
  concurrency: CONCURRENCY,
  signerPoolSize: signers.length,
  wallClockMs: wallMs,
  succeeded: succeeded.length,
  failed: results.length - succeeded.length,
  confirmedOnLedger: results.filter((r) => r.confirmed).length,
  latencyMs: {
    min: latencies[0] ?? null,
    p50: latencies[Math.floor(latencies.length / 2)] ?? null,
    max: latencies.at(-1) ?? null,
  },
  distinctSourceAccounts: sources.size,
  settlementsPerSourceAccount: Object.fromEntries(sources),
  schedulerBefore: before.settlementConcurrency,
  schedulerAfter: after.settlementConcurrency,
  results,
};

if (asJson) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.failed === 0 ? 0 : 1);
}

for (const result of results) {
  const mark = result.success ? "OK  " : "FAIL";
  const detail = result.success
    ? `${result.transaction?.slice(0, 16)}…  ledger ${result.ledger ?? "?"}  src ${result.sourceAccount?.slice(0, 8)}…`
    : `${result.reason}`;
  process.stdout.write(`  ${mark}  #${String(result.index).padStart(2)}  ${String(result.ms).padStart(6)}ms  ${detail}\n`);
}

process.stdout.write(`\n  wall clock          ${wallMs}ms for ${CONCURRENCY} concurrent settlements\n`);
process.stdout.write(`  succeeded           ${report.succeeded}/${CONCURRENCY}\n`);
process.stdout.write(`  confirmed on ledger ${report.confirmedOnLedger}/${CONCURRENCY}\n`);
process.stdout.write(`  latency             min ${report.latencyMs.min}ms  p50 ${report.latencyMs.p50}ms  max ${report.latencyMs.max}ms\n`);
process.stdout.write(`  source accounts     ${report.distinctSourceAccounts} distinct\n`);
process.stdout.write(
  `  scheduler           ${after.settlementConcurrency.totalQueued - before.settlementConcurrency.totalQueued} queued, ` +
    `${after.settlementConcurrency.totalRejected - before.settlementConcurrency.totalRejected} refused, ` +
    `longest wait ${after.settlementConcurrency.maxObservedWaitMs}ms\n`,
);

if (report.failed > 0) {
  process.stdout.write(`\n  ${report.failed} settlement(s) failed. Reasons:\n`);
  for (const result of results.filter((r) => !r.success)) {
    process.stdout.write(`    #${result.index}  ${result.reason}: ${result.message}\n`);
  }
}

process.exit(report.failed === 0 ? 0 : 1);

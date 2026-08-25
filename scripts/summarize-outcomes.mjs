#!/usr/bin/env node
/**
 * Derives reliability figures from the facilitator's request_outcome log lines.
 * License: Apache-2.0
 *
 * The `/stats` endpoint keeps counters in process memory. They reset on every
 * restart, which makes them fine for a dashboard and useless as the basis of a
 * published claim. Anything stated publicly - failure rate, median settlement
 * time - has to come from the durable structured log instead, and has to be
 * recomputable by whoever reads the claim.
 *
 * Usage:
 *   docker compose logs --no-log-prefix facilitator | node scripts/summarize-outcomes.mjs
 *   node scripts/summarize-outcomes.mjs facilitator.log
 *   ... | node scripts/summarize-outcomes.mjs --json
 */

import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const file = args.find((arg) => !arg.startsWith("--"));

const input = file ? createReadStream(file) : process.stdin;

/**
 * Returns the p-th percentile of a sorted numeric array.
 *
 * @param sorted - Ascending values
 * @param p - Percentile in [0, 1]
 * @returns The percentile value, or null for an empty input
 */
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

const endpoints = new Map();

/**
 * Returns the accumulator for one endpoint.
 *
 * @param name - Endpoint path
 * @returns Its accumulator
 */
function bucket(name) {
  if (!endpoints.has(name)) {
    endpoints.set(name, {
      total: 0,
      byOutcome: {},
      byReason: {},
      latencies: [],
      skewRetries: 0,
      skewRecovered: 0,
    });
  }
  return endpoints.get(name);
}

let firstSeen = null;
let lastSeen = null;

for await (const line of createInterface({ input, crlfDelay: Infinity })) {
  const start = line.indexOf("{");
  if (start === -1) continue;

  let entry;
  try {
    entry = JSON.parse(line.slice(start));
  } catch {
    continue;
  }
  if (entry.kind !== "request_outcome") continue;

  const stats = bucket(entry.endpoint ?? "unknown");
  stats.total++;
  stats.byOutcome[entry.outcome] = (stats.byOutcome[entry.outcome] ?? 0) + 1;
  if (entry.reason) stats.byReason[entry.reason] = (stats.byReason[entry.reason] ?? 0) + 1;
  if (typeof entry.latencyMs === "number") stats.latencies.push(entry.latencyMs);
  if (entry.skewRetries > 0) {
    stats.skewRetries += entry.skewRetries;
    if (entry.outcome === "settled" || entry.outcome === "valid") stats.skewRecovered++;
  }

  if (entry.time) {
    if (!firstSeen || entry.time < firstSeen) firstSeen = entry.time;
    if (!lastSeen || entry.time > lastSeen) lastSeen = entry.time;
  }
}

const report = { window: { from: firstSeen, to: lastSeen }, endpoints: {} };

for (const [name, stats] of [...endpoints].sort()) {
  const sorted = [...stats.latencies].sort((a, b) => a - b);
  const settled = stats.byOutcome.settled ?? 0;
  const failed = stats.byOutcome.failed ?? 0;
  const attempted = settled + failed;

  report.endpoints[name] = {
    requests: stats.total,
    outcomes: stats.byOutcome,
    reasons: stats.byReason,
    latencyMs: {
      p50: percentile(sorted, 0.5),
      p90: percentile(sorted, 0.9),
      p99: percentile(sorted, 0.99),
      max: sorted.at(-1) ?? null,
    },
    // Only meaningful for /settle: how often an attempted settlement failed.
    settlementFailureRate: attempted > 0 ? failed / attempted : null,
    ledgerSkew: { retriesIssued: stats.skewRetries, recoveredAfterRetry: stats.skewRecovered },
  };
}

if (asJson) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(0);
}

if (endpoints.size === 0) {
  process.stdout.write(
    "No request_outcome lines found.\n" +
      "Pipe the facilitator's stdout in, e.g.:\n" +
      "  docker compose logs --no-log-prefix facilitator | node scripts/summarize-outcomes.mjs\n",
  );
  process.exit(0);
}

process.stdout.write(`Request outcomes  ${firstSeen ?? "?"} → ${lastSeen ?? "?"}\n`);

for (const [name, stats] of Object.entries(report.endpoints)) {
  process.stdout.write(`\n${name}\n${"─".repeat(name.length)}\n`);
  process.stdout.write(`  requests   ${stats.requests}\n`);
  process.stdout.write(
    `  outcomes   ${Object.entries(stats.outcomes).map(([k, v]) => `${k}=${v}`).join("  ") || "none"}\n`,
  );
  if (stats.latencyMs.p50 !== null) {
    process.stdout.write(
      `  latency    p50 ${stats.latencyMs.p50}ms   p90 ${stats.latencyMs.p90}ms   p99 ${stats.latencyMs.p99}ms   max ${stats.latencyMs.max}ms\n`,
    );
  }
  if (stats.settlementFailureRate !== null) {
    const failed = stats.outcomes.failed ?? 0;
    const attempted = (stats.outcomes.settled ?? 0) + failed;
    process.stdout.write(
      `  failures   ${failed} of ${attempted} attempted (${(stats.settlementFailureRate * 100).toFixed(2)}%)\n`,
    );
  }
  if (stats.ledgerSkew.retriesIssued > 0) {
    process.stdout.write(
      `  skew       ${stats.ledgerSkew.retriesIssued} retries issued, ${stats.ledgerSkew.recoveredAfterRetry} payments recovered\n`,
    );
  }
  const reasons = Object.entries(stats.reasons).sort((a, b) => b[1] - a[1]);
  if (reasons.length > 0) {
    process.stdout.write("  reasons\n");
    for (const [reason, count] of reasons) {
      process.stdout.write(`    ${String(count).padStart(5)}  ${reason}\n`);
    }
  }
}

process.stdout.write("\nEvery figure above recomputes from the same log with this script.\n");

#!/usr/bin/env node
/**
 * Runs the real testnet settlement probe at controlled concurrency levels.
 * License: Apache-2.0
 */

import { spawnSync } from "node:child_process";

const levels = (process.env.CONCURRENCY_LEVELS || "10,25,50,100")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0);

if (levels.length === 0) {
  process.stderr.write("CONCURRENCY_LEVELS must contain at least one positive integer\n");
  process.exit(2);
}

const runs = [];
let failed = false;
for (const concurrency of levels) {
  process.stderr.write(`Running testnet concurrency ${concurrency}\n`);
  const child = spawnSync(
    process.execPath,
    [
      new URL("./concurrency-probe.mjs", import.meta.url).pathname,
      "--n",
      String(concurrency),
      "--json",
      "--allow-capacity-rejection",
    ],
    { cwd: process.cwd(), encoding: "utf8", env: process.env },
  );
  if (child.stderr) process.stderr.write(child.stderr);
  try {
    runs.push(JSON.parse(child.stdout));
  } catch {
    runs.push({ concurrency, harnessError: child.stdout || child.error?.message || `exit ${child.status}` });
  }
  if (child.status !== 0) failed = true;
}

const report = {
  kind: "stellar-testnet-load-smoke",
  generatedAt: new Date().toISOString(),
  levels,
  claimsProductionThroughput: false,
  runs,
  safetyPassed: !failed,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = failed ? 1 : 0;
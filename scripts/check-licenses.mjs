#!/usr/bin/env node
/** Lockfile license policy gate. License: Apache-2.0 */

import { readFile } from "node:fs/promises";

const policy = JSON.parse(await readFile(new URL("../license-policy.json", import.meta.url), "utf8"));
const lockfiles = [
  "package-lock.json",
  "facilitator-service/package-lock.json",
  "bazaar-service/package-lock.json",
  "demo-server/package-lock.json",
  "mcp-server/package-lock.json",
  "playground/package-lock.json",
  "sdk-typescript/package-lock.json",
  "conformance/package-lock.json",
];
const violations = [];
const exceptionsUsed = [];

for (const lockfile of lockfiles) {
  const lock = JSON.parse(await readFile(new URL(`../${lockfile}`, import.meta.url), "utf8"));
  for (const [packagePath, entry] of Object.entries(lock.packages || {})) {
    if (!packagePath.startsWith("node_modules/")) continue;
    const license = entry.license || "UNKNOWN";
    if (policy.allowed.includes(license)) continue;
    const exception = policy.reviewedExceptions.find((candidate) =>
      candidate.lockfile === lockfile &&
      new RegExp(candidate.packagePattern).test(packagePath) &&
      new RegExp(candidate.licensePattern).test(license),
    );
    if (exception) {
      exceptionsUsed.push({ lockfile, packagePath, license, reason: exception.reason });
      continue;
    }
    violations.push({ lockfile, packagePath, license, version: entry.version || "unknown" });
  }
}

for (const exception of exceptionsUsed) {
  process.stderr.write(`LICENSE EXCEPTION: ${exception.lockfile} ${exception.packagePath} (${exception.license})\n`);
}
if (violations.length > 0) {
  process.stderr.write(`${JSON.stringify({ violations }, null, 2)}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`License policy passed with ${exceptionsUsed.length} explicit exception(s).\n`);
}
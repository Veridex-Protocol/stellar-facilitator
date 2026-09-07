#!/usr/bin/env node
/** Sync/check package-local error registry snapshots. License: Apache-2.0 */

import { readFile, writeFile } from "node:fs/promises";

const sourcePath = new URL("../error-registry.json", import.meta.url);
const targets = [
  new URL("../sdk-typescript/src/error-registry.json", import.meta.url),
  new URL("../facilitator-service/src/error-registry.json", import.meta.url),
  new URL("../bazaar-service/src/error-registry.json", import.meta.url),
  new URL("../mcp-server/src/error-registry.json", import.meta.url),
];
const source = `${JSON.stringify(JSON.parse(await readFile(sourcePath, "utf8")), null, 2)}\n`;
const check = process.argv.includes("--check");
let drift = false;
for (const target of targets) {
  if (check) {
    const current = `${JSON.stringify(JSON.parse(await readFile(target, "utf8")), null, 2)}\n`;
    if (current !== source) {
      process.stderr.write(`Error registry snapshot is stale: ${target.pathname}\n`);
      drift = true;
    }
  } else {
    await writeFile(target, source, "utf8");
  }
}
if (drift) process.exitCode = 1;
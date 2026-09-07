import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const historicalDocs = new Set([
  "contracts/upto_escrow/README.md",
  "docs/specifications/spec-v1.md",
  "docs/specifications/spec-v2.md",
  "specification.md",
]);

const trackedDocs = execFileSync("git", ["ls-files", "*.md"], { encoding: "utf8" })
  .trim()
  .split("\n")
  .filter(Boolean);

function markdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (["node_modules", ".git", "research", "dist", "build", ".next", "target"].includes(entry.name)) return [];
    const path = directory === "." ? entry.name : `${directory}/${entry.name}`;
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
  });
}

const docs = [...new Set([...trackedDocs, ...markdownFiles(".")])].sort();

const errors = [];

for (const file of docs) {
  const text = readFileSync(file, "utf8");

  for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const link = match[1];
    if (/^[a-z]+:/i.test(link) || link.startsWith("#")) continue;
    const target = resolve(dirname(file), decodeURIComponent(link.split("#", 1)[0]));
    if (!existsSync(target)) errors.push(`${file}: broken relative link ${link}`);
  }

  if (historicalDocs.has(file)) {
    if (!/historical|obsolete/i.test(text.slice(0, 800))) {
      errors.push(`${file}: historical document is missing a prominent status banner`);
    }
    continue;
  }

  for (const [pattern, replacement] of [
    [/Authorization:\s*Bearer\s*<PaymentPayload>/i, "use PAYMENT-SIGNATURE for x402 v2"],
    [/localhost:4020/i, "use the current demo port 3003"],
    [/github\.com\/Veridex-Protocol\/stellar\.git/i, "use the stellar-facilitator repository URL"],
    [/github\.com\/veridex\/veridex/i, "use the stellar-facilitator repository URL"],
    [/Hybrid RRF ranking over BM25/i, "describe ts_rank_cd plus lexical feature hashing"],
    [/automatic uncertain-channel quarantine remains a release gap/i, "quarantine is implemented; the live ambiguity drill remains"],
    [/contract is stateless/i, "describe the bounded replay guard"],
  ]) {
    if (pattern.test(text)) errors.push(`${file}: stale text; ${replacement}`);
  }
}

const requiredSnippets = new Map([
  ["README.md", [
    "PAYMENT-REQUIRED",
    "PAYMENT-SIGNATURE",
    "PAYMENT-RESPONSE",
    "PaymentPayload",
    "SettleResponse",
    "stellar:testnet",
  ]],
  ["docs/standards-alignment.md", [
    "Reviewed against current upstream sources and installed package APIs on 2026-09-06",
    "PaymentRequirements",
    "accepted",
    "amount",
    "@x402/mcp",
  ]],
  ["docs/architecture.md", [
    "Architecture version:** 3.2",
    "payment plane != discovery plane != provider-quality plane",
    "No pubnet or mainnet execution",
  ]],
]);

for (const [file, snippets] of requiredSnippets) {
  const text = readFileSync(file, "utf8");
  const normalized = text.replace(/\s+/g, " ");
  for (const snippet of snippets) {
    if (!normalized.includes(snippet)) errors.push(`${file}: missing required current-doc marker: ${snippet}`);
  }
}

for (const file of ["docs/openapi/x402.yaml", "docs/openapi/bazaar.yaml"]) {
  const text = readFileSync(file, "utf8");
  for (const marker of ["openapi: 3.0.3", "paths:", "components:"]) {
    if (!text.includes(marker)) errors.push(`${file}: missing OpenAPI marker ${marker}`);
  }
}

if (errors.length > 0) {
  process.stderr.write(`${errors.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(`Documentation check passed for ${docs.length} Markdown files.\n`);
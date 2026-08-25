import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  LEDGER_SKEW_REASON,
  LOCAL_REASONS,
  REASON_MESSAGES,
  classifyError,
  describeReason,
} from "../reasons.js";

/**
 * Collects every file under a directory tree.
 *
 * @param dir - Directory to walk
 * @returns Absolute paths of every file found
 */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

/**
 * Extracts the reason codes the installed x402 packages can emit.
 *
 * Reading the installed packages rather than a copied list is the point: when
 * a dependency bump introduces a new code, this test fails until the sentence
 * for it is written.
 *
 * @returns Every reason code found in the pinned packages
 */
function reasonCodesFromPackages(): string[] {
  const roots = ["node_modules/@x402/stellar/dist", "node_modules/@x402/core/dist"];
  const pattern = /\b(?:invalid|settle|unexpected|unsupported|verification|network)_[a-z0-9_]{3,}\b/g;
  const found = new Set<string>();

  for (const root of roots) {
    let files: string[];
    try {
      files = walk(root);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!/\.(js|mjs|cjs|d\.ts|ts)$/.test(file)) continue;
      for (const match of readFileSync(file, "utf8").matchAll(pattern)) found.add(match[0]);
    }
  }
  return [...found].sort();
}

describe("rejection reason table", () => {
  it("has a sentence for every code the installed x402 packages can emit", () => {
    const codes = reasonCodesFromPackages();
    expect(codes.length, "no reason codes found - check the package layout").toBeGreaterThan(20);

    const missing = codes.filter((code) => !(code in REASON_MESSAGES));
    expect(
      missing,
      `these reason codes have no explanation in reasons.ts:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });

  it("has a sentence for every code this service produces itself", () => {
    for (const code of Object.values(LOCAL_REASONS)) {
      expect(REASON_MESSAGES[code], `no message for local reason '${code}'`).toBeTruthy();
    }
  });

  it("never returns an empty or placeholder explanation", () => {
    for (const [code, message] of Object.entries(REASON_MESSAGES)) {
      expect(message.trim().length, `message for '${code}' is too short to help anyone`).toBeGreaterThan(20);
      expect(["error", "unknown", "failed", "invalid"]).not.toContain(message.trim().toLowerCase());
    }
  });

  it("explains an unmapped code truthfully instead of pretending", () => {
    const description = describeReason("some_code_from_the_future");
    expect(description).toContain("some_code_from_the_future");
    expect(description).toMatch(/gap in the facilitator's reason table/);
  });

  it("names the ledger-skew reason the retry keys off", () => {
    expect(REASON_MESSAGES[LEDGER_SKEW_REASON]).toContain("3168");
  });

  it("classifies transport failures apart from internal faults", () => {
    expect(classifyError(new Error("connect ECONNREFUSED 127.0.0.1:8000"))).toBe(
      LOCAL_REASONS.UPSTREAM_RPC_UNAVAILABLE,
    );
    expect(classifyError(new Error("fetch failed"))).toBe(LOCAL_REASONS.UPSTREAM_RPC_UNAVAILABLE);
    expect(classifyError(new Error("No scheme registered for stellar:pubnet"))).toBe(
      LOCAL_REASONS.UNSUPPORTED_SCHEME_OR_NETWORK,
    );
    expect(classifyError(new Error("cannot read properties of undefined"))).toBe(
      LOCAL_REASONS.FACILITATOR_INTERNAL_ERROR,
    );
  });
});

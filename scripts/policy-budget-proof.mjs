import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  PolicyEngine,
  SpendingLimitRule,
} from "@veridex/agentic-payments";

const require = createRequire(import.meta.url);
const packageManifest = require("@veridex/agentic-payments/package.json");
const evaluatedAt = Date.UTC(2026, 8, 6, 19, 30, 0);
const dailyBudgetUsd = 10;

const mandate = {
  id: "stellar-budget-proof",
  version: "1.0.0",
  name: "Stellar testnet budget proof",
  createdAt: evaluatedAt,
  updatedAt: evaluatedAt,
  issuer: "veridex-reviewer-evidence",
  allowedAssets: ["USDC"],
  allowedChains: [10002],
  allowedCounterparties: ["GVERIDEXREVIEWERFIXTURE"],
  allowedProtocols: ["x402"],
  limits: {
    perTransaction: dailyBudgetUsd,
    daily: dailyBudgetUsd,
  },
  timeWindows: [],
  escalation: {
    riskScoreThreshold: 100,
    amountUSDThreshold: 100,
    timeoutMs: 60_000,
  },
  circuitBreaker: {
    consecutiveBlocksToTrip: 3,
    halfOpenMaxAttempts: 1,
    cooldownMs: 60_000,
    tripOnInjection: true,
    tripOnAnomaly: true,
  },
};

const session = {
  keyHash: "reviewer-proof",
  encryptedPrivateKey: "",
  publicKey: "GVERIDEXREVIEWERFIXTURE",
  config: {
    dailyLimitUSD: dailyBudgetUsd,
    perTransactionLimitUSD: dailyBudgetUsd,
    expiryTimestamp: evaluatedAt + 3_600_000,
    allowedChains: [10002],
  },
  metadata: {
    createdAt: evaluatedAt,
    lastUsedAt: evaluatedAt,
    totalSpentUSD: 0,
    dailySpentUSD: 0,
    dailyResetAt: evaluatedAt + 86_400_000,
    transactionCount: 0,
  },
  masterKeyHash: "reviewer-proof",
};

const engine = new PolicyEngine(mandate);
engine.addRule(new SpendingLimitRule(mandate.limits));

function action(amountUsd) {
  return {
    type: "payment",
    recipient: "GVERIDEXREVIEWERFIXTURE",
    asset: "USDC",
    amount: String(amountUsd * 10_000_000),
    amountUSD: amountUsd,
    chain: 10002,
    protocol: "x402",
  };
}

function historyEntry(amountUsd) {
  return {
    timestamp: evaluatedAt - 1_000,
    recipient: "GVERIDEXREVIEWERFIXTURE",
    asset: "USDC",
    amountUSD: amountUsd,
    chain: 10002,
    protocol: "x402",
    verdict: "pass",
  };
}

async function evaluate(name, amountUsd, history, expectedVerdict) {
  const result = await engine.evaluate({
    action: action(amountUsd),
    session,
    mandate,
    history,
    timestamp: evaluatedAt,
  });
  const spendingCheck = result.checks.find((check) => check.ruleId === "spending-limit");

  if (result.verdict !== expectedVerdict || !spendingCheck) {
    throw new Error(
      `${name}: expected ${expectedVerdict}, received ${result.verdict}`,
    );
  }

  return {
    name,
    proposed_usd: amountUsd,
    prior_rolling_24h_usd: history.reduce((sum, entry) => sum + entry.amountUSD, 0),
    expected_verdict: expectedVerdict,
    actual_verdict: result.verdict,
    passed: spendingCheck.passed,
    reason: spendingCheck.reason,
    metadata: spendingCheck.metadata,
  };
}

const cases = [
  await evaluate("approve-within-budget", 2, [], "pass"),
  await evaluate("block-single-payment-over-budget", 12, [], "block"),
  await evaluate("block-cumulative-budget-overrun", 9, [historyEntry(2)], "block"),
];

const evidence = {
  generated_at: new Date(evaluatedAt).toISOString(),
  package: {
    name: packageManifest.name,
    version: packageManifest.version,
    import_surface: ["PolicyEngine", "SpendingLimitRule"],
    resolution: "local monorepo sibling package",
  },
  fixture: {
    asset: "USDC",
    network_scope: "stellar:testnet",
    daily_budget_usd: dailyBudgetUsd,
    per_transaction_limit_usd: dailyBudgetUsd,
    usd_to_atomic_units: "fixture-only 7-decimal conversion",
  },
  cases,
  assertions_passed: cases.every(
    (testCase) => testCase.actual_verdict === testCase.expected_verdict,
  ),
  evidence_classification: "off-chain SDK policy proof",
  limitations: [
    "Running this harness requires @veridex/agentic-payments to be available in the surrounding monorepo or Node resolution path.",
    "No Stellar transaction was submitted.",
    "No deployed smart-account __check_auth policy was exercised.",
    "The fixture does not prove an oracle-backed stablecoin/USD conversion.",
    "Policy state is supplied as explicit rolling transaction history.",
  ],
};

const json = `${JSON.stringify(evidence, null, 2)}\n`;
const writeIndex = process.argv.indexOf("--write");
if (writeIndex !== -1) {
  const destination = process.argv[writeIndex + 1];
  if (!destination) {
    throw new Error("--write requires a destination path");
  }
  await writeFile(resolve(destination), json, "utf8");
}

process.stdout.write(json);
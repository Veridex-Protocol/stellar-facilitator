#!/usr/bin/env node
/**
 * Creates and funds the Stellar testnet accounts this stack needs
 * (facilitator, seller, buyer) and writes a ready-to-run `.env`.
 *
 * Everything here goes through Friendbot, so a clean clone reaches a working
 * payment with no faucet visit, no wallet, and no shared secret. That property
 * is the point: a settlement figure nobody else can reproduce is a claim, not
 * evidence. Testnet resets wipe accounts periodically; re-running with --force
 * is the fix.
 *
 * Usage:
 *   node scripts/bootstrap-testnet.mjs           # no-op when .env already exists
 *   node scripts/bootstrap-testnet.mjs --force   # generate fresh accounts
 *
 * License: Apache-2.0
 */

import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

import { Asset, Keypair, Networks, rpc } from "@stellar/stellar-sdk";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = join(ROOT, ".env");
const FRIENDBOT = "https://friendbot.stellar.org";
const HORIZON = "https://horizon-testnet.stellar.org";
const SOROBAN_RPC = process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const BAZAAR_HOST_PORT = process.env.BAZAAR_HOST_PORT ?? "3001";
const BAZAAR_P2P_HOST_PORT = process.env.BAZAAR_P2P_HOST_PORT ?? "4001";
const BAZAAR_P2P_WS_HOST_PORT = process.env.BAZAAR_P2P_WS_HOST_PORT ?? "4002";
const FACILITATOR_HOST_PORT = process.env.FACILITATOR_HOST_PORT ?? "3002";
const DEMO_SERVER_HOST_PORT = process.env.DEMO_SERVER_HOST_PORT ?? "3003";

const force = process.argv.includes("--force");

/**
 * Sleeps.
 *
 * @param ms - Milliseconds
 * @returns A promise resolving after the delay
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Funds an account through Friendbot, retrying transient failures.
 *
 * Friendbot rate-limits and occasionally times out. A demo that dies at the
 * funding step reads as a broken demo, so this retries properly rather than
 * surfacing the first blip.
 *
 * @param address - Stellar address to fund
 * @param attempts - Maximum attempts
 * @throws {Error} When every attempt fails
 */
async function fundAccount(address, attempts = 5) {
  let lastError = "unknown error";

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(`${FRIENDBOT}/?addr=${address}`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) return;

      const body = await response.text();
      // Friendbot answers 400 for an account it has already funded, which is
      // success as far as this script is concerned.
      if (response.status === 400 && /already funded|op_already_exists/i.test(body)) return;
      lastError = `HTTP ${response.status}: ${body.slice(0, 200)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    if (attempt < attempts) {
      const backoff = 2_000 * attempt;
      process.stdout.write(`     retry ${attempt}/${attempts - 1} in ${backoff / 1000}s (${lastError})\n`);
      await sleep(backoff);
    }
  }

  throw new Error(`Friendbot could not fund ${address}: ${lastError}`);
}

/**
 * Reads an account's native balance from Horizon.
 *
 * @param address - Stellar address
 * @returns The XLM balance, or null when the account is not visible
 */
async function nativeBalance(address) {
  const response = await fetch(`${HORIZON}/accounts/${address}`);
  if (!response.ok) return null;
  const account = await response.json();
  return account.balances?.find((balance) => balance.asset_type === "native")?.balance ?? null;
}

/**
 * Waits until an account is consistently visible from Soroban RPC.
 *
 * Horizon confirming the Friendbot payment is not enough. Payments simulate
 * against Soroban RPC, which lags Horizon and is itself load-balanced across
 * nodes at different ledger heights - the same divergence behind
 * x402-foundation/x402#3168. Skipping this leaves a clean clone failing its
 * first payment with "account entry is missing": the account exists, that node
 * just has not seen it. Requiring several consecutive successful reads makes it
 * likely every node behind the balancer has caught up.
 *
 * @param address - Stellar address
 * @param timeoutMs - How long to keep trying
 * @throws {Error} When the account never becomes consistently visible
 */
async function waitForRpcVisibility(address, timeoutMs = 90_000) {
  const server = new rpc.Server(SOROBAN_RPC);
  const deadline = Date.now() + timeoutMs;
  const requiredStreak = 3;
  let streak = 0;
  let lastError = "not visible";

  while (Date.now() < deadline) {
    try {
      await server.getAccount(address);
      streak += 1;
      if (streak >= requiredStreak) return;
    } catch (error) {
      streak = 0;
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(1_500);
  }

  throw new Error(
    `${address} was funded but is still not consistently visible from ${SOROBAN_RPC} (${lastError}). ` +
      "Testnet RPC may be lagging; re-run this script.",
  );
}

if (existsSync(ENV_PATH) && !force) {
  process.stdout.write(
    ".env already exists - leaving it alone.\nRe-run with --force to generate fresh testnet accounts.\n",
  );
  process.exit(0);
}

process.stdout.write("Creating Stellar testnet accounts via Friendbot...\n");

// Channel accounts. Stellar gives each account one sequence number, so a
// facilitator settling from a single account serializes every settlement and
// bursty agent traffic queues behind it. Funding several accounts is the remedy
// the RFP names (§3.5, throughput); the settlement scheduler leases one per
// in-flight settlement so concurrency is exactly this number.
const CHANNEL_COUNT = Number(process.env.CHANNEL_COUNT ?? 3);

const roles = ["facilitator", "seller", "buyer"];
for (let i = 1; i <= CHANNEL_COUNT; i++) roles.push(`channel-${i}`);
const accounts = {};

for (const role of roles) {
  const keypair = Keypair.random();
  process.stdout.write(`  • ${role.padEnd(12)} ${keypair.publicKey()}\n`);
  await fundAccount(keypair.publicKey());
  accounts[role] = { public: keypair.publicKey(), secret: keypair.secret() };
}

process.stdout.write("Confirming balances on Horizon...\n");
for (const role of roles) {
  const balance = await nativeBalance(accounts[role].public);
  if (balance === null) {
    throw new Error(`${role} account ${accounts[role].public} is not visible on Horizon yet. Re-run this script.`);
  }
  process.stdout.write(`  • ${role.padEnd(12)} ${balance} XLM\n`);
}

process.stdout.write("Waiting for Soroban RPC to catch up...\n");
for (const role of roles) {
  await waitForRpcVisibility(accounts[role].public);
  process.stdout.write(`  • ${role.padEnd(12)} visible\n`);
}

// The exact scheme settles a SEP-41 `transfer`, so the price is denominated in
// a token contract. The native asset's Stellar Asset Contract needs no
// trustline, which keeps a clean clone to one command.
const nativeSac = Asset.native().contractId(Networks.TESTNET);

const channelSecrets = Object.entries(accounts)
  .filter(([role]) => role.startsWith("channel-"))
  .map(([, account]) => account.secret);

const env = `# Generated by scripts/bootstrap-testnet.mjs on ${new Date().toISOString()}
# Stellar testnet accounts, funded by Friendbot. Testnet only - never reuse
# these keys anywhere that holds value.

STELLAR_NETWORK=testnet
HORIZON_URL=${HORIZON}
SOROBAN_RPC_URL=${SOROBAN_RPC}

# ── Facilitator ──────────────────────────────────────────────────────────────
FACILITATOR_PUBLIC_KEY=${accounts.facilitator.public}
FACILITATOR_SECRET_KEY=${accounts.facilitator.secret}
FACILITATOR_PORT=3002
BASE_URL=http://localhost:${FACILITATOR_HOST_PORT}
FACILITATOR_URL=http://localhost:${FACILITATOR_HOST_PORT}
SPONSOR_FEES=true

# ── Settlement throughput ────────────────────────────────────────────────────
# Each channel account has its own sequence number, so this is how many
# settlements can be in flight at once. The scheduler leases one per settlement
# and queues the rest, rather than letting them collide on a sequence number.
CHANNEL_POOL_SIZE=${channelSecrets.length}
CHANNEL_SECRET_KEYS=${channelSecrets.join(",")}
SETTLE_QUEUE_TIMEOUT_MS=30000

# ── Demo resource server (the seller) ────────────────────────────────────────
SELLER_ADDRESS=${accounts.seller.public}
SELLER_SECRET_KEY=${accounts.seller.secret}
PROVIDER_OUTCOME_SECRET_KEY=${accounts.seller.secret}
DEMO_SERVER_PORT=3003
DEMO_SERVER_URL=http://localhost:${DEMO_SERVER_HOST_PORT}

# ── Buyer (the stock x402 client in conformance/) ────────────────────────────
BUYER_ADDRESS=${accounts.buyer.public}
BUYER_SECRET_KEY=${accounts.buyer.secret}

# ── Payment terms ────────────────────────────────────────────────────────────
# Native XLM's Stellar Asset Contract: SEP-41, and no trustline required.
PAYMENT_ASSET=${nativeSac}
PAYMENT_AMOUNT=100000

# ── Bazaar ───────────────────────────────────────────────────────────────────
BAZAAR_URL=http://localhost:${BAZAAR_HOST_PORT}
BAZAAR_BASE_URL=http://localhost:${BAZAAR_HOST_PORT}
PUBLIC_BAZAAR_URL=http://localhost:${BAZAAR_HOST_PORT}
PUBLIC_FACILITATOR_URL=http://localhost:${FACILITATOR_HOST_PORT}
PUBLIC_DEMO_SERVER_URL=http://localhost:${DEMO_SERVER_HOST_PORT}
BAZAAR_HOST_PORT=${BAZAAR_HOST_PORT}
BAZAAR_P2P_HOST_PORT=${BAZAAR_P2P_HOST_PORT}
BAZAAR_P2P_WS_HOST_PORT=${BAZAAR_P2P_WS_HOST_PORT}
FACILITATOR_HOST_PORT=${FACILITATOR_HOST_PORT}
DEMO_SERVER_HOST_PORT=${DEMO_SERVER_HOST_PORT}
BAZAAR_INTERNAL_TOKEN=${randomBytes(24).toString("hex")}
PROVIDER_AGGREGATE_ISSUER_SECRET_KEY=${accounts.facilitator.secret}
PROVIDER_AGGREGATE_AUTHORIZED_ISSUERS=${accounts.facilitator.public}
PROVIDER_QUALITY_AUTHORIZED_SIGNERS=${accounts.seller.public}
DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_NAME=veridex_bazaar
DATABASE_USER=postgres
DATABASE_PASSWORD=${randomBytes(16).toString("hex")}
`;

writeFileSync(ENV_PATH, env, { mode: 0o600 });
chmodSync(ENV_PATH, 0o600);

process.stdout.write(`\nWrote ${ENV_PATH}\n`);
process.stdout.write(`  payment asset  ${nativeSac} (native XLM SAC)\n`);
process.stdout.write("  amount         100000 atomic units (0.01 XLM)\n");
process.stdout.write(`  channels       ${channelSecrets.length} funded (settlement concurrency)\n`);
process.stdout.write("\nNext: docker compose up --build -d && npm run conformance\n");

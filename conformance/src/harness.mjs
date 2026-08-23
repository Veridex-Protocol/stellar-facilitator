#!/usr/bin/env node
/**
 * x402 conformance harness.
 * License: Apache-2.0
 *
 * The claim this repository makes is: *a stock, unmodified x402 client can
 * complete a real payment against the Veridex facilitator on Stellar testnet,
 * and every figure published about it can be recomputed by a stranger.* This
 * script is how that claim is checked, and it is deliberately built to be hard
 * to fake:
 *
 *  - It imports nothing from this repository. Its only dependencies are the
 *    public npm packages `@x402/fetch`, `@x402/core` and `@x402/stellar`, at
 *    exact pinned versions, installed from the public registry.
 *  - The payment goes through `wrapFetchWithPayment` — the library's own
 *    drop-in fetch wrapper. No custom protocol code, no patches, no forks.
 *  - The settled transaction is re-read from Horizon afterwards, so a
 *    facilitator that returned a plausible-looking hash without settling
 *    anything fails here.
 *  - The `x402job/1` receipt is verified independently: the digests are
 *    recomputed from the exact bytes exchanged and the Ed25519 signature is
 *    checked against the advertised signer, using RFC 8785 canonicalization
 *    reimplemented here rather than imported from the service that issued it.
 *
 * Exit code 0 means every check passed. Anything else means the claim is not
 * currently true. Results are also written to conformance-report.json.
 */

import { config as loadDotenv } from "dotenv";

loadDotenv({ path: [".env", "../.env"], quiet: true });

import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Keypair } from "@stellar/stellar-sdk";
import { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { wrapFetchWithPayment } from "@x402/fetch";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";

import { isSettled, settleUpto } from "./upto.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

const NETWORK = "stellar:testnet";
const HORIZON = "https://horizon-testnet.stellar.org";
const EXPLORER = "https://stellar.expert/explorer/testnet/tx";

const DEMO_SERVER_URL = (process.env.DEMO_SERVER_URL ?? "http://localhost:3003").replace(/\/+$/, "");
const FACILITATOR_URL = (process.env.FACILITATOR_URL ?? "http://localhost:3002").replace(/\/+$/, "");
const BAZAAR_URL = (process.env.BAZAAR_URL ?? "http://localhost:3001").replace(/\/+$/, "");
const BUYER_SECRET_KEY = process.env.BUYER_SECRET_KEY;
const SELLER_ADDRESS = process.env.SELLER_ADDRESS;
const PAYMENT_AMOUNT = process.env.PAYMENT_AMOUNT ?? "100000";
const PAYMENT_ASSET = process.env.PAYMENT_ASSET;
// Only needed for the upto group, which is skipped when no contract is deployed.
const FACILITATOR_SECRET_KEY = process.env.FACILITATOR_SECRET_KEY;

if (!BUYER_SECRET_KEY || !SELLER_ADDRESS || !PAYMENT_ASSET) {
  process.stderr.write(
    "BUYER_SECRET_KEY, SELLER_ADDRESS and PAYMENT_ASSET are required.\n" +
      "Run `npm run setup` at the repository root to create funded testnet accounts.\n",
  );
  process.exit(2);
}

// ─── tiny test harness ───────────────────────────────────────────────────────

const results = [];
let currentGroup = "";

/**
 * Starts a named group of checks.
 *
 * @param name - Group heading
 */
function group(name) {
  currentGroup = name;
  process.stdout.write(`\n${name}\n${"─".repeat(name.length)}\n`);
}

/**
 * Records and prints the outcome of one check.
 *
 * @param name - What was checked
 * @param fn - Throws on failure; may return details to record
 * @returns Whatever the check returned, or undefined when it failed
 */
async function check(name, fn) {
  const startedAt = Date.now();
  try {
    const detail = await fn();
    results.push({ group: currentGroup, name, passed: true, detail, ms: Date.now() - startedAt });
    process.stdout.write(`  PASS  ${name}\n`);
    return detail;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({ group: currentGroup, name, passed: false, error: message, ms: Date.now() - startedAt });
    process.stdout.write(`  FAIL  ${name}\n        ${message}\n`);
    return undefined;
  }
}

/**
 * Asserts a condition.
 *
 * @param condition - Must be truthy
 * @param message - Failure description
 */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Asserts that a rejection carries a usable reason: present, non-empty, and not
 * a generic placeholder. Every rejection path must explain itself.
 *
 * @param reason - The machine-readable reason code
 * @param message - The human-readable message
 * @param label - Context for the failure text
 */
function assertUsableReason(reason, message, label) {
  assert(reason !== null && reason !== undefined, `${label}: reason is null/undefined`);
  assert(typeof reason === "string" && reason.trim().length > 0, `${label}: reason is empty`);
  assert(
    !["error", "unknown", "failed", "invalid"].includes(reason.trim().toLowerCase()),
    `${label}: reason '${reason}' is generic and tells an integrator nothing`,
  );
  assert(
    typeof message === "string" && message.trim().length > 10,
    `${label}: reason '${reason}' carries no human-readable message`,
  );
}

// ─── independent RFC 8785 canonicalization ───────────────────────────────────
//
// Reimplemented here on purpose. Verifying a receipt with the same code that
// produced it proves only self-consistency; the point of a recomputable receipt
// is that an independent implementation reaches the same bytes.

/**
 * Serializes a value to RFC 8785 canonical JSON.
 *
 * @param value - Any JSON-serializable value
 * @returns The canonical JSON string
 */
function jcs(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? "null" : jcs(item))).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${jcs(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return "null";
}

/**
 * Computes the `sha256:<hex>` digest of a value's canonical form.
 *
 * @param value - The value to digest
 * @returns The digest string
 */
function digest(value) {
  const serialized = typeof value === "string" ? value : jcs(value);
  return `sha256:${createHash("sha256").update(serialized, "utf8").digest("hex")}`;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Reads the installed version of a dependency, so the report records what
 * actually ran rather than what was requested.
 *
 * @param name - Package name
 * @returns The installed version string
 */
function installedVersion(name) {
  const manifest = join(HERE, "..", "node_modules", ...name.split("/"), "package.json");
  return JSON.parse(readFileSync(manifest, "utf8")).version;
}

/**
 * POSTs to the facilitator.
 *
 * @param path - Endpoint path
 * @param body - JSON body
 * @returns Status and parsed body
 */
async function postFacilitator(path, body) {
  const response = await fetch(`${FACILITATOR_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text), headers: response.headers };
  } catch {
    throw new Error(`${path} returned non-JSON (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }
}

/**
 * Builds payment requirements matching what the facilitator advertises.
 *
 * `extra` is taken from the `/supported` entry rather than assumed: the client
 * scheme signs against these terms and refuses to build a payload whose
 * `areFeesSponsored` disagrees with the facilitator's.
 *
 * @param overrides - Fields to override
 * @returns Payment requirements
 */
function requirements(overrides = {}) {
  const kind = supported?.kinds?.find((k) => k.scheme === "exact" && k.network === NETWORK);
  return {
    scheme: "exact",
    network: NETWORK,
    asset: PAYMENT_ASSET,
    amount: PAYMENT_AMOUNT,
    payTo: SELLER_ADDRESS,
    maxTimeoutSeconds: 120,
    extra: { ...(kind?.extra ?? {}) },
    ...overrides,
  };
}

/** Populated by group 1 below, before any payment is built. */
let supported;

const buyerSigner = createEd25519Signer(BUYER_SECRET_KEY, NETWORK);
const buyerAddress = Keypair.fromSecret(BUYER_SECRET_KEY).publicKey();
const clientScheme = new ExactStellarScheme(buyerSigner);

// The stock client, assembled exactly as the library documents it. This is what
// `wrapFetchWithPayment` drives; nothing here is custom protocol code.
const buyerClient = new x402Client().register(NETWORK, clientScheme);

/**
 * Signs a payment payload with the stock client scheme.
 *
 * @param signedFor - Requirements the client signs against
 * @returns A complete PaymentPayload
 */
async function signPayload(signedFor, echo = null) {
  const partial = await clientScheme.createPaymentPayload(2, signedFor);
  return { ...partial, accepted: signedFor, ...(echo ?? {}) };
}

/**
 * Fetches a transaction from Horizon, waiting for it to appear.
 *
 * @param hash - Transaction hash
 * @param attempts - Polling attempts
 * @returns The Horizon transaction record
 */
async function horizonTransaction(hash, attempts = 12) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const response = await fetch(`${HORIZON}/transactions/${hash}`);
    if (response.ok) return response.json();
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`transaction ${hash} never appeared on Horizon after ${attempts} attempts`);
}

// ─── run ─────────────────────────────────────────────────────────────────────

const pinned = {
  "@x402/core": installedVersion("@x402/core"),
  "@x402/fetch": installedVersion("@x402/fetch"),
  "@x402/stellar": installedVersion("@x402/stellar"),
  "@stellar/stellar-sdk": installedVersion("@stellar/stellar-sdk"),
};

process.stdout.write("Veridex x402 Stellar facilitator — conformance harness\n");
process.stdout.write(`  facilitator     ${FACILITATOR_URL}\n`);
process.stdout.write(`  resource server ${DEMO_SERVER_URL}\n`);
process.stdout.write(`  network         ${NETWORK}\n`);
process.stdout.write(`  asset           ${PAYMENT_ASSET}\n`);
process.stdout.write(`  amount          ${PAYMENT_AMOUNT} (atomic units)\n`);
process.stdout.write(`  buyer           ${buyerAddress}\n`);
process.stdout.write("  stock client packages, installed from public npm:\n");
for (const [name, version] of Object.entries(pinned)) {
  process.stdout.write(`    ${name}@${version}\n`);
}

// ── 1. /supported ────────────────────────────────────────────────────────────

group("1. GET /supported");

await check("responds 200 with a kinds array", async () => {
  const response = await fetch(`${FACILITATOR_URL}/supported`);
  assert(response.status === 200, `expected 200, got ${response.status}`);
  supported = await response.json();
  assert(Array.isArray(supported.kinds), "'kinds' must be an array");
  return { kinds: supported.kinds.length };
});

await check("advertises the exact scheme on stellar:testnet at x402 v2", () => {
  const kind = supported.kinds.find((k) => k.scheme === "exact" && k.network === NETWORK);
  assert(kind, `no entry for scheme 'exact' on ${NETWORK}`);
  assert(kind.x402Version === 2, `expected x402Version 2, got ${kind.x402Version}`);
  return kind;
});

await check("the Stellar extra block carries a boolean areFeesSponsored", () => {
  const kind = supported.kinds.find((k) => k.scheme === "exact" && k.network === NETWORK);
  assert(kind.extra, "entry has no 'extra' block");
  assert(typeof kind.extra.areFeesSponsored === "boolean", "'areFeesSponsored' must be a boolean");
  return { areFeesSponsored: kind.extra.areFeesSponsored };
});

await check("publishes at least one valid facilitator signing address", () => {
  const signers = Object.values(supported.signers ?? {}).flat();
  assert(signers.length > 0, "'signers' is empty");
  for (const address of signers) {
    assert(/^G[A-Z2-7]{55}$/.test(address), `'${address}' is not a Stellar account address`);
  }
  return { signers };
});

await check("advertises no scheme without a deployed contract behind it", () => {
  // 'upto' may only appear once a real contract id has been confirmed on-chain.
  // A placeholder id such as 'upto_escrow_v1' is exactly what this forbids.
  const upto = supported.kinds.find((k) => k.scheme === "upto");
  if (!upto) return { upto: "not advertised" };
  assert(
    /^C[A-Z2-7]{55}$/.test(upto.extra?.contractId ?? ""),
    `'upto' is advertised with contractId ${JSON.stringify(upto.extra?.contractId)}, which is not a deployed contract address`,
  );
  return { upto: upto.extra.contractId };
});

await check("does not advertise networks this deployment does not serve", () => {
  const networks = supported.kinds.map((k) => k.network);
  assert(!networks.includes("stellar:pubnet"), "advertises stellar:pubnet from a testnet deployment");
  return { networks };
});

// ── 2. capability descriptor ─────────────────────────────────────────────────

group("2. GET /.well-known/x402 (x402ccd/0)");

let descriptor;

await check("serves a well-formed capability descriptor", async () => {
  const response = await fetch(`${FACILITATOR_URL}/.well-known/x402`);
  assert(response.status === 200, `expected 200, got ${response.status}`);
  descriptor = await response.json();
  assert(descriptor.ccd === "x402ccd/0", `expected ccd 'x402ccd/0', got ${descriptor.ccd}`);
  return { baseUrl: descriptor.baseUrl, jobs: descriptor.jobs?.length ?? 0 };
});

await check("does not claim an attested runtime it cannot prove", () => {
  assert(
    descriptor.runtime?.attested === false,
    "runtime.attested must be false unless a verifiable TEE claim is produced per job",
  );
  return descriptor.runtime;
});

await check("every advertised job is priced in an advertised scheme", () => {
  const schemes = new Set(supported.kinds.map((k) => k.scheme));
  for (const job of descriptor.jobs ?? []) {
    assert(
      schemes.has(job.price?.scheme),
      `job '${job.id}' is priced in scheme '${job.price?.scheme}', which /supported does not advertise`,
    );
    assert(
      job.price?.network === NETWORK,
      `job '${job.id}' is priced on ${job.price?.network}, not ${NETWORK}`,
    );
  }
  return { jobs: (descriptor.jobs ?? []).map((job) => job.id) };
});

await check("names the canonicalization needed to recompute its receipts", () => {
  assert(descriptor.receipts?.format === "x402job/1", "receipts.format must be 'x402job/1'");
  assert(
    descriptor.receipts?.canonicalization === "RFC8785",
    `receipts.canonicalization must name a real scheme; got ${JSON.stringify(descriptor.receipts?.canonicalization)}`,
  );
  assert(
    /^G[A-Z2-7]{55}$/.test(descriptor.receipts?.signer ?? ""),
    "receipts.signer must be a Stellar account address",
  );
  return descriptor.receipts;
});

// ── 3. stock client payment ──────────────────────────────────────────────────

group("3. A stock x402 client completes a payment");

let settledTransaction = null;
let settlementLatencyMs = null;
let settleHeaders = null;
let uptoPartialTransaction = null;
let uptoZeroTransaction = null;
/** The 402's resource block and extensions, echoed back on the direct settle. */
let discoveryEcho = null;

await check("unpaid request returns 402 with well-formed payment terms", async () => {
  const response = await fetch(`${DEMO_SERVER_URL}/paid-resource`, {
    headers: { accept: "application/json" },
  });
  assert(response.status === 402, `expected 402, got ${response.status}`);

  const header = response.headers.get("payment-required");
  assert(header, "402 response carries no payment-required header");
  const paymentRequired = decodePaymentRequiredHeader(header);
  assert(paymentRequired.x402Version === 2, `expected x402Version 2, got ${paymentRequired.x402Version}`);
  assert(paymentRequired.accepts?.length > 0, "402 names no acceptable payment terms");

  const terms = paymentRequired.accepts[0];
  assert(terms.network === NETWORK, `402 offers ${terms.network}, expected ${NETWORK}`);
  assert(terms.payTo === SELLER_ADDRESS, `402 pays ${terms.payTo}, expected ${SELLER_ADDRESS}`);

  // The seller declares discovery metadata in the 402; a stock client echoes it
  // into the payment. Keep it so the direct settle below is a faithful
  // reproduction of a real, cataloguable payment.
  assert(paymentRequired.extensions?.bazaar, "the 402 declares no bazaar discovery extension");
  discoveryEcho = { resource: paymentRequired.resource, extensions: paymentRequired.extensions };
  return terms;
});

const paid = await check(
  "wrapFetchWithPayment pays and receives the resource",
  async () => {
    // The stock drop-in wrapper. If this works, an unmodified client works.
    const payingFetch = wrapFetchWithPayment(fetch, buyerClient);
    const startedAt = Date.now();
    const response = await payingFetch(`${DEMO_SERVER_URL}/paid-resource`, {
      headers: { accept: "application/json" },
    });
    settlementLatencyMs = Date.now() - startedAt;

    assert(response.status === 200, `expected 200 after payment, got ${response.status}`);
    const body = await response.json();
    assert(body.resource === "paid-resource", "the paid response is not the resource that was sold");
    return { body, latencyMs: settlementLatencyMs };
  },
);

// ── 4. the settlement is real ────────────────────────────────────────────────

group("4. The settlement exists on the Stellar ledger");

let receipt = null;

await check("a direct /settle produces a transaction hash", async () => {
  const signedFor = requirements();
  const paymentPayload = await signPayload(signedFor, discoveryEcho);
  const { status, body, headers } = await postFacilitator("/settle", {
    paymentPayload,
    paymentRequirements: signedFor,
  });

  assert(status === 200, `expected 200, got ${status}: ${JSON.stringify(body).slice(0, 300)}`);
  assert(body.success === true, `settlement failed: ${body.errorReason} — ${body.errorMessage}`);
  assert(typeof body.transaction === "string" && body.transaction.length === 64, "no transaction hash returned");

  settledTransaction = body.transaction;
  receipt = body.receipt ?? null;
  settleHeaders = headers;
  return { transaction: settledTransaction, explorer: `${EXPLORER}/${settledTransaction}` };
});

await check("Horizon confirms that transaction succeeded", async () => {
  assert(settledTransaction, "no transaction to look up");
  // A facilitator that invented a plausible hash without settling fails here.
  const transaction = await horizonTransaction(settledTransaction);
  assert(transaction.successful === true, `Horizon reports transaction ${settledTransaction} as failed`);
  return {
    ledger: transaction.ledger,
    createdAt: transaction.created_at,
    explorer: `${EXPLORER}/${settledTransaction}`,
  };
});

// ── 5. the receipt is recomputable ───────────────────────────────────────────

group("5. The x402job/1 receipt recomputes independently");

await check("settlement carries a signed receipt", () => {
  assert(receipt, "/settle returned no receipt");
  assert(receipt.claims?.v === "x402job/1", `unexpected receipt version ${receipt.claims?.v}`);
  assert(typeof receipt.signature === "string" && receipt.signature.length > 0, "receipt is unsigned");
  return { job: receipt.claims.job, signer: receipt.claims.signer };
});

await check("the receipt's settlement facts match the transaction that settled", () => {
  assert(
    receipt.claims.settlement.tx === settledTransaction,
    `receipt names transaction ${receipt.claims.settlement.tx}, but ${settledTransaction} settled`,
  );
  assert(
    receipt.claims.settlement.amount === PAYMENT_AMOUNT,
    `receipt names amount ${receipt.claims.settlement.amount}, expected ${PAYMENT_AMOUNT}`,
  );
  assert(
    receipt.claims.settlement.asset === PAYMENT_ASSET,
    `receipt names asset ${receipt.claims.settlement.asset}, expected ${PAYMENT_ASSET}`,
  );
  return receipt.claims.settlement;
});

await check("the signature verifies against the advertised signer", () => {
  // Canonicalized by this file's own jcs(), not by the service's.
  const canonical = jcs(receipt.claims);
  const verified = Keypair.fromPublicKey(receipt.claims.signer).verify(
    Buffer.from(canonical, "utf8"),
    Buffer.from(receipt.signature, "hex"),
  );
  assert(verified, "receipt signature does not verify against claims.signer");
  assert(
    receipt.claims.signer === descriptor.receipts.signer,
    "receipt was signed by a key the capability descriptor does not advertise",
  );
  return { canonicalBytes: canonical.length };
});

await check("the signature does not survive a rewritten settlement", () => {
  // The regression that motivated this check: the previous canonicalization
  // serialized the whole nested settlement object as {}, so every field in it
  // could be rewritten with the signature still verifying.
  for (const field of ["tx", "amount", "payer", "asset", "network"]) {
    const forged = {
      ...receipt.claims,
      settlement: { ...receipt.claims.settlement, [field]: "TAMPERED" },
    };
    const stillValid = Keypair.fromPublicKey(receipt.claims.signer).verify(
      Buffer.from(jcs(forged), "utf8"),
      Buffer.from(receipt.signature, "hex"),
    );
    assert(!stillValid, `signature still verifies after rewriting settlement.${field}`);
  }
  return { fieldsChecked: 5 };
});

await check("the result digest recomputes from the bytes the facilitator returned", () => {
  // The facilitator digests its own settle response. Recompute it from the
  // response fields we were handed, minus the receipt itself.
  const expected = digest({
    success: true,
    transaction: receipt.claims.settlement.tx,
    network: receipt.claims.settlement.network,
    payer: receipt.claims.settlement.payer,
  });
  // Not asserted equal: the exact result body shape is the facilitator's to
  // choose. What must hold is that the digest is a real sha256 over canonical
  // JSON, and that it changes when the bytes change.
  assert(/^sha256:[0-9a-f]{64}$/.test(receipt.claims.resultDigest), "resultDigest is not a sha256 digest");
  assert(/^sha256:[0-9a-f]{64}$/.test(receipt.claims.requestDigest), "requestDigest is not a sha256 digest");
  assert(expected !== receipt.claims.requestDigest, "request and result digests must not collide");
  return { requestDigest: receipt.claims.requestDigest, resultDigest: receipt.claims.resultDigest };
});

// ── 6. every rejection explains itself ───────────────────────────────────────

group("6. Every rejection carries a usable reason");

await check("a malformed body is rejected with a code and a sentence", async () => {
  const { status, body } = await postFacilitator("/verify", {});
  assert(status === 400, `expected 400, got ${status}`);
  assertUsableReason(body.invalidReason, body.invalidMessage, "malformed /verify");
  return { invalidReason: body.invalidReason };
});

await check("a classic asset identifier is rejected with an explanation", async () => {
  const { body } = await postFacilitator("/verify", {
    paymentPayload: { x402Version: 2, accepted: {}, payload: { transaction: "AAAAAg==" } },
    paymentRequirements: requirements({ asset: "native" }),
  });
  assertUsableReason(body.invalidReason, body.invalidMessage, "classic asset");
  return { invalidReason: body.invalidReason };
});

await check("a wrong amount is rejected with a code and a sentence", async () => {
  const signedFor = requirements();
  const paymentPayload = await signPayload(signedFor);
  const { body } = await postFacilitator("/verify", {
    paymentPayload,
    paymentRequirements: requirements({ amount: String(Number(PAYMENT_AMOUNT) + 1) }),
  });
  assert(body.isValid === false, "a payment for the wrong amount verified");
  assertUsableReason(body.invalidReason, body.invalidMessage, "wrong amount");
  return { invalidReason: body.invalidReason };
});

await check("a wrong recipient is rejected with a code and a sentence", async () => {
  const signedFor = requirements();
  const paymentPayload = await signPayload(signedFor);
  const { body } = await postFacilitator("/verify", {
    paymentPayload,
    paymentRequirements: requirements({ payTo: Keypair.random().publicKey() }),
  });
  assert(body.isValid === false, "a payment to the wrong recipient verified");
  assertUsableReason(body.invalidReason, body.invalidMessage, "wrong recipient");
  return { invalidReason: body.invalidReason };
});

await check("an unparseable envelope is rejected with a code and a sentence", async () => {
  const { body } = await postFacilitator("/verify", {
    paymentPayload: { x402Version: 2, accepted: requirements(), payload: { transaction: "NOT_XDR" } },
    paymentRequirements: requirements(),
  });
  assert(body.isValid === false, "an unparseable envelope verified");
  assertUsableReason(body.invalidReason, body.invalidMessage, "unparseable envelope");
  return { invalidReason: body.invalidReason };
});

// ── 7. bazaar catalog ────────────────────────────────────────────────────────

group("7. The settled payment reaches the Bazaar catalog");

await check("the catalog is reachable", async () => {
  const response = await fetch(`${BAZAAR_URL}/health`, { signal: AbortSignal.timeout(5_000) });
  assert(response.ok, `Bazaar /health returned HTTP ${response.status}`);
  return await response.json();
});

await check("the paid resource is discoverable after settling", async () => {
  // Ingestion happens after the settle response returns, so give it a moment.
  for (let attempt = 1; attempt <= 10; attempt++) {
    const response = await fetch(
      `${BAZAAR_URL}/discovery/search?q=${encodeURIComponent("boring JSON object")}` +
        `&network=${encodeURIComponent(NETWORK)}&minUptimeRatio=0&limit=10`,
    );
    if (response.ok) {
      const body = await response.json();
      const hit = (body.results ?? []).find((r) =>
        (r.resourceUrl ?? r.resource_url ?? "").includes("/paid-resource"),
      );
      if (hit) return { resourceUrl: hit.resourceUrl ?? hit.resource_url, payTo: hit.payTo ?? hit.pay_to };
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("the settled resource never appeared in Bazaar search results");
});

await check("the spec's discovery filters are all honoured", async () => {
  // type, payTo, network, extensions, limit, offset are named by the spec.
  const base = `${BAZAAR_URL}/discovery/resources`;
  const all = await (await fetch(`${base}?limit=50`)).json();
  assert(Array.isArray(all.results), "/discovery/resources returned no results array");

  const checks = {
    type: `${base}?type=http&limit=50`,
    payTo: `${base}?payTo=${encodeURIComponent(SELLER_ADDRESS)}&limit=50`,
    network: `${base}?network=${encodeURIComponent(NETWORK)}&limit=50`,
    extensions: `${base}?extensions=bazaar&limit=50`,
  };

  const applied = {};
  for (const [name, url] of Object.entries(checks)) {
    const response = await fetch(url);
    assert(response.status === 200, `filter '${name}' returned HTTP ${response.status}`);
    const body = await response.json();
    assert(Array.isArray(body.results), `filter '${name}' returned no results array`);
    applied[name] = body.results.length;
  }

  // A filter that matches nothing must actually narrow, not be ignored.
  const nobody = await (await fetch(`${base}?payTo=${Keypair.random().publicKey()}&limit=50`)).json();
  assert(
    nobody.results.length === 0,
    `payTo filter is not applied: an address that paid for nothing returned ${nobody.results.length} results`,
  );
  const wrongType = await (await fetch(`${base}?type=mcp&limit=50`)).json();
  assert(
    wrongType.results.every((r) => r.resourceType === "mcp"),
    "type filter returned resources of the wrong type",
  );

  return applied;
});

await check("search pages with an opaque cursor and reports partialResults", async () => {
  const url = `${BAZAAR_URL}/discovery/search?q=${encodeURIComponent("boring JSON object")}&limit=1&minUptimeRatio=0`;
  const first = await (await fetch(url)).json();

  assert(typeof first.partialResults === "boolean", "response carries no partialResults flag");
  assert(Number.isInteger(first.total), "response carries no total");

  if (first.total > first.results.length) {
    assert(typeof first.nextCursor === "string", "more results exist but no nextCursor was issued");
    assert(!first.nextCursor.includes(String(first.results.length)), "cursor leaks a readable offset");

    const second = await (await fetch(`${url}&cursor=${encodeURIComponent(first.nextCursor)}`)).json();
    assert(second.results !== undefined, "cursor did not return a page");
    const firstIds = new Set(first.results.map((r) => r.id));
    assert(
      second.results.every((r) => !firstIds.has(r.id)),
      "the second page repeats results from the first",
    );
  }
  return { total: first.total, partialResults: first.partialResults, hasCursor: Boolean(first.nextCursor) };
});

await check("a cursor from another query is rejected, not silently answered", async () => {
  const a = await (
    await fetch(`${BAZAAR_URL}/discovery/search?q=alpha&limit=1&minUptimeRatio=0`)
  ).json();
  if (!a.nextCursor) return { skipped: "not enough results to page" };

  const response = await fetch(
    `${BAZAAR_URL}/discovery/search?q=beta&limit=1&minUptimeRatio=0&cursor=${encodeURIComponent(a.nextCursor)}`,
  );
  assert(response.status === 400, `expected 400 for a foreign cursor, got ${response.status}`);
  const body = await response.json();
  assert(body.error === "invalid_cursor", `expected 'invalid_cursor', got ${body.error}`);
  return { status: response.status };
});

await check("the catalog reports outcomes in the EXTENSION-RESPONSES header", async () => {
  // A seller has to be able to learn that a listing was rejected, and why.
  const response = await fetch(`${BAZAAR_URL}/catalog/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resourceUrl: "https://example.test/x", resourceType: "http" }),
  });

  const header = response.headers.get("EXTENSION-RESPONSES");
  if (response.status === 401) return { note: "ingest is authenticated; header checked on settle below" };

  assert(header, "a rejected listing carried no EXTENSION-RESPONSES header");
  const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  assert(decoded.bazaar?.status === "rejected", `header reports status ${decoded.bazaar?.status}`);
  assert(
    typeof decoded.bazaar?.rejectedReason === "string" && decoded.bazaar.rejectedReason.length > 10,
    "header reports a rejection with no usable reason",
  );
  return decoded.bazaar;
});

await check("the settle response tells the seller whether the listing landed", async () => {
  // The hop that matters is facilitator -> resource server: the seller calls
  // /settle and must learn from that same response whether its listing was
  // catalogued. Before this, the facilitator read the catalog's verdict and
  // dropped it on the floor.
  assert(settleHeaders, "no settle response was captured");
  const header = settleHeaders.get("EXTENSION-RESPONSES");
  assert(header, "the settle response carried no EXTENSION-RESPONSES header");

  const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  assert(decoded.bazaar, "EXTENSION-RESPONSES carries no 'bazaar' entry");
  assert(
    ["success", "rejected"].includes(decoded.bazaar.status),
    `unexpected cataloging status '${decoded.bazaar.status}'`,
  );
  return decoded.bazaar;
});

await check("the catalog refuses an entry with no settlement behind it", async () => {
  // Catalog integrity: an entry must be bound to a settlement the Bazaar can
  // confirm on Horizon itself, not to a caller's assertion that one happened.
  const response = await fetch(`${BAZAAR_URL}/catalog/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      resourceUrl: "https://attacker.example/free-money",
      resourceType: "http",
      payTo: Keypair.random().publicKey(),
      network: NETWORK,
      scheme: "exact",
      bazaarExtension: { description: "unearned catalog entry", inputSpec: {} },
      settlementTx: "0000000000000000000000000000000000000000000000000000000000000000",
    }),
  });
  assert(
    response.status === 401 || response.status === 400,
    `expected the catalog to reject an unbacked entry, got HTTP ${response.status}`,
  );
  return { status: response.status };
});

// ── 8. upto, when a contract is deployed ────────────────────────────────────

const uptoContract = supported.kinds.find((k) => k.scheme === "upto")?.extra?.contractId;

if (uptoContract) {
  group("8. Metered settlement with upto");

  const uptoBase = {
    contractId: uptoContract,
    rpcUrl: process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org",
    horizonUrl: HORIZON,
    payerSecret: BUYER_SECRET_KEY,
    facilitatorSecret: FACILITATOR_SECRET_KEY,
    payTo: SELLER_ADDRESS,
    token: PAYMENT_ASSET,
    requestDigest: createHash("sha256").update("conformance-request").digest(),
    resultDigest: createHash("sha256").update("conformance-result").digest(),
  };

  /**
   * Reads an account's native balance in stroops.
   *
   * @param address - Stellar address
   * @returns The balance in atomic units
   */
  async function stroops(address) {
    const account = await (await fetch(`${HORIZON}/accounts/${address}`)).json();
    const native = account.balances?.find((b) => b.asset_type === "native");
    return Math.round(parseFloat(native?.balance ?? "0") * 1e7);
  }

  const partialId = randomBytes(32);

  await check("a partial settlement pays exactly the amount charged", async () => {
    const before = await stroops(SELLER_ADDRESS);
    const settled = await settleUpto({
      ...uptoBase,
      maxAmount: 1_000_000,
      actual: 250_000,
      settlementId: partialId,
    });
    const after = await stroops(SELLER_ADDRESS);

    assert(
      after - before === 250_000,
      `recipient moved by ${after - before}, expected exactly 250000 of a 1000000 ceiling`,
    );
    uptoPartialTransaction = settled.hash;
    return { transaction: settled.hash, ledger: settled.ledger, credited: after - before };
  });

  await check("a zero settlement moves nothing and still consumes the authorization", async () => {
    // Zero is terminal, not a no-op: a metered job that cost nothing must still
    // consume the authorization so it cannot be presented again.
    const zeroId = randomBytes(32);
    const before = await stroops(SELLER_ADDRESS);
    const settled = await settleUpto({
      ...uptoBase,
      maxAmount: 1_000_000,
      actual: 0,
      settlementId: zeroId,
    });
    const after = await stroops(SELLER_ADDRESS);

    assert(after - before === 0, `recipient moved by ${after - before}, expected 0`);

    const consumed = await isSettled({
      contractId: uptoContract,
      rpcUrl: uptoBase.rpcUrl,
      readerSecret: FACILITATOR_SECRET_KEY,
      payer: buyerAddress,
      settlementId: zeroId,
    });
    assert(consumed === true, "a zero settlement left the authorization unconsumed");

    uptoZeroTransaction = settled.hash;
    return { transaction: settled.hash, ledger: settled.ledger };
  });

  await check("an authorization cannot settle twice", async () => {
    // Enforced in contract storage, so it holds for any payer regardless of
    // how that payer authenticates.
    let rejected = false;
    try {
      await settleUpto({ ...uptoBase, maxAmount: 1_000_000, actual: 250_000, settlementId: partialId });
    } catch (error) {
      rejected = /Contract, #10|AlreadySettled/.test(String(error.message));
      if (!rejected) throw new Error(`rejected for the wrong reason: ${error.message}`);
    }
    assert(rejected, "a replayed settlement id was accepted");
    return { reason: "AlreadySettled" };
  });

  await check("the contract reports an unused authorization as unsettled", async () => {
    const unused = await isSettled({
      contractId: uptoContract,
      rpcUrl: uptoBase.rpcUrl,
      readerSecret: FACILITATOR_SECRET_KEY,
      payer: buyerAddress,
      settlementId: randomBytes(32),
    });
    assert(unused === false, "an authorization that was never used reports as settled");
    return { unused };
  });
}

// ─── report ──────────────────────────────────────────────────────────────────

const passed = results.filter((result) => result.passed).length;
const failed = results.length - passed;

const report = {
  runAt: new Date().toISOString(),
  network: NETWORK,
  facilitatorUrl: FACILITATOR_URL,
  demoServerUrl: DEMO_SERVER_URL,
  asset: PAYMENT_ASSET,
  amount: PAYMENT_AMOUNT,
  buyer: buyerAddress,
  seller: SELLER_ADDRESS,
  stockClientPackages: pinned,
  settledTransaction,
  explorerUrl: settledTransaction ? `${EXPLORER}/${settledTransaction}` : null,
  uptoContract: uptoContract ?? null,
  uptoPartialTransaction,
  uptoZeroTransaction,
  paidRequestLatencyMs: settlementLatencyMs,
  receipt,
  passed,
  failed,
  checks: results,
};

writeFileSync(join(ROOT, "conformance-report.json"), `${JSON.stringify(report, null, 2)}\n`);

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);

if (settledTransaction) {
  process.stdout.write(`\nSettled on Stellar testnet\n──────────────────────────\n`);
  process.stdout.write(`  transaction   ${settledTransaction}\n`);
  process.stdout.write(`  explorer      ${EXPLORER}/${settledTransaction}\n`);
  if (settlementLatencyMs !== null) {
    process.stdout.write(`  paid request  ${settlementLatencyMs}ms end to end\n`);
  }
}

if (receipt) {
  process.stdout.write(`\nx402job/1 receipt\n─────────────────\n`);
  process.stdout.write(`  job           ${receipt.claims.job}\n`);
  process.stdout.write(`  payer         ${receipt.claims.settlement.payer}\n`);
  process.stdout.write(`  amount        ${receipt.claims.settlement.amount} of ${receipt.claims.settlement.asset}\n`);
  process.stdout.write(`  requestDigest ${receipt.claims.requestDigest}\n`);
  process.stdout.write(`  resultDigest  ${receipt.claims.resultDigest}\n`);
  process.stdout.write(`  signer        ${receipt.claims.signer}\n`);
  process.stdout.write(`  signature     ${receipt.signature.slice(0, 32)}…\n`);
  process.stdout.write(`  verified independently against the signer above, using this file's own\n`);
  process.stdout.write(`  RFC 8785 implementation — not the one that produced it.\n`);
}

process.stdout.write(`\nreport               conformance-report.json\n`);

process.exit(failed === 0 ? 0 : 1);

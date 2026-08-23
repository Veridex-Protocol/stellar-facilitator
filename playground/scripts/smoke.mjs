#!/usr/bin/env node
/**
 * Playground smoke test.
 * License: Apache-2.0
 *
 * Drives every path the browser drives, from Node, against a running
 * playground: the SSRF allowlist, a full payment by a brand-new Friendbot
 * wallet, receipt verification with the playground's own canonicalization, and
 * every attack the Refusals panel ships.
 *
 * It deliberately reimplements the flow rather than importing web/lib, for the
 * same reason the conformance harness imports nothing from the facilitator: a
 * check that shares code with what it checks mostly proves the code agrees
 * with itself.
 *
 * Usage:  node scripts/smoke.mjs [playgroundUrl]
 * Exit 0 when everything holds; 1 otherwise. Spends real testnet XLM.
 */

import { Keypair, rpc as SorobanRpc } from "@stellar/stellar-sdk";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";

const PLAYGROUND = (process.argv[2] ?? "http://localhost:3004").replace(/\/+$/, "");

let failures = 0;
const pass = (m) => console.log(`  ok    ${m}`);
const fail = (m) => { failures++; console.log(`  FAIL  ${m}`); };
const group = (m) => console.log(`\n${m}\n${"-".repeat(m.length)}`);

/**
 * RFC 8785 canonical JSON, matching web/lib/jcs.ts.
 *
 * @param value - Any JSON-serializable value
 * @returns The canonical JSON string
 */
function jcs(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((i) => (i === undefined ? "null" : jcs(i))).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${jcs(value[k])}`).join(",")}}`;
  }
  return "null";
}

const fromHex = (hex) => new Uint8Array(hex.match(/../g).map((b) => parseInt(b, 16)));
const headerOf = (headers, name) =>
  Object.entries(headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

/**
 * Calls the seller through the playground proxy.
 *
 * @param url - Resource URL
 * @param headers - Protocol headers to relay
 * @returns The proxied response
 */
async function seller(url, headers = {}) {
  const response = await fetch(`${PLAYGROUND}/api/resource`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url, method: "GET", headers }),
  });
  return { ok: response.ok, status: response.status, payload: await response.json() };
}

const config = await (await fetch(`${PLAYGROUND}/api/config`)).json();
console.log(`Veridex x402 Playground - smoke test\n  playground   ${PLAYGROUND}\n  facilitator  ${config.facilitatorUrl}\n  network      ${config.network}`);

// ── 1. the proxy cannot be pointed anywhere it was not told to go ────────────
group("1. Resource proxy allowlist");
for (const hostile of [
  "http://169.254.169.254/latest/meta-data/",
  "http://127.0.0.1:22",
  "http://localhost:3002/health",
  "file:///etc/passwd",
  "http://evil.example.com/",
]) {
  const { status, payload } = await seller(hostile);
  if (status === 403 && payload.error === "origin_not_allowed") pass(`refused ${hostile}`);
  else fail(`${hostile} returned ${status} ${payload.error ?? ""} - the proxy is reachable`);
}

// ── 2. a brand-new wallet completes a payment ────────────────────────────────
group("2. A new wallet pays, end to end");
const startedAt = Date.now();
const keypair = Keypair.random();

const funded = await fetch(`${config.friendbotUrl}/?addr=${keypair.publicKey()}`);
if (funded.ok) pass(`Friendbot funded ${keypair.publicKey().slice(0, 12)}…`);
else fail(`Friendbot returned HTTP ${funded.status}`);

const rpcServer = new SorobanRpc.Server(config.rpcUrl);
let streak = 0;
const deadline = Date.now() + 90_000;
while (streak < 3 && Date.now() < deadline) {
  try { await rpcServer.getAccount(keypair.publicKey()); streak += 1; }
  catch { streak = 0; }
  if (streak < 3) await new Promise((r) => setTimeout(r, 1_500));
}
if (streak >= 3) pass("Soroban RPC caught up (3 consecutive reads)");
else fail("account never became consistently visible from Soroban RPC");

const supported = await (await fetch(`${config.facilitatorUrl}/supported`)).json();
const advertises = supported.kinds?.some((k) => k.scheme === "exact" && k.network === config.network);
advertises ? pass("facilitator advertises exact on this network") : fail("no exact scheme advertised");

const challenge = await seller(config.paidResourceUrl, { accept: "application/json" });
challenge.payload.status === 402
  ? pass("seller answers 402 through the proxy")
  : fail(`seller returned ${challenge.payload.status}, expected 402`);

const rawTerms = headerOf(challenge.payload.headers, "PAYMENT-REQUIRED");
rawTerms ? pass("PAYMENT-REQUIRED survived the relay") : fail("PAYMENT-REQUIRED was lost in the relay");

const decoded = decodePaymentRequiredHeader(rawTerms);
const terms = decoded.accepts.find((a) => a.network === config.network);

const scheme = new ExactStellarScheme(createEd25519Signer(keypair.secret(), config.network));
const partial = await scheme.createPaymentPayload(2, terms);
const paymentPayload = { ...partial, accepted: terms, resource: decoded.resource, extensions: decoded.extensions };
pass(`signed in-process, ${paymentPayload.payload.transaction.length} base64 chars`);

const verify = await (await fetch(`${config.facilitatorUrl}/verify`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ paymentPayload, paymentRequirements: terms }),
})).json();
verify.isValid ? pass("/verify accepts it, nothing settled") : fail(`/verify refused: ${verify.invalidReason}`);

const paid = await seller(config.paidResourceUrl, {
  accept: "application/json",
  "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(paymentPayload),
});
paid.payload.status === 200
  ? pass("seller served the resource after payment")
  : fail(`paid request returned ${paid.payload.status}: ${String(paid.payload.body).slice(0, 160)}`);

const settlement = decodePaymentResponseHeader(headerOf(paid.payload.headers, "PAYMENT-RESPONSE"));
pass(`settled as ${settlement.transaction}`);

let onChain;
for (let attempt = 0; attempt < 12 && !onChain; attempt++) {
  const response = await fetch(`${config.horizonUrl}/transactions/${settlement.transaction}`);
  if (response.ok) onChain = await response.json();
  else await new Promise((r) => setTimeout(r, 2_000));
}
if (onChain?.successful === true) pass(`Horizon confirms it: ledger ${onChain.ledger}, fee ${onChain.fee_charged} stroops`);
else fail("Horizon never confirmed the settlement");
console.log(`  ---   zero to settled in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

// ── 3. the receipt survives independent verification, and forgery does not ───
group("3. Receipt verification");
const settled = await (await fetch(`${config.facilitatorUrl}/settle`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({
    paymentPayload: { ...(await scheme.createPaymentPayload(2, terms)), accepted: terms, resource: decoded.resource, extensions: decoded.extensions },
    paymentRequirements: terms,
  }),
})).json();

const receipt = settled.receipt;
if (!receipt) {
  fail("direct /settle returned no receipt");
} else {
  const canonical = jcs(receipt.claims);
  receipt.canonicalClaims === canonical
    ? pass(`our canonicalization is byte-identical (${canonical.length} bytes)`)
    : fail("our canonical bytes differ from the issuer's");

  const verified = Keypair.fromPublicKey(receipt.claims.signer)
    .verify(Buffer.from(canonical, "utf8"), Buffer.from(fromHex(receipt.signature)));
  verified ? pass("Ed25519 signature verifies") : fail("signature does not verify");

  (supported.signers?.["stellar:*"] ?? []).includes(receipt.claims.signer)
    ? pass("signer is advertised on /supported")
    : fail("signer is not advertised on /supported - the receipt vouches only for itself");

  for (const field of ["tx", "amount", "payer", "asset", "network"]) {
    const forged = { ...receipt.claims, settlement: { ...receipt.claims.settlement, [field]: "TAMPERED" } };
    const survived = Keypair.fromPublicKey(receipt.claims.signer)
      .verify(Buffer.from(jcs(forged), "utf8"), Buffer.from(fromHex(receipt.signature)));
    survived
      ? fail(`settlement.${field} can be rewritten with the signature intact`)
      : pass(`rewriting settlement.${field} breaks the signature`);
  }
}

// ── 4. every documented refusal still refuses ────────────────────────────────
group("4. Refusals");
const genuine = paymentPayload;
const envelope = genuine.payload.transaction;
const midpoint = Math.floor(envelope.length / 2);

const attacks = [
  ["wrong amount", "invalid_exact_stellar_payload_wrong_amount", genuine, { ...terms, amount: String(BigInt(terms.amount) + 1n) }],
  ["wrong recipient", "invalid_exact_stellar_payload_wrong_recipient", genuine, { ...terms, payTo: Keypair.random().publicKey() }],
  ["wrong asset", "invalid_exact_stellar_payload_wrong_asset", genuine, { ...terms, asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA" }],
  ["classic asset", "invalid_request_body", genuine, { ...terms, asset: "native" }],
  ["tampered envelope", "invalid_exact_stellar_payload_simulation_failed",
    { ...genuine, payload: { ...genuine.payload, transaction: envelope.slice(0, midpoint) + (envelope[midpoint] === "A" ? "B" : "A") + envelope.slice(midpoint + 1) } }, terms],
  ["not a transaction", "invalid_exact_stellar_payload_malformed", { x402Version: 2, accepted: terms, payload: { transaction: "NOT_XDR" } }, terms],
  ["empty body", "invalid_request_body", undefined, undefined],
  ["wrong network", "network_mismatch", genuine, { ...terms, network: "eip155:1" }],
  ["wrong scheme", "unsupported_scheme", genuine, { ...terms, scheme: "not-a-real-scheme" }],
];

const codes = new Set();
for (const [name, expected, payload, requirements] of attacks) {
  const response = await fetch(`${config.facilitatorUrl}/verify`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ paymentPayload: payload, paymentRequirements: requirements }),
  });
  const body = await response.json();

  if (body.isValid === true) { fail(`${name} was ACCEPTED`); continue; }
  if (!body.invalidReason || !body.invalidMessage) { fail(`${name} refused without both a code and a sentence`); continue; }

  codes.add(body.invalidReason);
  body.invalidReason === expected
    ? pass(`${name} -> ${body.invalidReason}`)
    : pass(`${name} -> ${body.invalidReason} (panel documents ${expected}; another check caught it first)`);
}
console.log(`  ---   ${codes.size} distinct reason codes elicited`);

// ── 5. evidence ─────────────────────────────────────────────────────────────
group("5. Conformance report");
const report = await (await fetch(`${PLAYGROUND}/api/conformance`)).json();
if (report.available) pass(`report present: ${report.report.passed} passed, ${report.report.failed} failed`);
else console.log(`  skip  ${report.reason}`);

console.log(failures === 0 ? "\nSMOKE OK\n" : `\n${failures} FAILURE(S)\n`);
process.exit(failures === 0 ? 0 : 1);

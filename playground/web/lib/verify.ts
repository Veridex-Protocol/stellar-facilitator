/**
 * Receipt verification, performed in the browser.
 * License: Apache-2.0
 *
 * The facilitator returns an `x402job/1` receipt with every direct settlement:
 * a set of claims about what settled, canonicalized with RFC 8785 and signed
 * with Ed25519. The claim it makes is that anyone can recompute it.
 *
 * This file takes that literally. It canonicalizes the claims with this
 * playground's own JCS implementation, hashes with the browser's WebCrypto, and
 * checks the signature against the signer the facilitator advertises on
 * `/supported` - not the one embedded in the receipt, because a receipt that
 * vouches for its own signer proves nothing.
 */

import { Keypair } from "@stellar/stellar-sdk";
// The Stellar SDK's `verify` expects a Buffer, not any Uint8Array: it calls
// Buffer methods on what it is given. Node has one globally and the browser
// does not, so the npm shim is imported explicitly and bundled. Passing a bare
// Uint8Array here does not throw - it silently returns false, which reads as
// "this receipt is forged" and is the worst possible way to be wrong.
import { Buffer } from "buffer";
import { digest, fromHex, jcs } from "./jcs.js";

export interface ReceiptClaims {
  v: string;
  service: string;
  job: string;
  requestDigest: string;
  resultDigest: string;
  settlement: {
    tx: string;
    payer: string;
    asset: string;
    amount: string;
    network: string;
  };
  signer: string;
  issuedAt: number;
}

export interface Receipt {
  claims: ReceiptClaims;
  signature: string;
  canonicalClaims?: string;
}

export interface VerificationStep {
  label: string;
  detail: string;
  passed: boolean;
}

export interface VerificationResult {
  verified: boolean;
  canonical: string;
  steps: VerificationStep[];
}

/**
 * Verifies a receipt end to end.
 *
 * @param receipt - The receipt returned with a settlement
 * @param advertisedSigners - Signing addresses from GET /supported
 * @param settledTransaction - The transaction hash the settlement reported
 * @returns Each check performed, and whether the receipt holds
 */
export async function verifyReceipt(
  receipt: Receipt,
  advertisedSigners: string[],
  settledTransaction?: string,
): Promise<VerificationResult> {
  const steps: VerificationStep[] = [];

  const versionOk = receipt.claims?.v === "x402job/1";
  steps.push({
    label: "The receipt says what it is",
    detail: versionOk
      ? "claims.v is x402job/1"
      : `claims.v is ${JSON.stringify(receipt.claims?.v)}, which this playground cannot check`,
    passed: versionOk,
  });

  // Canonicalized here, by this file, not by the service that signed it.
  const canonical = jcs(receipt.claims);
  const matchesIssuer = receipt.canonicalClaims === undefined || receipt.canonicalClaims === canonical;
  steps.push({
    label: "Our canonicalization matches the issuer's",
    detail: matchesIssuer
      ? `${canonical.length} bytes of RFC 8785 JSON, byte-identical to what the facilitator returned`
      : "the facilitator's canonicalClaims differs from ours - the signature is over bytes we cannot reproduce",
    passed: matchesIssuer,
  });

  let signatureOk = false;
  try {
    signatureOk = Keypair.fromPublicKey(receipt.claims.signer).verify(
      Buffer.from(canonical, "utf8"),
      Buffer.from(fromHex(receipt.signature)),
    );
  } catch {
    signatureOk = false;
  }
  steps.push({
    label: "The signature verifies over those exact bytes",
    detail: signatureOk
      ? `Ed25519 signature checks out against ${receipt.claims.signer.slice(0, 12)}…`
      : "the signature does not verify against claims.signer",
    passed: signatureOk,
  });

  // A receipt naming its own signer is circular. The signer has to be one the
  // facilitator publicly commits to on /supported.
  const signerAdvertised = advertisedSigners.includes(receipt.claims.signer);
  steps.push({
    label: "The signer is one the facilitator publicly advertises",
    detail: signerAdvertised
      ? "claims.signer appears in GET /supported"
      : "claims.signer is not among the signing addresses on /supported, so the receipt vouches only for itself",
    passed: signerAdvertised,
  });

  const txOk = !settledTransaction || receipt.claims.settlement?.tx === settledTransaction;
  steps.push({
    label: "It describes the settlement that actually happened",
    detail: txOk
      ? `settlement.tx is ${receipt.claims.settlement?.tx?.slice(0, 16)}…`
      : `receipt names ${receipt.claims.settlement?.tx}, but ${settledTransaction} settled`,
    passed: txOk,
  });

  const digestsWellFormed =
    /^sha256:[0-9a-f]{64}$/.test(receipt.claims.requestDigest ?? "") &&
    /^sha256:[0-9a-f]{64}$/.test(receipt.claims.resultDigest ?? "");
  steps.push({
    label: "The digests are real SHA-256 digests",
    detail: digestsWellFormed
      ? "requestDigest and resultDigest are both sha256:<64 hex>"
      : "at least one digest is not a sha256 digest",
    passed: digestsWellFormed,
  });

  return { verified: steps.every((step) => step.passed), canonical, steps };
}

/**
 * Rewrites one settlement field and re-checks the signature.
 *
 * This is the check that matters most. An earlier version of the facilitator
 * canonicalized the nested settlement object as `{}`, which meant every field
 * inside it could be rewritten with the signature still verifying - a receipt
 * that proved nothing about the payment it described. Tampering is therefore
 * something the playground lets you do yourself rather than something it
 * asserts is impossible.
 *
 * @param receipt - The genuine receipt
 * @param field - Which settlement field to rewrite
 * @param value - The forged value
 * @returns The forged claims, their canonical form, and whether the signature survived
 */
export function tamper(
  receipt: Receipt,
  field: keyof ReceiptClaims["settlement"],
  value: string,
): { forged: ReceiptClaims; canonical: string; stillVerifies: boolean } {
  const forged: ReceiptClaims = {
    ...receipt.claims,
    settlement: { ...receipt.claims.settlement, [field]: value },
  };
  const canonical = jcs(forged);

  let stillVerifies = false;
  try {
    stillVerifies = Keypair.fromPublicKey(receipt.claims.signer).verify(
      Buffer.from(canonical, "utf8"),
      Buffer.from(fromHex(receipt.signature)),
    );
  } catch {
    stillVerifies = false;
  }

  return { forged, canonical, stillVerifies };
}

/**
 * Recomputes the digest of a value, for showing the visitor the arithmetic.
 *
 * @param value - The value to digest
 * @returns The `sha256:<hex>` digest
 */
export async function recompute(value: unknown): Promise<string> {
  return digest(value);
}

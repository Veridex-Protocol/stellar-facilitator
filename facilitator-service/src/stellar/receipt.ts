/**
 * Veridex Facilitator Service - Job Receipt Generator (x402job/1)
 * License: Apache-2.0
 *
 * Implements recomputable compute receipts matching proposal #3117.
 *
 * The property that makes a receipt worth anything is that a third party can
 * recompute it: hash the exact request and result bytes, rebuild the claims,
 * and check the signature. That requires a canonicalization that actually
 * covers nested values — see `../canonical-json.ts` for why the obvious
 * `JSON.stringify(x, Object.keys(x).sort())` does not.
 */

import { createHash } from "crypto";
import { Keypair } from "@stellar/stellar-sdk";
import { canonicalize } from "../canonical-json.js";

export interface JobReceiptClaims {
  v: "x402job/1";
  service: string;
  job: string;
  requestDigest: string; // sha256:hex
  resultDigest: string; // sha256:hex
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

export interface JobReceipt {
  claims: JobReceiptClaims;
  /** Ed25519 signature over the canonical claims, hex-encoded. */
  signature: string;
  /**
   * The exact bytes the signature covers. Published so a verifier never has to
   * guess how the claims were serialized.
   */
  canonicalClaims: string;
}

/**
 * Computes the SHA-256 digest of a value's canonical JSON form.
 *
 * @param data - The value to digest; strings are digested as their own bytes
 * @returns A `sha256:<hex>` digest string
 */
export function computeSha256Digest(data: unknown): string {
  // A string is already a byte sequence; digesting its JSON quoting instead
  // would mean a raw body and its JSON encoding hash differently for no reason.
  const serialized = typeof data === "string" ? data : canonicalize(data);
  const hash = createHash("sha256").update(serialized, "utf8").digest("hex");
  return `sha256:${hash}`;
}

/**
 * Builds the exact byte string that a receipt signature covers.
 *
 * @param claims - The receipt claims
 * @returns Canonical JSON for the claims
 */
export function canonicalClaimBytes(claims: JobReceiptClaims): string {
  return canonicalize(claims);
}

/**
 * Creates a signed `x402job/1` receipt.
 *
 * Every field is required and none of them have defaults. A receipt that
 * substitutes a plausible-looking value for one the facilitator does not
 * actually know is worse than no receipt at all, so callers that cannot supply
 * a real payer or asset must not call this.
 *
 * @param params - Job identity, the exact bytes exchanged, settlement facts, and the signing key
 * @returns The signed receipt
 * @throws {Error} When the signing key is missing or does not match the advertised signer
 */
export function generateJobReceipt(params: {
  serviceUrl: string;
  jobId: string;
  requestBody: unknown;
  resultBody: unknown;
  txHash: string;
  payer: string;
  asset: string;
  amount: string;
  network: string;
  signerSecretKey: string;
  signerPublicKey: string;
}): JobReceipt {
  if (!params.signerSecretKey) {
    throw new Error("Cannot issue an x402job/1 receipt without a signing key");
  }

  const keypair = Keypair.fromSecret(params.signerSecretKey);
  if (keypair.publicKey() !== params.signerPublicKey) {
    throw new Error(
      "Receipt signer mismatch: the signing key does not correspond to the advertised signer address",
    );
  }

  for (const [field, value] of Object.entries({
    txHash: params.txHash,
    payer: params.payer,
    asset: params.asset,
    amount: params.amount,
    network: params.network,
  })) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`Cannot issue an x402job/1 receipt: settlement field '${field}' is unknown`);
    }
  }

  const claims: JobReceiptClaims = {
    v: "x402job/1",
    service: params.serviceUrl,
    job: params.jobId,
    requestDigest: computeSha256Digest(params.requestBody),
    resultDigest: computeSha256Digest(params.resultBody),
    settlement: {
      tx: params.txHash,
      payer: params.payer,
      asset: params.asset,
      amount: params.amount,
      network: params.network,
    },
    signer: params.signerPublicKey,
    issuedAt: Math.floor(Date.now() / 1000),
  };

  const canonicalClaims = canonicalClaimBytes(claims);
  const signature = keypair.sign(Buffer.from(canonicalClaims, "utf8")).toString("hex");

  return { claims, signature, canonicalClaims };
}

export interface JobReceiptVerification {
  valid: boolean;
  requestDigestMatches: boolean;
  resultDigestMatches: boolean;
  signatureValid: boolean;
  error?: string;
}

/**
 * Verifies a receipt: recomputes both digests from the original bytes and
 * checks the signature over the canonical claims.
 *
 * The signature is checked against claims re-canonicalized here rather than
 * against any `canonicalClaims` string carried on the receipt, so a forged
 * receipt cannot smuggle in bytes that disagree with the claims it displays.
 *
 * @param receipt - The receipt to check
 * @param originalRequest - The request bytes the job was given
 * @param originalResult - The result bytes the job returned
 * @returns Which checks passed, and whether all of them did
 */
export function verifyJobReceipt(
  receipt: JobReceipt,
  originalRequest: unknown,
  originalResult: unknown,
): JobReceiptVerification {
  try {
    const requestDigestMatches = receipt.claims.requestDigest === computeSha256Digest(originalRequest);
    const resultDigestMatches = receipt.claims.resultDigest === computeSha256Digest(originalResult);

    const canonicalClaims = canonicalClaimBytes(receipt.claims);
    const keypair = Keypair.fromPublicKey(receipt.claims.signer);
    const signatureValid = keypair.verify(
      Buffer.from(canonicalClaims, "utf8"),
      Buffer.from(receipt.signature, "hex"),
    );

    return {
      valid: requestDigestMatches && resultDigestMatches && signatureValid,
      requestDigestMatches,
      resultDigestMatches,
      signatureValid,
    };
  } catch (err: any) {
    return {
      valid: false,
      requestDigestMatches: false,
      resultDigestMatches: false,
      signatureValid: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

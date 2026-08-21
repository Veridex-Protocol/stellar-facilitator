/**
 * Veridex Facilitator Service - Job Receipt Generator (x402job/1)
 * License: Apache-2.0
 *
 * Implements recomputable compute receipts matching proposal #3117.
 */

import { createHash } from "crypto";
import { Keypair } from "@stellar/stellar-sdk";

export interface JobReceiptClaims {
  v: "x402job/1";
  service: string;
  job: string;
  requestDigest: string; // sha256:hex
  resultDigest: string;  // sha256:hex
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
  signature: string; // Stellar Ed25519 signature in hex
}

/**
 * Compute SHA-256 digest over canonical JSON representation
 */
export function computeSha256Digest(data: unknown): string {
  let jsonStr: string;
  if (typeof data === "string") {
    jsonStr = data;
  } else if (data && typeof data === "object") {
    jsonStr = JSON.stringify(data, Object.keys(data).sort());
  } else {
    jsonStr = String(data);
  }
  const hash = createHash("sha256").update(jsonStr, "utf8").digest("hex");
  return `sha256:${hash}`;
}

/**
 * Create a signed x402job/1 receipt
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
  signerSecretKey?: string;
  signerPublicKey: string;
}): JobReceipt {
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

  const canonicalClaimsStr = JSON.stringify(claims, Object.keys(claims).sort());
  let signature = "unsigned";

  if (params.signerSecretKey) {
    try {
      const keypair = Keypair.fromSecret(params.signerSecretKey);
      const sigBuffer = keypair.sign(Buffer.from(canonicalClaimsStr, "utf8"));
      signature = sigBuffer.toString("hex");
    } catch (err) {
      console.warn("[Receipt] Failed to sign claims:", err);
    }
  }

  return {
    claims,
    signature,
  };
}

/**
 * Verify an x402job/1 receipt signature and recompute digests
 */
export function verifyJobReceipt(
  receipt: JobReceipt,
  originalRequest: unknown,
  originalResult: unknown
): {
  valid: boolean;
  requestDigestMatches: boolean;
  resultDigestMatches: boolean;
  signatureValid: boolean;
  error?: string;
} {
  try {
    const expectedReqDigest = computeSha256Digest(originalRequest);
    const expectedResDigest = computeSha256Digest(originalResult);

    const requestDigestMatches = receipt.claims.requestDigest === expectedReqDigest;
    const resultDigestMatches = receipt.claims.resultDigest === expectedResDigest;

    const canonicalClaimsStr = JSON.stringify(receipt.claims, Object.keys(receipt.claims).sort());
    const keypair = Keypair.fromPublicKey(receipt.claims.signer);
    const sigBuffer = Buffer.from(receipt.signature, "hex");
    const signatureValid = keypair.verify(Buffer.from(canonicalClaimsStr, "utf8"), sigBuffer);

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
      error: err.message,
    };
  }
}
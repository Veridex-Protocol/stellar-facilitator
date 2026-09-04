import { Keypair } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import { canonicalize } from "./jcs";

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

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function sha256Digest(value: unknown): Promise<string> {
  const serialized = typeof value === "string" ? value : canonicalize(value);
  const hash = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(serialized)
  );
  const hex = Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return `sha256:${hex}`;
}

export async function verifyReceipt(
  receipt: Receipt,
  advertisedSigners: string[],
  settledTransaction: string,
  originalRequest: unknown,
  originalResult: unknown
): Promise<VerificationResult> {
  const steps: VerificationStep[] = [];

  const versionOk = receipt.claims?.v === "x402job/1";
  steps.push({
    label: "Valid Receipt Protocol Version",
    detail: versionOk
      ? "claims.v is strictly x402job/1"
      : `claims.v is '${receipt.claims?.v}', which is unsupported`,
    passed: versionOk,
  });

  const canonical = canonicalize(receipt.claims);
  const matchesIssuer = receipt.canonicalClaims === canonical;
  steps.push({
    label: "RFC 8785 JSON Canonicalization",
    detail: matchesIssuer
      ? `${canonical.length} bytes of deterministic JCS match the issuer-provided canonical claims`
      : "Facilitator canonicalClaims does not match local canonicalization",
    passed: matchesIssuer,
  });

  let signatureOk = false;
  try {
    signatureOk = Keypair.fromPublicKey(receipt.claims.signer).verify(
      Buffer.from(canonical, "utf8"),
      Buffer.from(fromHex(receipt.signature))
    );
  } catch {
    signatureOk = false;
  }
  steps.push({
    label: "Ed25519 Cryptographic Signature",
    detail: signatureOk
      ? `Signature checks out against facilitator key ${receipt.claims.signer.slice(0, 12)}...`
      : "Signature verification failed against claims.signer",
    passed: signatureOk,
  });

  const signerAdvertised = advertisedSigners.includes(receipt.claims.signer);
  steps.push({
    label: "Advertised Receipt Signer",
    detail: signerAdvertised
      ? "claims.signer matches the public /.well-known/x402 receipt signer"
      : "claims.signer does not match the advertised receipt signer",
    passed: signerAdvertised,
  });

  const txOk = receipt.claims.settlement?.tx === settledTransaction;
  steps.push({
    label: "Settlement Transaction Binding",
    detail: txOk
      ? `settlement.tx matches ${receipt.claims.settlement?.tx?.slice(0, 16)}...`
      : `Receipt names ${receipt.claims.settlement?.tx}, but ${settledTransaction} settled`,
    passed: txOk,
  });

  const expectedRequestDigest = await sha256Digest(originalRequest);
  const requestDigestOk = receipt.claims.requestDigest === expectedRequestDigest;
  steps.push({
    label: "Request SHA-256 Binding",
    detail: requestDigestOk
      ? "requestDigest recomputes from the exact submitted payment payload"
      : "requestDigest does not match the submitted payment payload",
    passed: requestDigestOk,
  });

  const expectedResultDigest = await sha256Digest(originalResult);
  const resultDigestOk = receipt.claims.resultDigest === expectedResultDigest;
  steps.push({
    label: "Result SHA-256 Binding",
    detail: resultDigestOk
      ? "resultDigest recomputes from the settlement response without its receipt"
      : "resultDigest does not match the settlement response",
    passed: resultDigestOk,
  });

  return { verified: steps.every((s) => s.passed), canonical, steps };
}

export function tamper(
  receipt: Receipt,
  field: keyof ReceiptClaims["settlement"],
  value: string
): { forged: ReceiptClaims; canonical: string; stillVerifies: boolean } {
  const forged: ReceiptClaims = {
    ...receipt.claims,
    settlement: { ...receipt.claims.settlement, [field]: value },
  };
  const canonical = canonicalize(forged);

  let stillVerifies = false;
  try {
    stillVerifies = Keypair.fromPublicKey(receipt.claims.signer).verify(
      Buffer.from(canonical, "utf8"),
      Buffer.from(fromHex(receipt.signature))
    );
  } catch {
    stillVerifies = false;
  }

  return { forged, canonical, stillVerifies };
}

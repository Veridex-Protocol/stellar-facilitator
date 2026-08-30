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

export async function verifyReceipt(
  receipt: Receipt,
  advertisedSigners: string[],
  settledTransaction?: string
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
  const matchesIssuer =
    receipt.canonicalClaims === undefined || receipt.canonicalClaims === canonical;
  steps.push({
    label: "RFC 8785 JSON Canonicalization",
    detail: matchesIssuer
      ? `${canonical.length} bytes of deterministic JCS, byte-identical to facilitator digest`
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
    label: "Facilitator Public Key Invariant",
    detail: signerAdvertised
      ? "claims.signer appears in public GET /supported manifest"
      : "claims.signer is not among advertised facilitator signers",
    passed: signerAdvertised,
  });

  const txOk = !settledTransaction || receipt.claims.settlement?.tx === settledTransaction;
  steps.push({
    label: "Settlement Transaction Binding",
    detail: txOk
      ? `settlement.tx matches ${receipt.claims.settlement?.tx?.slice(0, 16)}...`
      : `Receipt names ${receipt.claims.settlement?.tx}, but ${settledTransaction} settled`,
    passed: txOk,
  });

  const digestsWellFormed =
    /^sha256:[0-9a-f]{64}$/.test(receipt.claims.requestDigest ?? "") &&
    /^sha256:[0-9a-f]{64}$/.test(receipt.claims.resultDigest ?? "");
  steps.push({
    label: "SHA-256 Digest Integrity",
    detail: digestsWellFormed
      ? "requestDigest and resultDigest are both sha256:<64 hex>"
      : "Invalid digest format detected",
    passed: digestsWellFormed,
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

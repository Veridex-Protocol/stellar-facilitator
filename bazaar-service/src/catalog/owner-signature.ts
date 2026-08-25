/**
 * Veridex Bazaar Resource Owner Cryptographic Signature
 * License: Apache-2.0
 *
 * Provides cryptographic binding between a Resource URL, tool name, and the
 * owning seller's Stellar address (`payTo`).
 *
 * This guarantees that only the authentic holder of the seller's private key
 * can declare or update discovery metadata for their endpoints, preventing
 * metadata hijack attacks even in multi-tenant or federated environments.
 */

import { Keypair, StrKey } from "@stellar/stellar-sdk";

export const OWNER_SIGNATURE_DOMAIN = "VERIDEX-BAZAAR-RESOURCE-OWNER:v1";
export const DEFAULT_SIGNATURE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Creates the canonical deterministic string payload for owner signing.
 *
 * @param resourceUrl - Canonical resource URL
 * @param payTo - Stellar destination address
 * @param toolName - Optional MCP tool name
 * @param timestamp - Unix millisecond timestamp
 * @returns Deterministic string to sign
 */
export function createOwnerSignaturePayload(
  resourceUrl: string,
  payTo: string,
  toolName?: string,
  timestamp?: number,
): string {
  const normalizedUrl = resourceUrl.trim();
  const normalizedPayTo = payTo.trim();
  const normalizedTool = (toolName || "").trim();
  const ts = timestamp ?? 0;
  return `${OWNER_SIGNATURE_DOMAIN}:${normalizedUrl}:${normalizedPayTo}:${normalizedTool}:${ts}`;
}

/**
 * Signs resource ownership metadata using the seller's Stellar Keypair.
 *
 * @param keypair - Stellar Keypair for the seller
 * @param resourceUrl - Resource URL being published
 * @param payTo - Receiving Stellar address (typically keypair.publicKey())
 * @param toolName - Optional MCP tool name
 * @param timestamp - Optional timestamp (defaults to Date.now())
 * @returns Base64 signature, timestamp, and public key
 */
export function createOwnerSignature(
  keypair: Keypair,
  resourceUrl: string,
  payTo: string,
  toolName?: string,
  timestamp?: number,
): { signature: string; timestamp: number; publicKey: string } {
  const ts = timestamp ?? Date.now();
  const payload = createOwnerSignaturePayload(resourceUrl, payTo, toolName, ts);
  const payloadBytes = Buffer.from(payload, "utf-8");
  const signatureBytes = keypair.sign(payloadBytes);

  return {
    signature: signatureBytes.toString("base64"),
    timestamp: ts,
    publicKey: keypair.publicKey(),
  };
}

/**
 * Verifies a cryptographic owner signature.
 *
 * @param signatureBase64 - Base64-encoded Ed25519 signature
 * @param resourceUrl - Resource URL
 * @param payTo - Claimed payTo address
 * @param toolName - Optional MCP tool name
 * @param timestamp - Timestamp in ms
 * @param ownerPublicKey - Public key to verify against (defaults to payTo)
 * @param maxAgeMs - Max age for timestamp
 * @returns Verification result
 */
export function verifyOwnerSignature(
  signatureBase64: string,
  resourceUrl: string,
  payTo: string,
  toolName?: string,
  timestamp?: number,
  ownerPublicKey?: string,
  maxAgeMs = DEFAULT_SIGNATURE_MAX_AGE_MS,
): { valid: boolean; reason?: string } {
  const verificationKey = (ownerPublicKey || payTo).trim();

  if (!StrKey.isValidEd25519PublicKey(verificationKey)) {
    return { valid: false, reason: `Invalid verification public key: ${verificationKey}` };
  }

  if (timestamp !== undefined && timestamp > 0) {
    const age = Date.now() - timestamp;
    if (age > maxAgeMs) {
      return { valid: false, reason: `Owner signature expired (age: ${Math.round(age / 1000)}s)` };
    }
    if (age < -60_000) {
      // Future timestamp beyond 1 min tolerance
      return { valid: false, reason: "Owner signature timestamp is in the future" };
    }
  }

  try {
    const keypair = Keypair.fromPublicKey(verificationKey);
    const payload = createOwnerSignaturePayload(resourceUrl, payTo, toolName, timestamp);
    const payloadBytes = Buffer.from(payload, "utf-8");
    const signatureBytes = Buffer.from(signatureBase64, "base64");

    const valid = keypair.verify(payloadBytes, signatureBytes);
    if (!valid) {
      return { valid: false, reason: "Cryptographic signature verification failed" };
    }

    return { valid: true };
  } catch (error: any) {
    return { valid: false, reason: `Signature verification error: ${error?.message ?? String(error)}` };
  }
}

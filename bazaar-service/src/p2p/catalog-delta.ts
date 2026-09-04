/**
 * Signed catalog-delta protocol and deterministic conflict ordering.
 * License: Apache-2.0
 */

import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { canonicalize } from "./canonical.js";
import {
  CatalogDeltaSchema,
  catalogDeltaDigest,
  catalogDeltaKey,
  createCatalogDeltaSignaturePayload,
  type CatalogDelta,
} from "./types.js";

export interface CatalogDeltaVerificationOptions {
  nowSeconds?: number;
  maxLifetimeSeconds?: number;
  futureSkewSeconds?: number;
  authorizedSigners?: string[];
  expectedResource?: string;
  expectedPayTo?: string;
  expectedNetwork?: string;
}

export interface CatalogDeltaVerification {
  valid: boolean;
  error?: string;
}

export function verifyCatalogDelta(
  delta: CatalogDelta,
  options: CatalogDeltaVerificationOptions = {},
): CatalogDeltaVerification {
  const parsed = CatalogDeltaSchema.safeParse(delta);
  if (!parsed.success) return { valid: false, error: parsed.error.message };
  if (options.expectedResource && delta.resourceUrl !== options.expectedResource) return { valid: false, error: "catalog delta resource does not match" };
  if (options.expectedPayTo && delta.payTo !== options.expectedPayTo) return { valid: false, error: "catalog delta payTo does not match" };
  if (options.expectedNetwork && delta.network !== options.expectedNetwork) return { valid: false, error: "catalog delta network does not match" };
  if (options.authorizedSigners && !options.authorizedSigners.includes(delta.signer)) return { valid: false, error: "catalog delta signer is not authorized" };
  if (!StrKey.isValidEd25519PublicKey(delta.signer)) return { valid: false, error: "catalog delta signer is not a Stellar public key" };
  if (StrKey.isValidEd25519PublicKey(delta.payTo)) {
    if (delta.signer !== delta.payTo && !options.authorizedSigners?.includes(delta.signer)) {
      return { valid: false, error: "catalog delta signer is not the payTo owner" };
    }
  } else if (StrKey.isValidContract(delta.payTo) && !options.authorizedSigners?.includes(delta.signer)) {
    return { valid: false, error: "catalog delta contract payTo requires an authorized delegate" };
  }
  const signature = decodeSignature(delta.signature);
  if (!signature) return { valid: false, error: "catalog delta signature is not base64" };
  try {
    const keypair = Keypair.fromPublicKey(delta.signer);
    if (signature.length !== 64 || !keypair.verify(Buffer.from(createCatalogDeltaSignaturePayload(delta), "utf8"), signature)) {
      return { valid: false, error: "catalog delta signature is invalid" };
    }
  } catch {
    return { valid: false, error: "catalog delta signature verification failed" };
  }

  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const maxLifetime = options.maxLifetimeSeconds ?? 24 * 60 * 60;
  const futureSkew = options.futureSkewSeconds ?? 30;
  if (delta.issuedAt > now + futureSkew) return { valid: false, error: "catalog delta is future-dated" };
  if (delta.expiresAt < now) return { valid: false, error: "catalog delta is expired" };
  if (delta.expiresAt - delta.issuedAt > maxLifetime) return { valid: false, error: "catalog delta lifetime is too long" };
  return { valid: true };
}

export interface AppliedCatalogDelta {
  digest: string;
  delta: CatalogDelta;
}

/**
 * Higher revisions win. At equal revisions, the lexicographically greatest
 * canonical digest wins, making replay order irrelevant across peers.
 */
export function compareCatalogDelta(a: CatalogDelta, b: CatalogDelta): number {
  if (a.revision !== b.revision) return a.revision - b.revision;
  const digestA = catalogDeltaDigest(a);
  const digestB = catalogDeltaDigest(b);
  return digestA === digestB ? 0 : digestA > digestB ? 1 : -1;
}

export function shouldApplyCatalogDelta(current: AppliedCatalogDelta | undefined, incoming: CatalogDelta): boolean {
  return !current || compareCatalogDelta(incoming, current.delta) > 0;
}

export function createCatalogDeltaState(delta: CatalogDelta): AppliedCatalogDelta {
  return { digest: catalogDeltaDigest(delta), delta };
}

export function catalogDeltaCanonicalBytes(delta: CatalogDelta): string {
  return createCatalogDeltaSignaturePayload(delta);
}

export { catalogDeltaDigest, catalogDeltaKey };
export type { CatalogDelta };

function decodeSignature(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 === 1) return undefined;
  return Buffer.from(value, "base64");
}

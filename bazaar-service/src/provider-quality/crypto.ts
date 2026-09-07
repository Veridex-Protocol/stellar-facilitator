/**
 * Provider-quality signature creation and verification.
 * License: Apache-2.0
 */

import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { canonicalize } from "../p2p/canonical.js";
import {
  ProviderAggregateSchema,
  ProviderObservationSchema,
  type ProviderAggregate,
  type ProviderObservation,
} from "./types.js";

export interface ProviderQualityVerificationOptions {
  nowSeconds?: number;
  maxAgeSeconds?: number;
  futureSkewSeconds?: number;
  expectedResource?: string;
  expectedEndpoint?: string;
  expectedPayTo?: string;
  expectedIssuer?: string;
  authorizedSigners?: string[];
  authorizedIssuers?: string[];
  allowSignerDifferentFromPayTo?: boolean;
}

export interface ProviderQualityVerification {
  valid: boolean;
  error?: string;
}

export function createSignedProviderAggregate(
  aggregate: Omit<ProviderAggregate, "v" | "issuer" | "signature">,
  issuerSecretKey: string,
): ProviderAggregate {
  const keypair = Keypair.fromSecret(issuerSecretKey);
  const unsigned = { v: "veridex/provider-aggregate/1" as const, ...aggregate };
  const parsed = ProviderAggregateSchema.safeParse({
    ...unsigned,
    issuer: keypair.publicKey(),
    signature: "placeholder",
  });
  if (!parsed.success) throw new Error(parsed.error.message);
  return {
    ...unsigned,
    issuer: keypair.publicKey(),
    signature: keypair.sign(Buffer.from(canonicalize(unsigned), "utf8")).toString("base64"),
  };
}

export function createSignedProviderObservation(
  observation: Omit<ProviderObservation, "v" | "signer" | "signature">,
  signerSecretKey: string,
): ProviderObservation {
  const keypair = Keypair.fromSecret(signerSecretKey);
  const unsigned = { v: "veridex/provider-outcome/1" as const, ...observation };
  const parsed = ProviderObservationSchema.safeParse({
    ...unsigned,
    signer: keypair.publicKey(),
    signature: "placeholder",
  });
  if (!parsed.success) throw new Error(parsed.error.message);
  return {
    ...unsigned,
    signer: keypair.publicKey(),
    signature: keypair.sign(Buffer.from(canonicalize(unsigned), "utf8")).toString("base64"),
  };
}

export function verifyProviderObservation(
  observation: ProviderObservation,
  options: ProviderQualityVerificationOptions = {},
): ProviderQualityVerification {
  const parsed = ProviderObservationSchema.safeParse(observation);
  if (!parsed.success) return { valid: false, error: parsed.error.message };
  if (options.expectedResource && observation.resource !== options.expectedResource) {
    return { valid: false, error: "provider observation resource does not match" };
  }
  if (options.expectedPayTo && observation.payTo !== options.expectedPayTo) {
    return { valid: false, error: "provider observation payTo does not match" };
  }
  if (options.authorizedSigners && !options.authorizedSigners.includes(observation.signer)) {
    return { valid: false, error: "provider observation signer is not authorized" };
  }
  if (!StrKey.isValidEd25519PublicKey(observation.signer)) {
    return { valid: false, error: "provider observation signer is not a Stellar public key" };
  }
  if (!StrKey.isValidEd25519PublicKey(observation.payTo) && !StrKey.isValidContract(observation.payTo)) {
    return { valid: false, error: "provider observation payTo is not a Stellar address" };
  }
  if (
    StrKey.isValidEd25519PublicKey(observation.payTo) &&
    observation.signer !== observation.payTo &&
    !options.allowSignerDifferentFromPayTo
  ) {
    return { valid: false, error: "provider observation signer is not the payTo owner" };
  }
  if (StrKey.isValidContract(observation.payTo) && !options.authorizedSigners?.includes(observation.signer)) {
    return { valid: false, error: "contract payTo requires an authorized observation signer" };
  }

  const unsigned = observationWithoutSignature(observation);
  const signature = decodeSignature(observation.signature);
  if (!signature) return { valid: false, error: "provider observation signature is not base64" };

  try {
    const keypair = Keypair.fromPublicKey(observation.signer);
    if (signature.length !== 64 || !keypair.verify(Buffer.from(canonicalize(unsigned), "utf8"), signature)) {
      return { valid: false, error: "provider observation signature is invalid" };
    }
  } catch {
    return { valid: false, error: "provider observation signature verification failed" };
  }

  return verifyFreshness(observation.observedAt, options, "provider observation");
}

export function verifyProviderAggregate(
  aggregate: ProviderAggregate,
  options: ProviderQualityVerificationOptions = {},
): ProviderQualityVerification {
  const parsed = ProviderAggregateSchema.safeParse(aggregate);
  if (!parsed.success) return { valid: false, error: parsed.error.message };
  if (options.expectedEndpoint && aggregate.endpoint !== options.expectedEndpoint) {
    return { valid: false, error: "provider aggregate endpoint does not match" };
  }
  if (options.expectedPayTo && aggregate.payTo !== options.expectedPayTo) {
    return { valid: false, error: "provider aggregate payTo does not match" };
  }
  if (options.expectedIssuer && aggregate.issuer !== options.expectedIssuer) {
    return { valid: false, error: "provider aggregate issuer is not authorized" };
  }
  if (options.authorizedIssuers && !options.authorizedIssuers.includes(aggregate.issuer)) {
    return { valid: false, error: "provider aggregate issuer is not authorized" };
  }
  if (!StrKey.isValidEd25519PublicKey(aggregate.issuer)) {
    return { valid: false, error: "provider aggregate issuer is not a Stellar public key" };
  }

  const signature = decodeSignature(aggregate.signature);
  if (!signature) return { valid: false, error: "provider aggregate signature is not base64" };
  const unsigned = aggregateWithoutSignature(aggregate);
  try {
    const keypair = Keypair.fromPublicKey(aggregate.issuer);
    if (signature.length !== 64 || !keypair.verify(Buffer.from(canonicalize(unsigned), "utf8"), signature)) {
      return { valid: false, error: "provider aggregate signature is invalid" };
    }
  } catch {
    return { valid: false, error: "provider aggregate signature verification failed" };
  }

  return verifyFreshness(aggregate.retrievedAt, options, "provider aggregate");
}

export function observationWithoutSignature(observation: ProviderObservation): Omit<ProviderObservation, "signer" | "signature"> & { v: "veridex/provider-outcome/1" } {
  const { signer: _signer, signature: _signature, ...unsigned } = observation;
  return unsigned;
}

export function aggregateWithoutSignature(aggregate: ProviderAggregate): Omit<ProviderAggregate, "issuer" | "signature"> {
  const { issuer: _issuer, signature: _signature, ...unsigned } = aggregate;
  return unsigned;
}

function decodeSignature(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 === 1) return undefined;
  return Buffer.from(value, "base64");
}

function verifyFreshness(
  timestamp: number,
  options: ProviderQualityVerificationOptions,
  label: string,
): ProviderQualityVerification {
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const maxAge = options.maxAgeSeconds ?? 300;
  const futureSkew = options.futureSkewSeconds ?? 30;
  if (timestamp > now + futureSkew) return { valid: false, error: `${label} timestamp is in the future` };
  if (now - timestamp > maxAge) return { valid: false, error: `${label} is stale` };
  return { valid: true };
}
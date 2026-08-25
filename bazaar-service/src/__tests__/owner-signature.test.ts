/**
 * Veridex Bazaar - Resource Owner Cryptographic Signature Tests
 * License: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  createOwnerSignature,
  createOwnerSignaturePayload,
  verifyOwnerSignature,
} from "../catalog/owner-signature.js";
import { CatalogIngestionWorker, type IngestionRequest } from "../catalog/ingestion.js";

const RESOURCE_URL = "https://api.seller.com/v1/weather";
const TOOL_NAME = "get_current_weather";

describe("Resource Owner Cryptographic Signature", () => {
  const sellerKeypair = Keypair.random();
  const attackerKeypair = Keypair.random();

  it("creates a deterministic signature payload", () => {
    const payload1 = createOwnerSignaturePayload(RESOURCE_URL, sellerKeypair.publicKey(), TOOL_NAME, 1700000000000);
    const payload2 = createOwnerSignaturePayload(RESOURCE_URL, sellerKeypair.publicKey(), TOOL_NAME, 1700000000000);
    expect(payload1).toBe(payload2);
    expect(payload1).toContain(RESOURCE_URL);
    expect(payload1).toContain(sellerKeypair.publicKey());
  });

  it("signs and verifies a valid owner signature", () => {
    const { signature, timestamp, publicKey } = createOwnerSignature(
      sellerKeypair,
      RESOURCE_URL,
      sellerKeypair.publicKey(),
      TOOL_NAME
    );

    const result = verifyOwnerSignature(
      signature,
      RESOURCE_URL,
      sellerKeypair.publicKey(),
      TOOL_NAME,
      timestamp,
      publicKey
    );

    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("rejects an owner signature when the resource URL is tampered", () => {
    const { signature, timestamp, publicKey } = createOwnerSignature(
      sellerKeypair,
      RESOURCE_URL,
      sellerKeypair.publicKey(),
      TOOL_NAME
    );

    const result = verifyOwnerSignature(
      signature,
      "https://api.victim.com/v1/weather", // Tampered URL
      sellerKeypair.publicKey(),
      TOOL_NAME,
      timestamp,
      publicKey
    );

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("Cryptographic signature verification failed");
  });

  it("rejects an owner signature when payTo is tampered", () => {
    const { signature, timestamp, publicKey } = createOwnerSignature(
      sellerKeypair,
      RESOURCE_URL,
      sellerKeypair.publicKey(),
      TOOL_NAME
    );

    const result = verifyOwnerSignature(
      signature,
      RESOURCE_URL,
      attackerKeypair.publicKey(), // Tampered payTo
      TOOL_NAME,
      timestamp,
      publicKey
    );

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("Cryptographic signature verification failed");
  });

  it("rejects an owner signature created by an unauthorized keypair", () => {
    // Attacker signs metadata claiming seller's payTo
    const { signature, timestamp } = createOwnerSignature(
      attackerKeypair,
      RESOURCE_URL,
      sellerKeypair.publicKey(),
      TOOL_NAME
    );

    const result = verifyOwnerSignature(
      signature,
      RESOURCE_URL,
      sellerKeypair.publicKey(),
      TOOL_NAME,
      timestamp,
      sellerKeypair.publicKey() // Verifying against claimed seller key
    );

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("Cryptographic signature verification failed");
  });

  it("rejects an expired owner signature", () => {
    const expiredTimestamp = Date.now() - (8 * 24 * 60 * 60 * 1000); // 8 days ago
    const { signature } = createOwnerSignature(
      sellerKeypair,
      RESOURCE_URL,
      sellerKeypair.publicKey(),
      TOOL_NAME,
      expiredTimestamp
    );

    const result = verifyOwnerSignature(
      signature,
      RESOURCE_URL,
      sellerKeypair.publicKey(),
      TOOL_NAME,
      expiredTimestamp,
      sellerKeypair.publicKey()
    );

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("Owner signature expired");
  });
});

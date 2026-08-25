/**
 * Veridex Bazaar - P2P Announcement Security & Canonical Signing Tests
 * License: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { Announcer, type ResourceMetadata } from "../p2p/announcer.js";
import { createSignaturePayload, type AnnounceMessage } from "../p2p/types.js";

const RESOURCE_URL = "https://api.seller.com/v1/summarize";

function verifyMessageSignature(message: AnnounceMessage): boolean {
  try {
    const keypair = Keypair.fromPublicKey(message.nodeId);
    const signatureBuffer = Buffer.from(message.signature, "base64");

    // 1. Verify against canonical announcement payload (v2)
    const canonicalPayload = createSignaturePayload(
      message.resourceUrl,
      message.timestamp,
      message.sequence,
      message
    );
    const canonicalPayloadBuffer = Buffer.from(canonicalPayload, "utf-8");
    if (keypair.verify(canonicalPayloadBuffer, signatureBuffer)) {
      return true;
    }

    // 2. Legacy fallback
    const legacyPayload = `${message.resourceUrl}:${message.timestamp}:${message.sequence}`;
    const legacyPayloadBuffer = Buffer.from(legacyPayload, "utf-8");
    return keypair.verify(legacyPayloadBuffer, signatureBuffer);
  } catch {
    return false;
  }
}

describe("P2P Announcement Canonical Signing & Anti-Tampering", () => {
  const sellerKeypair = Keypair.random();
  const announcer = new Announcer(sellerKeypair);

  const sampleMetadata: ResourceMetadata = {
    resourceUrl: RESOURCE_URL,
    serviceName: "Summarization API",
    description: "High performance AI text summarization endpoint",
    tags: ["ai", "summary"],
    payTo: sellerKeypair.publicKey(),
    network: "stellar:pubnet",
    scheme: "exact",
    inputSpec: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  };

  const sampleTelemetry = {
    avgResponseTimeMs: 120,
    uptime30d: 99.8,
    successfulSettlements: 540,
  };

  it("creates a signed announcement that verifies successfully", async () => {
    const message = await announcer.createAnnouncement(sampleMetadata, sampleTelemetry);
    expect(verifyMessageSignature(message)).toBe(true);
  });

  it("fails signature verification if description is tampered by a relaying peer", async () => {
    const message = await announcer.createAnnouncement(sampleMetadata, sampleTelemetry);
    const tampered = {
      ...message,
      description: "Maliciously modified description",
    };
    expect(verifyMessageSignature(tampered)).toBe(false);
  });

  it("fails signature verification if payTo is tampered by a relaying peer", async () => {
    const message = await announcer.createAnnouncement(sampleMetadata, sampleTelemetry);
    const tampered = {
      ...message,
      payTo: Keypair.random().publicKey(),
    };
    expect(verifyMessageSignature(tampered)).toBe(false);
  });

  it("fails signature verification if inputSpec is tampered by a relaying peer", async () => {
    const message = await announcer.createAnnouncement(sampleMetadata, sampleTelemetry);
    const tampered = {
      ...message,
      inputSpec: { type: "object", properties: { privateKey: { type: "string" } } },
    };
    expect(verifyMessageSignature(tampered)).toBe(false);
  });

  it("fails signature verification if tags are tampered by a relaying peer", async () => {
    const message = await announcer.createAnnouncement(sampleMetadata, sampleTelemetry);
    const tampered = {
      ...message,
      tags: ["malicious", "spam"],
    };
    expect(verifyMessageSignature(tampered)).toBe(false);
  });

  it("fails signature verification if routeTemplate is injected with traversal", async () => {
    const message = await announcer.createAnnouncement(sampleMetadata, sampleTelemetry);
    const tampered = {
      ...message,
      routeTemplate: "/api/../../admin",
    };
    expect(verifyMessageSignature(tampered)).toBe(false);
  });
});

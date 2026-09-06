import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  Announcer,
  CatalogDeltaSchema,
  catalogDeltaDigest,
  createCatalogDeltaSignaturePayload,
} from "../p2p/index.js";
import {
  compareCatalogDelta,
  createCatalogDeltaState,
  shouldApplyCatalogDelta,
  verifyCatalogDelta,
} from "../p2p/catalog-delta.js";

const seller = Keypair.random();
const announcer = new Announcer(seller);
const settlementTx = "a".repeat(64);

async function makeDelta(revision: number, overrides: Record<string, unknown> = {}) {
  return announcer.createSignedCatalogDelta({
    op: "upsert",
    resourceUrl: "https://provider.example/fx",
    toolName: "",
    payTo: seller.publicKey(),
    network: "stellar:testnet",
    revision,
    issuedAt: 1_700_000_000,
    expiresAt: 1_700_000_600,
    state: {
      resourceType: "http",
      description: "FX data",
      mimeType: "application/json",
      inputSpec: {},
      scheme: "exact",
      asset: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
      amount: "100000",
      settlementTx,
      ...overrides,
    },
  });
}

describe("signed catalog deltas", () => {
  it("verifies the same canonical payload that the announcer signs", async () => {
    const delta = await makeDelta(1);
    expect(verifyCatalogDelta(delta, {
      nowSeconds: 1_700_000_100,
      expectedPayTo: seller.publicKey(),
      expectedNetwork: "stellar:testnet",
    })).toEqual({ valid: true });
    expect(createCatalogDeltaSignaturePayload(delta)).not.toContain('"signer"');
  });

  it("rejects tampering, stale statements, and unauthorized signers", async () => {
    const delta = await makeDelta(1);
    expect(verifyCatalogDelta({ ...delta, revision: 2 }, { nowSeconds: 1_700_000_100 }).valid).toBe(false);
    expect(verifyCatalogDelta(delta, { nowSeconds: 1_700_001_000 }).valid).toBe(false);
    expect(verifyCatalogDelta(delta, {
      nowSeconds: 1_700_000_100,
      authorizedSigners: [Keypair.random().publicKey()],
    }).valid).toBe(false);
  });

  it("converges independent nodes regardless of delivery order", async () => {
    const first = await makeDelta(1, { description: "first" });
    const second = await makeDelta(2, { description: "second" });
    const conflictA = await makeDelta(3, { description: "conflict-a" });
    const conflictB = await makeDelta(3, { description: "conflict-b" });

    for (const order of [[first, second, conflictA, conflictB], [conflictB, first, conflictA, second]]) {
      let state;
      for (const delta of order) {
        if (shouldApplyCatalogDelta(state, delta)) state = createCatalogDeltaState(delta);
      }
      expect(state?.delta).toEqual(compareCatalogDelta(conflictA, conflictB) > 0 ? conflictA : conflictB);
      expect(CatalogDeltaSchema.parse(state?.delta)).toBeTruthy();
    }
  });

  it("keeps revoke as a tombstone and allows a later revision to restore", async () => {
    const upsert = await makeDelta(1);
    const revoke = announcer.createSignedCatalogDelta({
      ...upsert,
      op: "revoke",
      state: null,
      revision: 2,
    });
    const restored = await makeDelta(3);

    let state = createCatalogDeltaState(upsert);
    if (shouldApplyCatalogDelta(state, revoke)) state = createCatalogDeltaState(revoke);
    expect(state.delta.op).toBe("revoke");
    if (shouldApplyCatalogDelta(state, restored)) state = createCatalogDeltaState(restored);
    expect(state.delta.op).toBe("upsert");
    expect(catalogDeltaDigest(state.delta)).toBe(catalogDeltaDigest(restored));
  });
});
import { afterEach, describe, expect, it } from "vitest";
import { Announcer } from "../p2p/announcer.js";
import { P2PNode } from "../p2p/node.js";
import { BAZAAR_CATALOG_DELTA_TOPIC } from "../p2p/types.js";
import {
  createCatalogDeltaState,
  shouldApplyCatalogDelta,
  type AppliedCatalogDelta,
} from "../p2p/catalog-delta.js";

const nodes: P2PNode[] = [];

afterEach(async () => {
  await Promise.all(nodes.splice(0).map((node) => node.stop()));
});

describe("active P2P catalog-delta transport", () => {
  it("relays one signed delta from producer to an authorized peer", async () => {
    const producer = new P2PNode({ listenAddrs: ["/ip4/127.0.0.1/tcp/0"], heartbeatIntervalMs: 30_000, maxMissedHeartbeats: 3 });
    const observer = new P2PNode({ listenAddrs: ["/ip4/127.0.0.1/tcp/0"], heartbeatIntervalMs: 30_000, maxMissedHeartbeats: 3 });
    nodes.push(producer, observer);
    await producer.start();
    await observer.start();
    const producerAddress = (producer as any).libp2p.getMultiaddrs()[0];
    await observer["libp2p"].dial(producerAddress);

    for (let attempt = 0; attempt < 20; attempt++) {
      const subscribers = producer["libp2p"].services.pubsub.getSubscribers(BAZAAR_CATALOG_DELTA_TOPIC);
      if (subscribers.some((peer: { toString(): string }) => peer.toString() === observer.getPeerId())) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    let received = 0;
    let applied: AppliedCatalogDelta | undefined;
    observer.onCatalogDelta(async (incoming) => {
      received++;
      if (shouldApplyCatalogDelta(applied, incoming)) {
        applied = createCatalogDeltaState(incoming);
      }
    });
    const announcer = new Announcer((await import("@stellar/stellar-sdk")).Keypair.random());
    const seller = announcer.getPublicKey();
    const upsert = announcer.createSignedCatalogDelta({
      op: "upsert",
      resourceUrl: "https://provider.example/fx",
      toolName: "",
      payTo: seller,
      network: "stellar:testnet",
      revision: 1,
      issuedAt: Math.floor(Date.now() / 1000),
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      state: {
        resourceType: "http",
        description: "FX",
        mimeType: "application/json",
        inputSpec: {},
        scheme: "exact",
        asset: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
        amount: "100000",
        settlementTx: "a".repeat(64),
      },
    });
    const revoke = announcer.createSignedCatalogDelta({
      ...upsert,
      op: "revoke",
      state: null,
      revision: 2,
    });
    const restored = announcer.createSignedCatalogDelta({
      ...upsert,
      revision: 3,
      state: {
        ...upsert.state!,
        description: "FX restored",
      },
    });

    const waitForMessages = async (expected: number) => {
      for (let attempt = 0; attempt < 20 && received < expected; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(received).toBeGreaterThanOrEqual(expected);
    };

    // Deliberately publish the revoke before the original upsert. Arrival order
    // must not determine the durable catalog state.
    await producer.publishCatalogDelta(revoke);
    await waitForMessages(1);
    await producer.publishCatalogDelta(upsert);
    await waitForMessages(2);
    await producer.publishCatalogDelta(restored);
    await waitForMessages(3);

    expect(applied?.delta.op).toBe("upsert");
    expect(applied?.delta.revision).toBe(3);
    expect(applied?.delta.state?.description).toBe("FX restored");
    expect(applied?.digest).toBeTruthy();
    expect(BAZAAR_CATALOG_DELTA_TOPIC).toContain("catalog-delta");
  }, 15_000);

  it("converges signed catalog lifecycle across three independent nodes", async () => {
    const makeNode = () => new P2PNode({
      listenAddrs: ["/ip4/127.0.0.1/tcp/0"],
      heartbeatIntervalMs: 30_000,
      maxMissedHeartbeats: 3,
    });
    const [nodeA, nodeB, nodeC] = [makeNode(), makeNode(), makeNode()];
    nodes.push(nodeA, nodeB, nodeC);
    await Promise.all([nodeA.start(), nodeB.start(), nodeC.start()]);

    const addressA = (nodeA as any).libp2p.getMultiaddrs()[0];
    const addressB = (nodeB as any).libp2p.getMultiaddrs()[0];
    await nodeB["libp2p"].dial(addressA);
    await nodeC["libp2p"].dial(addressB);
    await nodeC["libp2p"].dial(addressA);

    const states = new Map<string, AppliedCatalogDelta | undefined>();
    const received = new Map<string, number>([["A", 0], ["B", 0], ["C", 0]]);
    for (const [name, node] of [["A", nodeA], ["B", nodeB], ["C", nodeC]] as const) {
      node.onCatalogDelta(async (incoming) => {
        received.set(name, (received.get(name) ?? 0) + 1);
        const current = states.get(name);
        if (shouldApplyCatalogDelta(current, incoming)) states.set(name, createCatalogDeltaState(incoming));
      });
    }

    const sellerAnnouncer = new Announcer((await import("@stellar/stellar-sdk")).Keypair.random());
    const seller = sellerAnnouncer.getPublicKey();
    const now = Math.floor(Date.now() / 1000);
    const upsert = sellerAnnouncer.createSignedCatalogDelta({
      op: "upsert",
      resourceUrl: "https://provider.example/fx",
      toolName: "",
      payTo: seller,
      network: "stellar:testnet",
      revision: 1,
      issuedAt: now,
      expiresAt: now + 600,
      state: {
        resourceType: "http",
        description: "FX",
        mimeType: "application/json",
        inputSpec: {},
        scheme: "exact",
        asset: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
        amount: "100000",
        settlementTx: "a".repeat(64),
      },
    });
    const revoke = sellerAnnouncer.createSignedCatalogDelta({ ...upsert, op: "revoke", state: null, revision: 2 });
    const restore = sellerAnnouncer.createSignedCatalogDelta({
      ...upsert,
      revision: 3,
      state: { ...upsert.state!, description: "FX restored", settlementTx: "b".repeat(64) },
    });

    const waitForRevision = async (revision: number) => {
      for (let attempt = 0; attempt < 40; attempt++) {
        const converged = [...states.values()].filter((state) => state?.delta.revision === revision).length;
        if (converged >= 2) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`three-node mesh did not propagate revision ${revision}`);
    };

    await new Promise((resolve) => setTimeout(resolve, 500));
    await nodeA.publishCatalogDelta(upsert);
    await waitForRevision(1);
    await nodeB.publishCatalogDelta(revoke);
    await waitForRevision(2);
    await nodeC.publishCatalogDelta(restore);
    await waitForRevision(3);

    const unauthorized = new Announcer((await import("@stellar/stellar-sdk")).Keypair.random())
      .createSignedCatalogDelta({ ...upsert, revision: 4 });
    await expect(nodeA.publishCatalogDelta(unauthorized)).rejects.toThrow(/signer is not the payTo owner/);

    expect([...states.values()].filter((state) => state?.delta.revision === 3).length).toBeGreaterThanOrEqual(2);
    expect([...states.values()].filter((state) => state?.delta.state?.description === "FX restored").length).toBeGreaterThanOrEqual(2);
    expect([...received.values()].filter((count) => count >= 2).length).toBeGreaterThanOrEqual(2);
  }, 20_000);
});
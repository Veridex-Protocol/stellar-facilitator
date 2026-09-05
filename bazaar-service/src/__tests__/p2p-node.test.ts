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
});
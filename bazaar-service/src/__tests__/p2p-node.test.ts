import { afterEach, describe, expect, it } from "vitest";
import { Announcer } from "../p2p/announcer.js";
import { P2PNode } from "../p2p/node.js";
import { BAZAAR_CATALOG_DELTA_TOPIC } from "../p2p/types.js";

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
    observer.onCatalogDelta(async () => { received++; });
    const announcer = new Announcer((await import("@stellar/stellar-sdk")).Keypair.random());
    const seller = announcer.getPublicKey();
    const delta = announcer.createSignedCatalogDelta({
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
    for (let attempt = 0; attempt < 10 && received === 0; attempt++) {
      await producer.publishCatalogDelta(delta);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(received).toBeGreaterThanOrEqual(1);
    expect(BAZAAR_CATALOG_DELTA_TOPIC).toContain("catalog-delta");
  }, 15_000);
});
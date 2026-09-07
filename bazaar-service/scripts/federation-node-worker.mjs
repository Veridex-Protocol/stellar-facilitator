import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { multiaddr } from "../node_modules/libp2p/node_modules/@multiformats/multiaddr/dist/src/index.js";
import { Database } from "../dist/db/config.js";
import { CatalogIngestionWorker } from "../dist/catalog/ingestion.js";
import { P2PNode } from "../dist/p2p/node.js";
import { BAZAAR_CATALOG_DELTA_TOPIC } from "../dist/p2p/types.js";

const databaseConfig = {
  host: process.env.DATABASE_HOST,
  port: Number(process.env.DATABASE_PORT),
  database: process.env.DATABASE_NAME,
  user: process.env.DATABASE_USER,
  password: process.env.DATABASE_PASSWORD,
};
const database = Database.getInstance(databaseConfig);
const schemaState = await database.getPool().query("SELECT to_regclass('public.catalog_resources') AS catalog_resources");
if (!schemaState.rows[0]?.catalog_resources) {
  await database.getPool().query(await readFile(resolve("bazaar-service/src/db/schema.sql"), "utf8"));
}

const ingestion = new CatalogIngestionWorker(databaseConfig, {
  horizonUrl: process.env.HORIZON_URL,
  sorobanRpcUrl: process.env.SOROBAN_RPC_URL,
  pool: database.getPool(),
});
const node = new P2PNode({
  listenAddrs: ["/ip4/127.0.0.1/tcp/0"],
  heartbeatIntervalMs: 30_000,
  maxMissedHeartbeats: 3,
});

node.onCatalogDelta(async (delta) => {
  const result = await apply(delta);
  process.send?.({ type: "received", revision: delta.revision, operation: delta.op, result });
});

await node.start();
process.send?.({
  type: "ready",
  peerId: node.getPeerId(),
  address: node.libp2p.getMultiaddrs()[0].toString(),
  database: databaseConfig.database,
});

process.on("message", async (message) => {
  const id = message?.id;
  try {
    let result;
    switch (message?.command) {
      case "dial":
        await node.libp2p.dial(multiaddr(message.address));
        result = { connected: true };
        break;
      case "publish": {
        const applied = await apply(message.delta);
        if (applied.status === "applied") await node.publishCatalogDelta(message.delta);
        result = applied;
        break;
      }
      case "snapshot":
        result = await snapshot();
        break;
      case "status":
        result = {
          connectedPeers: node.getStats().connectedPeers,
          topicSubscribers: node.libp2p.services.pubsub.getSubscribers(BAZAAR_CATALOG_DELTA_TOPIC).length,
        };
        break;
      case "stop":
        await node.stop();
        await database.close();
        process.send?.({ id, ok: true, result: { stopped: true } });
        process.exit(0);
        return;
      default:
        throw new Error(`unknown worker command: ${message?.command}`);
    }
    process.send?.({ id, ok: true, result });
  } catch (error) {
    process.send?.({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

async function apply(delta) {
  return ingestion.applyCatalogDelta(delta, {
    authorizedSigners: delta.signer === delta.payTo ? [delta.payTo] : undefined,
  });
}

async function snapshot() {
  const state = await database.getPool().query(
    `SELECT revision::integer AS revision, digest, operation, payload FROM catalog_delta_state
     ORDER BY revision DESC LIMIT 1`,
  );
  const resource = await database.getPool().query(
    `SELECT resource_url, description, soft_dropped, settlement_tx
     FROM catalog_resources ORDER BY updated_at DESC LIMIT 1`,
  );
  return { state: state.rows[0] ?? null, resource: resource.rows[0] ?? null };
}
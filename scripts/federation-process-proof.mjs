import { fork } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { config as loadEnv } from "dotenv";
import { Keypair } from "@stellar/stellar-sdk";
import pg from "../bazaar-service/node_modules/pg/lib/index.js";
import { Announcer } from "../bazaar-service/dist/p2p/announcer.js";
import { catalogDeltaDigest, compareCatalogDelta } from "../bazaar-service/dist/p2p/catalog-delta.js";

const { Client } = pg;

loadEnv({ path: ".env", quiet: true });

const report = JSON.parse(await readFile("conformance-report.json", "utf8"));
if (report.network !== "stellar:testnet" || report.failed !== 0 || !report.settledTransaction) {
  throw new Error("federation proof requires a successful stellar:testnet conformance-report.json");
}
if (!process.env.SELLER_SECRET_KEY || Keypair.fromSecret(process.env.SELLER_SECRET_KEY).publicKey() !== report.seller) {
  throw new Error("SELLER_SECRET_KEY must match the seller in conformance-report.json");
}

const databaseNames = ["veridex_federation_a", "veridex_federation_b", "veridex_federation_c"];
await createDatabases(databaseNames);

const processes = new Map();
const evidence = {
  kind: "veridex-local-multiprocess-federation-proof",
  generatedAt: new Date().toISOString(),
  network: "stellar:testnet",
  settlementTransaction: report.settledTransaction,
  processes: 3,
  databases: databaseNames,
  assertions: {},
  limitations: [
    "Nodes are independent OS processes and PostgreSQL databases on one workstation.",
    "This does not prove independent operators, public reachability, or production federation SLOs.",
  ],
};

try {
  const nodeA = await startNode("A", databaseNames[0]);
  let nodeB = await startNode("B", databaseNames[1]);
  const nodeC = await startNode("C", databaseNames[2]);
  await command(nodeB, "dial", { address: nodeA.address });
  await command(nodeC, "dial", { address: nodeB.address });
  await command(nodeC, "dial", { address: nodeA.address });
  const meshStatus = await waitForStatuses([nodeA, nodeB, nodeC], (status) =>
    status.connectedPeers === 2 && status.topicSubscribers === 2,
  );

  evidence.peerIds = [nodeA.peerId, nodeB.peerId, nodeC.peerId];
  evidence.assertions.distinctTransportIdentities = new Set(evidence.peerIds).size === 3;
  evidence.assertions.fullTopicMesh = meshStatus.every((status) => status.topicSubscribers === 2);

  const announcer = new Announcer(Keypair.fromSecret(process.env.SELLER_SECRET_KEY));
  const now = Math.floor(Date.now() / 1000);
  const base = {
    op: "upsert",
    resourceUrl: "https://federation-proof.example/mcp",
    toolName: "federation_proof",
    payTo: report.seller,
    network: "stellar:testnet",
    revision: 1,
    issuedAt: now,
    expiresAt: now + 600,
    state: {
      resourceType: "mcp",
      description: "Federation process proof",
      mimeType: "application/json",
      inputSpec: { type: "object" },
      scheme: "exact",
      asset: report.asset,
      amount: report.amount,
      settlementTx: report.settledTransaction,
    },
  };
  const upsert = announcer.createSignedCatalogDelta(base);
  assertStatus(await command(nodeA, "publish", { delta: upsert }), "applied", "initial upsert");
  await waitForAll([nodeA, nodeB, nodeC], (snapshot) => snapshot.state?.revision === 1);
  evidence.assertions.aToBToC = true;

  const replay = await command(nodeA, "publish", { delta: upsert });
  assertStatus(replay, "ignored", "replay");
  evidence.assertions.replayIgnored = true;

  const invalidSignature = { ...upsert, signature: Buffer.alloc(64).toString("base64") };
  assertStatus(await command(nodeA, "publish", { delta: invalidSignature }), "rejected", "invalid signature");
  const outsider = new Announcer(Keypair.random()).createSignedCatalogDelta({ ...base, revision: 2 });
  assertStatus(await command(nodeA, "publish", { delta: outsider }), "rejected", "unauthorized signer");
  const stale = announcer.createSignedCatalogDelta({ ...base, issuedAt: now - 1_000, expiresAt: now - 500 });
  assertStatus(await command(nodeA, "publish", { delta: stale }), "rejected", "stale delta");
  evidence.assertions.securityRejections = ["invalid_signature", "unauthorized_signer", "stale"];

  const conflictA = announcer.createSignedCatalogDelta({
    ...base,
    revision: 2,
    state: { ...base.state, description: "conflict-a" },
  });
  const conflictB = announcer.createSignedCatalogDelta({
    ...base,
    revision: 2,
    state: { ...base.state, description: "conflict-b" },
  });
  await Promise.all([
    command(nodeA, "publish", { delta: conflictA }),
    command(nodeC, "publish", { delta: conflictB }),
  ]);
  const winner = compareCatalogDelta(conflictA, conflictB) > 0 ? conflictA : conflictB;
  const winnerDigest = catalogDeltaDigest(winner);
  await waitForAll([nodeA, nodeB, nodeC], (snapshot) => snapshot.state?.digest === winnerDigest);
  evidence.assertions.deterministicConflictDigest = winnerDigest;

  await stopNode(nodeB);
  nodeB = await startNode("B-restarted", databaseNames[1]);
  processes.set("B", nodeB);
  const retained = await command(nodeB, "snapshot");
  if (retained.state?.digest !== winnerDigest) throw new Error("restarted node B did not retain durable state");
  await command(nodeB, "dial", { address: nodeA.address });
  await command(nodeB, "dial", { address: nodeC.address });
  evidence.assertions.restartRetainedState = true;

  const revoke = announcer.createSignedCatalogDelta({ ...base, op: "revoke", state: null, revision: 3 });
  await command(nodeC, "publish", { delta: revoke });
  await waitForAll([nodeA, nodeB, nodeC], (snapshot) =>
    snapshot.state?.revision === 3 && snapshot.resource?.soft_dropped === true,
  );
  evidence.assertions.revokeConverged = true;

  const restore = announcer.createSignedCatalogDelta({
    ...base,
    revision: 4,
    state: { ...base.state, description: "restored after restart" },
  });
  await command(nodeA, "publish", { delta: restore });
  await waitForAll([nodeA, nodeB, nodeC], (snapshot) =>
    snapshot.state?.revision === 4 && snapshot.resource?.soft_dropped === false,
  );
  evidence.assertions.restoreConverged = true;
  evidence.passed = Object.values(evidence.assertions).every(Boolean);
  await writeFile("docs/rfp/federation-process-proof-2026-09-07.json", `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
} finally {
  await Promise.all([...processes.values()].map((node) => stopNode(node).catch(() => undefined)));
}

async function createDatabases(names) {
  const client = new Client({ host: "127.0.0.1", port: 55433, database: "postgres", user: "postgres", password: "federation-test-only" });
  await client.connect();
  try {
    for (const name of names) {
      await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await client.query(`CREATE DATABASE ${name}`);
    }
  } finally {
    await client.end();
  }
}

async function startNode(name, database) {
  const child = fork(resolve("bazaar-service/scripts/federation-node-worker.mjs"), [], {
    env: {
      ...process.env,
      DATABASE_HOST: "127.0.0.1",
      DATABASE_PORT: "55433",
      DATABASE_NAME: database,
      DATABASE_USER: "postgres",
      DATABASE_PASSWORD: "federation-test-only",
      HORIZON_URL: "https://horizon-testnet.stellar.org",
      SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
    },
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const ready = await waitForMessage(child, (message) => message?.type === "ready", 20_000);
  const node = { name, child, ...ready };
  processes.set(name.startsWith("B") ? "B" : name, node);
  return node;
}

async function command(node, commandName, payload = {}) {
  const id = `${node.name}-${Date.now()}-${Math.random()}`;
  node.child.send({ id, command: commandName, ...payload });
  const response = await waitForMessage(node.child, (message) => message?.id === id, 30_000);
  if (!response.ok) throw new Error(`${node.name} ${commandName}: ${response.error}`);
  return response.result;
}

async function stopNode(node) {
  if (!node?.child || node.child.exitCode !== null) return;
  await command(node, "stop");
}

async function waitForAll(nodes, predicate) {
  let snapshots = [];
  for (let attempt = 0; attempt < 80; attempt++) {
    snapshots = await Promise.all(nodes.map((node) => command(node, "snapshot")));
    if (snapshots.every(predicate)) return snapshots;
    await delay(250);
  }
  throw new Error(`federation nodes did not converge before timeout: ${JSON.stringify(snapshots)}`);
}

async function waitForStatuses(nodes, predicate) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const statuses = await Promise.all(nodes.map((node) => command(node, "status")));
    if (statuses.every(predicate)) return statuses;
    await delay(250);
  }
  throw new Error("federation topic mesh did not become ready before timeout");
}

function waitForMessage(child, predicate, timeoutMs) {
  return new Promise((resolveMessage, rejectMessage) => {
    const timeout = setTimeout(() => {
      child.off("message", onMessage);
      child.off("exit", onExit);
      rejectMessage(new Error("worker response timed out"));
    }, timeoutMs);
    const onExit = (code, signal) => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      rejectMessage(new Error(`worker exited before responding (code=${code}, signal=${signal})`));
    };
    const onMessage = (message) => {
      if (!predicate(message)) return;
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("exit", onExit);
      resolveMessage(message);
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

function assertStatus(result, expected, label) {
  if (result.status !== expected) throw new Error(`${label}: expected ${expected}, got ${JSON.stringify(result)}`);
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
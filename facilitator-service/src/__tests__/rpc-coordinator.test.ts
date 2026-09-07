import { describe, expect, it } from "vitest";
import {
  Account,
  Keypair,
  Networks,
  Operation,
  rpc,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { RpcCoordinator } from "../rpc-coordinator.js";

function transactionXdr(): string {
  const source = Keypair.random();
  const transaction = new TransactionBuilder(new Account(source.publicKey(), "1"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.bumpSequence({ bumpTo: "3" }))
    .setTimeout(60)
    .build();
  transaction.sign(source);
  return transaction.toXDR();
}

function rpcResult(id: unknown, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function rpcFailure(id: unknown, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Soroban RPC coordinator", () => {
  it("serves JSON-RPC responses through the actual Stellar SDK client", async () => {
    const coordinator = new RpcCoordinator({
      providers: ["https://primary.example", "https://secondary.example"],
      networkPassphrase: Networks.TESTNET,
      fetchImpl: (async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        return rpcResult(body.id, {
          status: "healthy",
          latestLedger: 123,
          oldestLedger: 100,
          ledgerRetentionWindow: 23,
        });
      }) as typeof fetch,
    });
    const url = await coordinator.start();
    try {
      const client = new rpc.Server(url, { allowHttp: true });
      const health = await client.getHealth();
      expect(health.status).toBe("healthy");
      expect(health.latestLedger).toBe(123);
    } finally {
      await coordinator.stop();
    }
  });

  it("submits to the healthy primary provider", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const coordinator = new RpcCoordinator({
      providers: ["https://primary.example", "https://secondary.example"],
      networkPassphrase: Networks.TESTNET,
      fetchImpl: (async (input, init) => {
        const body = JSON.parse(String(init?.body));
        calls.push({ url: String(input), method: body.method });
        if (body.method === "getHealth") return rpcResult(body.id, { status: "healthy" });
        return rpcResult(body.id, { status: "PENDING", hash: "a".repeat(64) });
      }) as typeof fetch,
    });

    const result = await coordinator.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "sendTransaction",
      params: { transaction: transactionXdr() },
    });

    expect(result.result?.status).toBe("PENDING");
    expect(calls.filter(({ method }) => method === "sendTransaction")).toEqual([
      { url: "https://primary.example", method: "sendTransaction" },
    ]);
  });

  it("fails over before submission when the primary health check is unavailable", async () => {
    const submissions: string[] = [];
    let failovers = 0;
    const latencies: number[] = [];
    const coordinator = new RpcCoordinator({
      providers: ["https://primary.example", "https://secondary.example"],
      networkPassphrase: Networks.TESTNET,
      onFailover: () => failovers++,
      onLatency: (seconds) => latencies.push(seconds),
      fetchImpl: (async (input, init) => {
        const url = String(input);
        const body = JSON.parse(String(init?.body));
        if (body.method === "getHealth" && url.includes("primary")) throw new Error("offline");
        if (body.method === "getHealth") return rpcResult(body.id, { status: "healthy" });
        if (body.method === "sendTransaction") submissions.push(url);
        return rpcResult(body.id, { status: "PENDING", hash: "b".repeat(64) });
      }) as typeof fetch,
    });

    const result = await coordinator.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "sendTransaction",
      params: { transaction: transactionXdr() },
    });

    expect(result.result?.status).toBe("PENDING");
    expect(submissions).toEqual(["https://secondary.example"]);
    expect(failovers).toBe(1);
    expect(latencies.length).toBeGreaterThanOrEqual(3);
    expect(latencies.every((value) => value >= 0)).toBe(true);
  });

  it("fails over a read after a primary JSON-RPC server error", async () => {
    const calls: string[] = [];
    let failures = 0;
    let failovers = 0;
    const coordinator = new RpcCoordinator({
      providers: ["https://primary.example", "https://secondary.example"],
      networkPassphrase: Networks.TESTNET,
      onFailure: () => failures++,
      onFailover: () => failovers++,
      fetchImpl: (async (input, init) => {
        calls.push(String(input));
        const body = JSON.parse(String(init?.body));
        return String(input).includes("primary")
          ? rpcFailure(body.id, -32001, "provider unavailable")
          : rpcResult(body.id, { status: "healthy", latestLedger: 123 });
      }) as typeof fetch,
    });

    const result = await coordinator.handle({ jsonrpc: "2.0", id: 6, method: "getHealth" });

    expect(result.result).toMatchObject({ status: "healthy", latestLedger: 123 });
    expect(calls).toEqual(["https://primary.example", "https://secondary.example"]);
    expect(failures).toBe(1);
    expect(failovers).toBe(1);
  });

  it("reconciles an ambiguous submission hash without sending the transaction twice", async () => {
    const xdr = transactionXdr();
    const expectedHash = TransactionBuilder.fromXDR(xdr, Networks.TESTNET).hash().toString("hex");
    const submissions: string[] = [];
    let reconciliations = 0;
    const coordinator = new RpcCoordinator({
      providers: ["https://primary.example", "https://secondary.example"],
      networkPassphrase: Networks.TESTNET,
      onReconciliation: () => reconciliations++,
      fetchImpl: (async (input, init) => {
        const url = String(input);
        const body = JSON.parse(String(init?.body));
        if (body.method === "getHealth") return rpcResult(body.id, { status: "healthy" });
        if (body.method === "sendTransaction") {
          submissions.push(url);
          throw new DOMException("timed out after acceptance", "TimeoutError");
        }
        if (body.method === "getTransaction") {
          return rpcResult(body.id, url.includes("secondary")
            ? { status: "SUCCESS", latestLedger: 123 }
            : { status: "NOT_FOUND", latestLedger: 122 });
        }
        throw new Error("unexpected method");
      }) as typeof fetch,
    });

    const result = await coordinator.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "sendTransaction",
      params: { transaction: xdr },
    });

    expect(result).toMatchObject({ result: { status: "PENDING", hash: expectedHash } });
    expect(submissions).toEqual(["https://primary.example"]);
    expect(reconciliations).toBe(1);
  });

  it("preserves the hash when every provider still reports not found", async () => {
    const xdr = transactionXdr();
    const expectedHash = TransactionBuilder.fromXDR(xdr, Networks.TESTNET).hash().toString("hex");
    let submissions = 0;
    const coordinator = new RpcCoordinator({
      providers: ["https://primary.example", "https://secondary.example"],
      networkPassphrase: Networks.TESTNET,
      fetchImpl: (async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.method === "getHealth") return rpcResult(body.id, { status: "healthy" });
        if (body.method === "sendTransaction") {
          submissions++;
          throw new DOMException("timed out", "TimeoutError");
        }
        return rpcResult(body.id, { status: "NOT_FOUND", latestLedger: 123 });
      }) as typeof fetch,
    });

    const result = await coordinator.handle({
      jsonrpc: "2.0",
      id: 5,
      method: "sendTransaction",
      params: { transaction: xdr },
    });

    expect(result).toMatchObject({
      result: {
        status: "PENDING",
        hash: expectedHash,
        veridexReconciliation: { state: "uncertain" },
      },
    });
    expect(submissions).toBe(1);
  });

  it("fails safely and records when providers disagree on a final status", async () => {
    let disagreements = 0;
    const coordinator = new RpcCoordinator({
      providers: ["https://primary.example", "https://secondary.example"],
      networkPassphrase: Networks.TESTNET,
      onDisagreement: () => disagreements++,
      fetchImpl: (async (input, init) => {
        const body = JSON.parse(String(init?.body));
        return rpcResult(body.id, {
          status: String(input).includes("primary") ? "SUCCESS" : "FAILED",
          latestLedger: 123,
        });
      }) as typeof fetch,
    });

    const result = await coordinator.handle({
      jsonrpc: "2.0",
      id: 4,
      method: "getTransaction",
      params: { hash: "c".repeat(64) },
    });

    expect(result.error).toMatchObject({ code: -32003 });
    expect(disagreements).toBe(1);
  });
});
/**
 * Soroban JSON-RPC failover and transaction reconciliation coordinator.
 * License: Apache-2.0
 */

import { createServer, type Server } from "node:http";
import { TransactionBuilder } from "@stellar/stellar-sdk";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcRequest["id"];
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

export interface RpcProviderHealth {
  url: string;
  healthy: boolean;
  consecutiveFailures: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
}

export interface RpcCoordinatorOptions {
  providers: string[];
  networkPassphrase: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  onRequest?: () => void;
  onFailure?: () => void;
  onFailover?: () => void;
  onLatency?: (seconds: number) => void;
  onReconciliation?: () => void;
  onDisagreement?: () => void;
}

const FINAL_STATUSES = new Set(["SUCCESS", "FAILED"]);

export class RpcCoordinator {
  private readonly providers: RpcProviderHealth[];
  private readonly options: Required<Omit<RpcCoordinatorOptions, "providers" | "networkPassphrase">> & {
    networkPassphrase: string;
  };
  private server?: Server;
  private localUrl?: string;

  constructor(options: RpcCoordinatorOptions) {
    const providers = [...new Set(options.providers.map((value) => value.trim()).filter(Boolean))];
    if (providers.length < 2) throw new Error("RPC failover requires at least two distinct providers");
    for (const provider of providers) {
      const url = new URL(provider);
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("RPC providers must use HTTP or HTTPS");
    }
    this.providers = providers.map((url) => ({ url, healthy: true, consecutiveFailures: 0 }));
    this.options = {
      networkPassphrase: options.networkPassphrase,
      requestTimeoutMs: options.requestTimeoutMs ?? 5_000,
      fetchImpl: options.fetchImpl ?? fetch,
      onRequest: options.onRequest ?? (() => undefined),
      onFailure: options.onFailure ?? (() => undefined),
      onFailover: options.onFailover ?? (() => undefined),
      onLatency: options.onLatency ?? (() => undefined),
      onReconciliation: options.onReconciliation ?? (() => undefined),
      onDisagreement: options.onDisagreement ?? (() => undefined),
    };
  }

  async start(): Promise<string> {
    if (this.localUrl) return this.localUrl;
    this.server = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonRpcRequest;
        const result = await this.handle(payload);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(result));
      } catch (error) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: safeMessage(error) },
        }));
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("RPC coordinator failed to bind");
    this.localUrl = `http://127.0.0.1:${address.port}`;
    return this.localUrl;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => this.server!.close((error) => error ? reject(error) : resolve()));
    this.server = undefined;
    this.localUrl = undefined;
  }

  getHealth(): RpcProviderHealth[] {
    return this.providers.map((provider) => ({ ...provider }));
  }

  async handle(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (request.method === "sendTransaction") return this.handleSubmission(request);
    if (request.method === "getTransaction") return this.handleTransactionStatus(request);
    return this.handleRead(request);
  }

  private async handleRead(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    let lastError: unknown;
    for (const provider of this.orderedProviders()) {
      try {
        const response = await this.call(provider, request);
        if (provider !== this.providers[0]) this.options.onFailover();
        return response;
      } catch (error) {
        lastError = error;
      }
    }
    return rpcError(request.id, -32001, `all RPC providers failed: ${safeMessage(lastError)}`);
  }

  private async handleSubmission(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const transaction = request.params?.transaction;
    if (typeof transaction !== "string") return rpcError(request.id, -32602, "sendTransaction requires params.transaction");
    const hash = this.transactionHash(transaction);

    let provider: RpcProviderHealth | undefined;
    for (const candidate of this.orderedProviders()) {
      if (await this.probe(candidate)) {
        provider = candidate;
        break;
      }
    }
    if (!provider) return rpcError(request.id, -32001, "no healthy RPC provider is available before submission");
    if (provider !== this.providers[0]) this.options.onFailover();

    try {
      return await this.call(provider, request);
    } catch (error) {
      const reconciled = await this.reconcile(hash, request.id);
      if (reconciled.error) return reconciled;
      const status = reconciled.result?.status;
      if (status === "SUCCESS" || status === "PENDING" || status === "DUPLICATE") {
        return { jsonrpc: "2.0", id: request.id, result: { status: "PENDING", hash } };
      }
      if (status === "FAILED") {
        return { jsonrpc: "2.0", id: request.id, result: { ...reconciled.result, hash } };
      }
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          status: "PENDING",
          hash,
          diagnosticEventsXdr: [],
          veridexReconciliation: {
            state: "uncertain",
            reason: safeMessage(error),
          },
        },
      };
    }
  }

  private async handleTransactionStatus(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const hash = request.params?.hash;
    if (typeof hash !== "string") return rpcError(request.id, -32602, "getTransaction requires params.hash");
    return this.reconcile(hash, request.id);
  }

  private async reconcile(hash: string, id: JsonRpcRequest["id"]): Promise<JsonRpcResponse> {
    this.options.onReconciliation();
    const request: JsonRpcRequest = { jsonrpc: "2.0", id, method: "getTransaction", params: { hash } };
    const responses: JsonRpcResponse[] = [];
    for (const provider of this.orderedProviders()) {
      try {
        const response = await this.call(provider, request);
        if (!response.error) responses.push(response);
      } catch {
        // Health is recorded by call(); another provider may still know the final state.
      }
    }
    const finals = new Set(
      responses.map((response) => response.result?.status).filter((status) => FINAL_STATUSES.has(status)),
    );
    if (finals.size > 1) {
      this.options.onDisagreement();
      return rpcError(id, -32003, `RPC providers disagree on final status for transaction ${hash}`, {
        hash,
        statuses: [...finals],
      });
    }
    const final = responses.find((response) => FINAL_STATUSES.has(response.result?.status));
    if (final) return final;
    const pending = responses.find((response) => response.result?.status !== "NOT_FOUND");
    return pending ?? responses[0] ?? rpcError(id, -32001, "all RPC providers failed during transaction reconciliation", { hash });
  }

  private async probe(provider: RpcProviderHealth): Promise<boolean> {
    try {
      const response = await this.call(provider, { jsonrpc: "2.0", id: 0, method: "getHealth" });
      return !response.error;
    } catch {
      return false;
    }
  }

  private async call(provider: RpcProviderHealth, request: JsonRpcRequest): Promise<JsonRpcResponse> {
    this.options.onRequest();
    const startedAt = performance.now();
    try {
      const response = await this.options.fetchImpl(provider.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.options.requestTimeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as JsonRpcResponse;
      const rpcFailure = body.error;
      if (isRetryableProviderError(rpcFailure)) {
        throw new Error(`JSON-RPC ${rpcFailure.code}: ${rpcFailure.message}`);
      }
      provider.healthy = true;
      provider.consecutiveFailures = 0;
      provider.lastSuccessAt = Date.now();
      return body;
    } catch (error) {
      provider.healthy = false;
      provider.consecutiveFailures++;
      provider.lastFailureAt = Date.now();
      this.options.onFailure();
      throw error;
    } finally {
      this.options.onLatency((performance.now() - startedAt) / 1000);
    }
  }

  private orderedProviders(): RpcProviderHealth[] {
    return [...this.providers].sort((left, right) => Number(right.healthy) - Number(left.healthy));
  }

  private transactionHash(transactionXdr: string): string {
    return TransactionBuilder
      .fromXDR(transactionXdr, this.options.networkPassphrase)
      .hash()
      .toString("hex");
  }
}

function isRetryableProviderError(
  error: JsonRpcResponse["error"],
): error is NonNullable<JsonRpcResponse["error"]> {
  return Boolean(error && error.code >= -32099 && error.code <= -32000);
}

function rpcError(id: JsonRpcRequest["id"], code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 240);
}
/**
 * Veridex Bazaar - Settlement Proof
 * License: Apache-2.0
 *
 * Catalog integrity rests on one rule: a resource is listed because someone
 * actually paid it, and the Bazaar confirms that itself.
 *
 * Ingestion previously accepted a `settlementSucceeded: true` boolean and a
 * `payTo` address chosen by the caller, guarded only by a shared bearer token
 * that was skipped entirely when the environment variable was unset. That is a
 * catalog bound to trust in the caller, not to a settlement. This module
 * replaces the assertion with a lookup: the named transaction must exist on the
 * configured network, must have succeeded, and must have credited the `payTo`
 * the entry claims.
 *
 * Resource ownership and anti-hijack protection:
 * 1. Database Invariant: Once an entry is catalogued under a `payTo` address,
 *    subsequent settlements for a different `payTo` CANNOT overwrite it
 *    (enforced in ingestion.ts and SQL WHERE catalog_resources.pay_to = EXCLUDED.pay_to).
 * 2. Cryptographic Owner Signature: Sellers can cryptographically sign the
 *    (resourceUrl, payTo, toolName, timestamp) tuple using Ed25519 (owner-signature.ts),
 *    verifying authentic ownership before ingestion.
 */

/** Horizon effect types that represent value arriving at an address. */
const CREDIT_EFFECTS = new Set(["account_credited", "contract_credited"]);

export interface UptoSettlementEvent {
  contractId?: string;
  topics: unknown[];
  data: unknown;
}

export interface UptoTransactionProof {
  status: string;
  ledger?: number;
  createdAt?: string;
  events: UptoSettlementEvent[];
}

export interface SettlementProofResult {
  valid: boolean;
  reason?: string;
  ledger?: number;
  createdAt?: string;
}

export interface SettlementProofOptions {
  horizonUrl: string;
  sorobanRpcUrl?: string;
  /** Reject settlements older than this. Defaults to 24 hours. */
  maxAgeMs?: number;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  scheme?: string;
  uptoContractId?: string;
  expectedToken?: string;
  expectedMaxAmount?: string;
  expectedActual?: string;
  expectedResultDigest?: string;
  fetchUptoTransaction?: (transactionHash: string) => Promise<UptoTransactionProof>;
}

/**
 * Confirms a settlement transaction exists, succeeded, and credited `payTo`.
 *
 * @param transactionHash - The settlement transaction hash
 * @param payTo - The address the catalog entry claims was paid
 * @param options - Horizon endpoint and freshness policy
 * @returns Whether the settlement backs this entry, and why not when it does not
 */
export async function verifySettlement(
  transactionHash: string,
  payTo: string,
  options: SettlementProofOptions,
): Promise<SettlementProofResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const horizon = options.horizonUrl.replace(/\/+$/, "");
  const maxAgeMs = options.maxAgeMs ?? 24 * 60 * 60 * 1000;

  if (!/^[0-9a-f]{64}$/i.test(transactionHash)) {
    return { valid: false, reason: "settlementTx is not a Stellar transaction hash" };
  }

  let transaction: any;
  try {
    const response = await doFetch(`${horizon}/transactions/${transactionHash}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) {
      return { valid: false, reason: "settlementTx does not exist on this network" };
    }
    if (!response.ok) {
      return { valid: false, reason: `Horizon returned HTTP ${response.status} for settlementTx` };
    }
    transaction = await response.json();
  } catch (error: any) {
    return {
      valid: false,
      reason: `Horizon could not be reached to confirm settlementTx: ${error?.message ?? String(error)}`,
    };
  }

  if (transaction.successful !== true) {
    return { valid: false, reason: "settlementTx exists but the network rejected it" };
  }

  const createdAt = Date.parse(transaction.created_at);
  if (Number.isFinite(createdAt) && Date.now() - createdAt > maxAgeMs) {
    return {
      valid: false,
      reason: `settlementTx is older than ${Math.round(maxAgeMs / 3_600_000)}h; catalog entries must be backed by a recent payment`,
    };
  }

  // The transaction succeeded. Now confirm it moved value to the address this
  // entry claims, rather than to anyone at all.
  let effects: any;
  try {
    const response = await doFetch(`${horizon}/transactions/${transactionHash}/effects?limit=200`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return { valid: false, reason: `Horizon returned HTTP ${response.status} for settlement effects` };
    }
    effects = await response.json();
  } catch (error: any) {
    return {
      valid: false,
      reason: `Horizon could not be reached to confirm the settlement credited payTo: ${error?.message ?? String(error)}`,
    };
  }

  const records: any[] = effects?._embedded?.records ?? [];
  const creditedPayTo = records.some(
    (effect) => CREDIT_EFFECTS.has(effect.type) && (effect.account === payTo || effect.contract === payTo),
  );

  if (!creditedPayTo) {
    return {
      valid: false,
      reason: `settlementTx succeeded but credited no value to ${payTo}, so it does not back this catalog entry`,
    };
  }

  if (options.scheme === "upto") {
    const eventProof = await verifyUptoSettlementEvent(transactionHash, payTo, options);
    if (!eventProof.valid) return eventProof;
  }

  return { valid: true, ledger: transaction.ledger, createdAt: transaction.created_at };
}

async function verifyUptoSettlementEvent(
  transactionHash: string,
  payTo: string,
  options: SettlementProofOptions,
): Promise<SettlementProofResult> {
  if (!options.uptoContractId || !options.expectedToken || !options.expectedMaxAmount ||
      !options.expectedActual || !options.expectedResultDigest) {
    return { valid: false, reason: "upto settlement proof is missing contract, amount, token, or result digest bindings" };
  }

  try {
    const transaction = options.fetchUptoTransaction
      ? await options.fetchUptoTransaction(transactionHash)
      : await fetchUptoTransactionFromRpc(transactionHash, options);
    if (transaction.status.toUpperCase() !== "SUCCESS") {
      return { valid: false, reason: "upto settlement RPC transaction did not succeed" };
    }

    const event = transaction.events.find((candidate) =>
      candidate.contractId === options.uptoContractId &&
      candidate.topics[0] === "settled" &&
      candidate.topics[2] === payTo,
    );
    if (!event) {
      return { valid: false, reason: "upto settlement has no matching Settled contract event" };
    }

    const token = readEventField(event.data, "token");
    const maxAmount = atomicString(readEventField(event.data, "max_amount"));
    const actual = atomicString(readEventField(event.data, "actual"));
    const resultDigest = digestString(readEventField(event.data, "result_digest"));
    if (token !== options.expectedToken) return { valid: false, reason: "upto Settled event token does not match the payment" };
    if (maxAmount !== options.expectedMaxAmount) return { valid: false, reason: "upto Settled event ceiling does not match the payment" };
    if (actual !== options.expectedActual) return { valid: false, reason: "upto Settled event actual amount does not match the payment" };
    if (resultDigest !== options.expectedResultDigest.toLowerCase()) return { valid: false, reason: "upto Settled event result digest does not match the response" };
    return { valid: true, ledger: transaction.ledger, createdAt: transaction.createdAt };
  } catch (error) {
    return { valid: false, reason: `could not decode upto settlement event: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function fetchUptoTransactionFromRpc(
  transactionHash: string,
  options: SettlementProofOptions,
): Promise<UptoTransactionProof> {
  if (!options.sorobanRpcUrl) {
    throw new Error("SOROBAN_RPC_URL is required for upto settlement proof");
  }
  const { humanizeEvents, rpc } = await import("@stellar/stellar-sdk");
  const result = await new rpc.Server(options.sorobanRpcUrl).getTransaction(transactionHash) as any;
  const contractEvents = result.events?.contractEventsXdr?.flat() ?? [];
  return {
    status: String(result.status),
    ledger: result.ledger,
    createdAt: result.createdAt,
    events: humanizeEvents(contractEvents) as UptoSettlementEvent[],
  };
}

function readEventField(data: unknown, key: string): unknown {
  if (data instanceof Map) return data.get(key);
  if (data && typeof data === "object") return (data as Record<string, unknown>)[key];
  return undefined;
}

function atomicString(value: unknown): string {
  if (typeof value === "bigint" || typeof value === "number" || typeof value === "string") return String(value);
  throw new Error("event atomic amount is not an integer");
}

function digestString(value: unknown): string {
  if (typeof value === "string" && /^sha256:[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return `sha256:${Buffer.from(value).toString("hex")}`;
  }
  throw new Error("event result digest is not a 32-byte value");
}

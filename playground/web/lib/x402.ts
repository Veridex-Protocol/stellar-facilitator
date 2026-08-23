/**
 * The x402 payment flow, driven from the browser.
 * License: Apache-2.0
 *
 * Every protocol operation here comes from the stock packages: `@x402/core`
 * decodes the challenge and encodes the payment header, `@x402/stellar` builds
 * and signs the Soroban transaction. The playground contributes no protocol
 * code of its own - which is the point, because a playground that reimplemented
 * the client would be demonstrating itself rather than the facilitator.
 *
 * The one thing that is not stock is how the seller is reached. See `callSeller`.
 */

import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import type { PlaygroundConfig } from "./config.js";
import type { Trace } from "./trace.js";
import type { Wallet } from "./wallet.js";

export interface SellerResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface PaymentRun {
  supported: any;
  terms: any;
  challenge: any;
  paymentPayload: any;
  verifyResponse: any;
  settleResponse: any;
  resourceBody: unknown;
  transaction: string;
  extensionResponses?: string;
}

/**
 * Calls the seller through the playground's allowlisted proxy.
 *
 * An x402 seller has no reason to send CORS headers for a playground origin, so
 * a browser cannot read `PAYMENT-REQUIRED` off a 402 from one - the response is
 * opaque. The proxy relays the exchange verbatim so the headers survive.
 *
 * What does not go through the proxy is the signing. The payload handed here is
 * already signed in this tab, and the key never leaves it.
 *
 * @param url - The resource URL
 * @param init - Method and protocol headers to relay
 * @returns The seller's status, headers and body
 * @throws {Error} When the proxy refuses or the seller is unreachable
 */
export async function callSeller(
  url: string,
  init: { method?: string; headers?: Record<string, string> } = {},
): Promise<SellerResponse> {
  const response = await fetch("/api/resource", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url, method: init.method ?? "GET", headers: init.headers ?? {} }),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.message ?? `resource proxy returned HTTP ${response.status}`);
  }
  return payload as SellerResponse;
}

/**
 * Reads a header case-insensitively.
 *
 * Header names survive the proxy with whatever casing the seller used, and HTTP
 * does not promise any particular one.
 *
 * @param headers - The header map
 * @param name - Header name to find
 * @returns The value, or undefined
 */
export function header(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

/**
 * POSTs to the facilitator.
 *
 * The browser reaches the facilitator directly: it sends permissive CORS and
 * exposes `EXTENSION-RESPONSES`, so no relay is needed and none is used.
 *
 * @param config - Playground configuration
 * @param path - Endpoint path
 * @param body - JSON body
 * @returns Status, parsed body and response headers
 */
export async function postFacilitator(
  config: PlaygroundConfig,
  path: string,
  body: unknown,
): Promise<{ status: number; body: any; headers: Headers }> {
  const response = await fetch(`${config.facilitatorUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text), headers: response.headers };
  } catch {
    throw new Error(`${path} returned non-JSON (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }
}

/**
 * Builds a signed payment payload for the given terms.
 *
 * Mirrors the conformance harness: the stock client scheme produces the signed
 * transaction, and the terms the client agreed to are echoed back in `accepted`
 * alongside the seller's discovery metadata.
 *
 * @param wallet - The buyer's wallet
 * @param network - CAIP-2 network identifier
 * @param terms - The payment requirements being signed against
 * @param echo - The 402's resource and extensions blocks, echoed for cataloging
 * @returns A complete PaymentPayload
 */
export async function signPayload(
  wallet: Wallet,
  network: string,
  terms: any,
  echo?: Record<string, unknown>,
): Promise<any> {
  const signer = createEd25519Signer(wallet.secret, network as any);
  const scheme = new ExactStellarScheme(signer);
  const partial = await scheme.createPaymentPayload(2, terms);
  return { ...partial, accepted: terms, ...(echo ?? {}) };
}

/**
 * Runs a full seller-mediated payment, recording every exchange in the trace.
 *
 * This is the flow a real buyer takes: ask, get told the price, sign, ask again
 * with the payment attached. The `/verify` call in the middle is not required
 * by the protocol - a buyer can go straight to paying - but it is where the
 * facilitator will tell you *why* a payment would be refused without spending
 * anything, so the playground always makes it.
 *
 * @param config - Playground configuration
 * @param wallet - The buyer's wallet
 * @param trace - Trace to record into
 * @returns Everything the run produced
 */
export async function runPayment(
  config: PlaygroundConfig,
  wallet: Wallet,
  trace: Trace,
): Promise<PaymentRun> {
  trace.plan([
    {
      id: "supported",
      title: "Ask the facilitator what it supports",
      note: "GET /supported. Every field here was checked against the network before the facilitator would start.",
    },
    {
      id: "challenge",
      title: "Ask the seller for the resource, without paying",
      note: "The seller answers 402 and names its terms in a PAYMENT-REQUIRED header.",
    },
    {
      id: "sign",
      title: "Sign a payment for exactly those terms",
      note: "Built and signed in this tab by @x402/stellar. The key does not leave the browser.",
    },
    {
      id: "verify",
      title: "Ask the facilitator to check it, without settling",
      note: "POST /verify. A dry run: nothing moves, and a refusal explains itself.",
    },
    {
      id: "pay",
      title: "Ask again, with the payment attached",
      note: "The seller hands the payment to the facilitator, which settles it on Stellar, and serves the resource.",
    },
    {
      id: "confirm",
      title: "Confirm the settlement on the public ledger",
      note: "Read straight from Horizon. If the facilitator invented a hash, this is where it falls apart.",
    },
  ]);

  const supported = await trace.run("supported", async (record) => {
    const response = await fetch(`${config.facilitatorUrl}/supported`);
    if (!response.ok) throw new Error(`/supported returned HTTP ${response.status}`);
    const body = await response.json();
    const exact = body.kinds?.find(
      (kind: any) => kind.scheme === "exact" && kind.network === config.network,
    );
    if (!exact) {
      throw new Error(
        `This facilitator does not advertise the exact scheme on ${config.network}.`,
      );
    }
    record({
      response: body,
      summary: `${body.kinds.length} scheme/network pair(s); fees sponsored: ${
        exact.extra?.areFeesSponsored ?? "not stated"
      }`,
    });
    return body;
  });

  const { terms, challenge, echo } = await trace.run("challenge", async (record) => {
    const response = await callSeller(config.paidResourceUrl, { headers: { accept: "application/json" } });
    record({ request: { method: "GET", url: config.paidResourceUrl } });

    if (response.status !== 402) {
      throw new Error(
        `Expected 402 from the seller, got ${response.status}. ` +
          "Either the resource is not paywalled or the seller is misconfigured.",
      );
    }

    const raw = header(response.headers, "PAYMENT-REQUIRED");
    if (!raw) throw new Error("The 402 carries no PAYMENT-REQUIRED header.");

    const decoded: any = decodePaymentRequiredHeader(raw);
    const accepted = decoded.accepts?.find((entry: any) => entry.network === config.network);
    if (!accepted) {
      throw new Error(`The seller accepts no terms on ${config.network}.`);
    }

    record({
      response: { status: response.status, paymentRequired: decoded },
      summary: `${accepted.amount} atomic units to ${accepted.payTo.slice(0, 8)}…`,
    });

    return {
      terms: accepted,
      challenge: decoded,
      echo: { resource: decoded.resource, extensions: decoded.extensions },
    };
  });

  const paymentPayload = await trace.run("sign", async (record) => {
    const payload = await signPayload(wallet, config.network, terms, echo);
    record({
      response: payload,
      summary: `signed envelope, ${payload.payload.transaction.length} base64 chars`,
    });
    return payload;
  });

  const verifyResponse = await trace.run("verify", async (record) => {
    const request = { paymentPayload, paymentRequirements: terms };
    record({ request });
    const { body } = await postFacilitator(config, "/verify", request);
    record({
      response: body,
      summary: body.isValid ? "valid - nothing settled yet" : `refused: ${body.invalidReason}`,
    });
    if (!body.isValid) {
      throw new Error(`${body.invalidReason}: ${body.invalidMessage}`);
    }
    return body;
  });

  const paid = await trace.run("pay", async (record) => {
    const headers = {
      accept: "application/json",
      ...encodeSignatureHeader(paymentPayload),
    };
    record({ request: { method: "GET", url: config.paidResourceUrl, headers } });

    const response = await callSeller(config.paidResourceUrl, { headers });
    if (response.status !== 200) {
      throw new Error(
        `Expected 200 after paying, got ${response.status}: ${response.body.slice(0, 200)}`,
      );
    }

    const settleHeader = header(response.headers, "PAYMENT-RESPONSE") ??
      header(response.headers, "X-PAYMENT-RESPONSE");
    if (!settleHeader) throw new Error("The paid response carries no PAYMENT-RESPONSE header.");

    const settleResponse: any = decodePaymentResponseHeader(settleHeader);
    let resourceBody: unknown = response.body;
    try {
      resourceBody = JSON.parse(response.body);
    } catch {
      // A seller is free to sell something that is not JSON.
    }

    record({
      response: { status: response.status, settleResponse, resource: resourceBody },
      summary: `settled as ${settleResponse.transaction?.slice(0, 12)}…`,
    });

    return {
      settleResponse,
      resourceBody,
      extensionResponses: header(response.headers, "EXTENSION-RESPONSES"),
    };
  });

  await trace.run("confirm", async (record) => {
    const hash = paid.settleResponse.transaction;
    const found = await horizonTransaction(config, hash);
    record({
      response: {
        hash,
        successful: found.successful,
        ledger: found.ledger,
        created_at: found.created_at,
        fee_charged: found.fee_charged,
        source_account: found.source_account,
      },
      summary: `ledger ${found.ledger}, fee ${found.fee_charged} stroops, paid by the facilitator`,
    });
    if (found.successful !== true) {
      throw new Error(`Horizon reports transaction ${hash} was not successful.`);
    }
    return found;
  });

  return {
    supported,
    terms,
    challenge,
    paymentPayload,
    verifyResponse,
    settleResponse: paid.settleResponse,
    resourceBody: paid.resourceBody,
    transaction: paid.settleResponse.transaction,
    extensionResponses: paid.extensionResponses,
  };
}

/**
 * Encodes the payment header for a v2 payload.
 *
 * @param paymentPayload - The signed payload
 * @returns A header map to merge into the request
 */
export function encodeSignatureHeader(paymentPayload: any): Record<string, string> {
  return { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(paymentPayload) };
}

/**
 * Fetches a transaction from Horizon, waiting for it to be indexed.
 *
 * @param config - Playground configuration
 * @param hash - Transaction hash
 * @param attempts - How many times to poll
 * @returns The Horizon transaction record
 * @throws {Error} When the transaction never appears
 */
export async function horizonTransaction(
  config: PlaygroundConfig,
  hash: string,
  attempts = 12,
): Promise<any> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const response = await fetch(`${config.horizonUrl}/transactions/${hash}`);
    if (response.ok) return response.json();
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Transaction ${hash} never appeared on Horizon after ${attempts} attempts.`);
}

/**
 * Settles a payment directly against the facilitator.
 *
 * The seller-mediated flow above returns the settlement in a header, which
 * carries the transaction but not the facilitator's signed receipt. Asking the
 * facilitator to settle directly returns the whole response body, receipt
 * included - which is what the Receipt panel needs something to verify.
 *
 * This settles a second, real payment. The UI says so before it runs.
 *
 * @param config - Playground configuration
 * @param wallet - The buyer's wallet
 * @param terms - Terms to sign against
 * @param echo - The seller's resource and extensions blocks
 * @returns The settle response, including the receipt
 * @throws {Error} When the facilitator refuses to settle
 */
export async function directSettle(
  config: PlaygroundConfig,
  wallet: Wallet,
  terms: any,
  echo?: Record<string, unknown>,
): Promise<{ paymentPayload: any; settleResponse: any; extensionResponses?: string }> {
  const paymentPayload = await signPayload(wallet, config.network, terms, echo);
  const { status, body, headers } = await postFacilitator(config, "/settle", {
    paymentPayload,
    paymentRequirements: terms,
  });

  if (status !== 200 || body.success !== true) {
    throw new Error(`${body.errorReason ?? `HTTP ${status}`}: ${body.errorMessage ?? ""}`);
  }

  return {
    paymentPayload,
    settleResponse: body,
    extensionResponses: headers.get("EXTENSION-RESPONSES") ?? undefined,
  };
}

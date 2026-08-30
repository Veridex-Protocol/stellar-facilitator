import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import type { PlaygroundConfig, ClientWallet } from "./types";

export { decodePaymentRequiredHeader, decodePaymentResponseHeader };

export function encodeSignatureHeader(paymentPayload: any): Record<string, string> {
  return { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(paymentPayload) };
}

export interface SellerResponse {
  status: number;
  headers: Record<string, string>;
  body: any;
}

export function header(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

export async function callSeller(
  url: string,
  init: { method?: string; headers?: Record<string, string> } = {}
): Promise<SellerResponse> {
  const res = await fetch("/api/resource", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      method: init.method ?? "GET",
      headers: init.headers ?? {},
    }),
  });

  const payload = await res.json();
  if (!res.ok) {
    throw new Error(payload?.message ?? `Resource proxy failed (${res.status})`);
  }
  return payload as SellerResponse;
}

export async function postFacilitator(
  config: PlaygroundConfig,
  path: string,
  body: unknown
): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(`${config.facilitatorUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text), headers: res.headers };
  } catch {
    throw new Error(`${path} returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
}

export async function signPayload(
  wallet: ClientWallet,
  network: string,
  terms: any,
  echo?: Record<string, unknown>
): Promise<any> {
  const signer = createEd25519Signer(wallet.secretKey, network as any);
  const scheme = new ExactStellarScheme(signer);
  const partial = await scheme.createPaymentPayload(2, terms);
  return { ...partial, accepted: terms, ...(echo ?? {}) };
}

export async function horizonTransaction(
  horizonUrl: string,
  hash: string,
  attempts = 12
): Promise<any> {
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(`${horizonUrl}/transactions/${hash}`);
    if (res.ok) return res.json();
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Transaction ${hash} never appeared on Horizon after ${attempts} attempts.`);
}

export async function directSettle(
  config: PlaygroundConfig,
  wallet: ClientWallet,
  terms: any,
  echo?: Record<string, unknown>
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

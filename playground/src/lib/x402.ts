import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import type { PlaygroundConfig, ClientWallet } from "./types";
import { fetchWithTimeout } from "./http";

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

export async function getFacilitatorCapabilities(config: PlaygroundConfig): Promise<any> {
  const url = `${config.facilitatorUrl}/supported`;
  const res = await fetchWithTimeout(url, {}, 10_000, "Facilitator capability request");
  if (!res.ok) throw new Error(`/supported failed (${res.status})`);

  try {
    return await res.json();
  } catch {
    throw new Error(`/supported returned invalid JSON (${res.status})`);
  }
}

export async function getFacilitatorDescriptor(config: PlaygroundConfig): Promise<any> {
  const url = `${config.facilitatorUrl}/.well-known/x402`;
  const res = await fetchWithTimeout(url, {}, 10_000, "Facilitator descriptor request");
  if (!res.ok) throw new Error(`/.well-known/x402 failed (${res.status})`);

  try {
    return await res.json();
  } catch {
    throw new Error(`/.well-known/x402 returned invalid JSON (${res.status})`);
  }
}

export async function callSeller(
  url: string,
  init: { method?: string; headers?: Record<string, string> } = {}
): Promise<SellerResponse> {
  const res = await fetchWithTimeout(
    "/api/resource",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        method: init.method ?? "GET",
        headers: init.headers ?? {},
      }),
    },
    90_000,
    "Seller request"
  );

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
  const url = `${config.facilitatorUrl}${path}`;
  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    60_000,
    `Facilitator ${path} request`
  );
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
    const url = `${horizonUrl}/transactions/${hash}`;
    const res = await fetchWithTimeout(url, {}, 10_000, "Horizon confirmation request");
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

/**
 * Live HTTP x402 payment-term validation for catalog admission and refresh.
 * License: Apache-2.0
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { decodePaymentRequiredHeader } from "@x402/core/http";

export interface ExpectedPaymentTerms {
  resourceUrl: string;
  network: string;
  scheme: string;
  asset: string;
  payTo: string;
  amount: string;
}

export interface LivePaymentTermsResult {
  valid: boolean;
  code?: string;
  reason?: string;
  retryable?: boolean;
}

export interface LivePaymentTermsOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  allowedOrigins?: string[];
  transportOriginMap?: Record<string, string>;
  resolveHost?: (hostname: string) => Promise<string[]>;
}

type PaymentRequiredLike = {
  resource?: string | { url?: string };
  accepts?: Array<{
    network?: string;
    scheme?: string;
    asset?: string;
    payTo?: string;
    amount?: string;
  }>;
};

export async function validateLivePaymentTerms(
  expected: ExpectedPaymentTerms,
  options: LivePaymentTermsOptions = {},
): Promise<LivePaymentTermsResult> {
  const target = await validateTarget(expected.resourceUrl, options);
  if (!target.valid || !target.url) return target;

  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(transportUrl(target.url, options.transportOriginMap), {
      method: "GET",
      redirect: "error",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return reject(
      timeout ? "catalog_live_payment_timeout" : "catalog_live_payment_unavailable",
      timeout ? "live payment-term validation timed out" : `live resource could not be reached: ${safeDetail(message)}`,
      true,
    );
  }

  try {
    if (response.status !== 402) {
      return reject(
        "catalog_live_payment_challenge_missing",
        `live resource returned HTTP ${response.status} instead of an x402 payment challenge`,
        response.status >= 500,
      );
    }

    const header = response.headers.get("payment-required");
    if (!header) {
      return reject(
        "catalog_live_payment_header_missing",
        "live resource returned HTTP 402 without a PAYMENT-REQUIRED header",
        false,
      );
    }

    let challenge: PaymentRequiredLike;
    try {
      challenge = decodePaymentRequiredHeader(header) as PaymentRequiredLike;
    } catch {
      return reject(
        "catalog_live_payment_header_invalid",
        "live resource returned an invalid PAYMENT-REQUIRED header",
        false,
      );
    }

    const liveResource = typeof challenge.resource === "string"
      ? challenge.resource
      : challenge.resource?.url;
    if (!liveResource || canonicalUrl(liveResource) !== canonicalUrl(expected.resourceUrl)) {
      return reject(
        "catalog_live_payment_resource_mismatch",
        "live payment resource does not match submitted discovery metadata",
        false,
      );
    }

    const accepts = Array.isArray(challenge.accepts) ? challenge.accepts : [];
    const checks: Array<[keyof Omit<ExpectedPaymentTerms, "resourceUrl">, string, string]> = [
      ["network", expected.network, "network"],
      ["scheme", expected.scheme, "scheme"],
      ["asset", expected.asset, "asset"],
      ["payTo", expected.payTo, "payTo"],
      ["amount", expected.amount, "amount"],
    ];
    let candidates = accepts;
    for (const [field, value, label] of checks) {
      const matching = candidates.filter((term) => term[field] === value);
      if (matching.length === 0) {
        return reject(
          `catalog_live_payment_${label.toLowerCase()}_mismatch`,
          `live payment ${label} does not match submitted discovery metadata`,
          false,
        );
      }
      candidates = matching;
    }

    return { valid: true };
  } finally {
    await response.body?.cancel().catch(() => undefined);
  }
}

async function validateTarget(
  resourceUrl: string,
  options: LivePaymentTermsOptions,
): Promise<LivePaymentTermsResult & { url?: URL }> {
  let url: URL;
  try {
    url = new URL(resourceUrl);
  } catch {
    return reject("catalog_live_payment_url_invalid", "resource URL is invalid", false);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    return reject(
      "catalog_live_payment_url_unsafe",
      "resource URL must use HTTP or HTTPS and must not contain credentials",
      false,
    );
  }

  const allowedOrigins = new Set((options.allowedOrigins ?? []).map(canonicalOrigin));
  if (allowedOrigins.has(url.origin)) return { valid: true, url };

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".lan") ||
    hostname.endsWith(".localdomain")
  ) {
    return reject("catalog_live_payment_url_unsafe", "resource URL targets a local hostname", false);
  }

  let addresses: string[];
  try {
    addresses = isIP(hostname)
      ? [hostname]
      : await (options.resolveHost ?? resolveHostname)(hostname);
  } catch {
    return reject("catalog_live_payment_unavailable", "resource hostname could not be resolved", true);
  }
  if (addresses.length === 0 || addresses.some(isPrivateOrReservedAddress)) {
    return reject(
      "catalog_live_payment_url_unsafe",
      "resource URL resolves to a private, loopback, link-local, or reserved address",
      false,
    );
  }
  return { valid: true, url };
}

async function resolveHostname(hostname: string): Promise<string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
}

function isPrivateOrReservedAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) return isPrivateOrReservedAddress(normalized.slice(7));
  if (isIP(normalized) === 4) {
    const [first, second] = normalized.split(".").map(Number);
    return first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 192 && second === 0) ||
      (first === 192 && second === 0 && normalized.split(".")[2] === "2") ||
      (first === 198 && (second === 18 || second === 19 || second === 51)) ||
      (first === 203 && second === 0 && normalized.split(".")[2] === "113") ||
      first >= 224;
  }
  if (isIP(normalized) === 6) {
    return normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith("ff");
  }
  return true;
}

function canonicalUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

function canonicalOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function transportUrl(resourceUrl: URL, originMap: Record<string, string> | undefined): URL {
  const mappedOrigin = originMap?.[resourceUrl.origin];
  if (!mappedOrigin) return resourceUrl;
  const base = new URL(mappedOrigin);
  if ((base.protocol !== "http:" && base.protocol !== "https:") || base.username || base.password) {
    throw new Error("configured catalog revalidation transport origin is unsafe");
  }
  const mapped = new URL(resourceUrl.href);
  mapped.protocol = base.protocol;
  mapped.hostname = base.hostname;
  mapped.port = base.port;
  return mapped;
}

function reject(code: string, reason: string, retryable: boolean): LivePaymentTermsResult {
  return { valid: false, code, reason, retryable };
}

function safeDetail(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 160);
}
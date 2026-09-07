import { isIP } from "node:net";
import { StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";
import { GATEWAY_METHODS, GATEWAY_NETWORKS, type GatewayConfig } from "./types.js";

const integerString = /^(0|[1-9][0-9]*)$/;
const contractId = /^C[A-Z2-7]{55}$/;

const RouteSchema = z.object({
  path: z.string().startsWith("/").refine((value) => !value.includes(".."), "route path cannot contain '..'"),
  routeTemplate: z.string().startsWith("/").optional(),
  methods: z.array(z.enum(GATEWAY_METHODS)).min(1).optional(),
  price: z.string().regex(integerString).optional(),
  name: z.string().min(1).max(120).optional(),
  description: z.string().min(1).max(500).optional(),
  tags: z.array(z.string().min(1).max(64)).max(20).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  bazaar: z.object({
    enabled: z.boolean().optional(),
    output: z.record(z.string(), z.unknown()).optional(),
  }).optional(),
  mcp: z.record(z.string(), z.unknown()).optional(),
});

const ConfigSchema = z.object({
  id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  upstream: z.string().url(),
  publicBaseUrl: z.string().url(),
  facilitatorUrl: z.string().url(),
  payTo: z.string().refine(
    (value) => StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value),
    "payTo must be a Stellar G... or C... address",
  ),
  network: z.enum(GATEWAY_NETWORKS),
  asset: z.string().regex(contractId, "asset must be a Stellar SEP-41 contract ID"),
  price: z.string().regex(/^[1-9][0-9]*$/, "price must be a positive atomic-unit integer"),
  name: z.string().min(1).max(120).optional(),
  description: z.string().min(1).max(500).optional(),
  tags: z.array(z.string().min(1).max(64)).max(20).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  routePrefix: z.string().startsWith("/").optional(),
  routes: z.array(RouteSchema).min(1).optional(),
  state: z.enum(["draft", "active", "paused", "disabled"]).optional(),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
  maxRequestBodyBytes: z.number().int().min(1).max(10 * 1024 * 1024).optional(),
  maxResponseBodyBytes: z.number().int().min(1).max(50 * 1024 * 1024).optional(),
  maxConcurrentRequests: z.number().int().min(1).max(1_000).optional(),
  rateLimit: z.object({
    windowMs: z.number().int().min(1_000).max(60 * 60 * 1_000),
    max: z.number().int().min(1).max(100_000),
  }).optional(),
  allowHttpForDevelopment: z.boolean().optional(),
  allowedUpstreamOrigins: z.array(z.string().url()).max(50).optional(),
  bazaarUrl: z.string().url().optional(),
  expiresAt: z.string().datetime().optional(),
  developerId: z.string().min(1).max(128).optional(),
});

const blockedHostSuffixes = [".local", ".internal", ".localhost"];

export function validateGatewayConfig(input: unknown): GatewayConfig {
  const config = ConfigSchema.parse(input) as GatewayConfig;
  const upstream = new URL(config.upstream);

  if (upstream.username || upstream.password) {
    throw new Error("upstream URL must not contain credentials");
  }
  if (upstream.protocol !== "https:" && !config.allowHttpForDevelopment) {
    throw new Error("upstream must use HTTPS");
  }
  if (upstream.protocol !== "https:" && upstream.protocol !== "http:") {
    throw new Error("upstream must use HTTP or HTTPS");
  }
  assertPublicHostname(upstream.hostname);

  const allowedOrigins = config.allowedUpstreamOrigins?.map((entry) => new URL(entry).origin);
  if (allowedOrigins && !allowedOrigins.includes(upstream.origin)) {
    throw new Error("upstream origin is not allowlisted");
  }

  return {
    ...config,
    upstream: upstream.toString().replace(/\/$/, ""),
    publicBaseUrl: new URL(config.publicBaseUrl).toString().replace(/\/$/, ""),
    facilitatorUrl: new URL(config.facilitatorUrl).toString().replace(/\/$/, ""),
    routePrefix: normalizeRoutePrefix(config.routePrefix ?? "/"),
    state: config.state ?? "active",
    timeoutMs: config.timeoutMs ?? 30_000,
    maxRequestBodyBytes: config.maxRequestBodyBytes ?? 1024 * 1024,
    maxResponseBodyBytes: config.maxResponseBodyBytes ?? 5 * 1024 * 1024,
    maxConcurrentRequests: config.maxConcurrentRequests ?? 100,
    rateLimit: config.rateLimit ?? { windowMs: 60_000, max: 120 },
  };
}

export function assertPublicHostname(hostname: string): void {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (
    normalized === "localhost" ||
    normalized === "0.0.0.0" ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    blockedHostSuffixes.some((suffix) => normalized.endsWith(suffix))
  ) {
    throw new Error("upstream hostname is private or reserved");
  }

  const family = isIP(normalized);
  if (family === 4 && isBlockedIpv4(normalized)) throw new Error("upstream IPv4 address is private or reserved");
  if (family === 6 && isBlockedIpv6(normalized)) throw new Error("upstream IPv6 address is private or reserved");
}

export function assertPublicAddress(address: string): void {
  if (isIP(address) === 4 && isBlockedIpv4(address)) {
    throw new Error("upstream DNS resolved to a private or reserved IPv4 address");
  }
  if (isIP(address) === 6 && isBlockedIpv6(address)) {
    throw new Error("upstream DNS resolved to a private or reserved IPv6 address");
  }
}

function normalizeRoutePrefix(value: string): string {
  const prefixed = value.startsWith("/") ? value : `/${value}`;
  return prefixed === "/" ? prefixed : prefixed.replace(/\/$/, "");
}

function isBlockedIpv4(value: string): boolean {
  const [a, b] = value.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isBlockedIpv6(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:") ||
    normalized.startsWith("::ffff:")
  );
}
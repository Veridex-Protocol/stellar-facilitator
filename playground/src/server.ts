/**
 * Veridex x402 Playground - HTTP server
 * License: Apache-2.0
 *
 * Deliberately almost empty. The playground's whole design premise is that the
 * browser is the x402 client: it generates its own keypair, funds it from
 * Friendbot, signs its own payments and talks to the facilitator directly.
 *
 * That leaves this process with three jobs and no secrets:
 *
 *   GET /api/config       public configuration the browser needs
 *   GET /api/conformance   the latest conformance report, if one is present
 *   GET /*                 static files
 *
 * It holds no keys, custodies no funds, and proxies no payment traffic. A
 * compromise of this process leaks the contents of .env.example.
 */

import { serve, type ServerType } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

export interface PlaygroundConfig {
  port: number;
  host: string;
  facilitatorUrl: string;
  demoServerUrl: string;
  bazaarUrl: string;
  network: string;
  horizonUrl: string;
  rpcUrl: string;
  friendbotUrl: string;
  explorerTxUrl: string;
  paidResourcePath: string;
  paymentAsset: string;
  /** Origins the resource proxy is permitted to reach. */
  allowedResourceOrigins: string[];
  conformanceReport?: string;
}

/**
 * Strips trailing slashes so joined URLs never double up.
 *
 * @param value - A URL that may end in slashes
 * @returns The URL without trailing slashes
 */
function trimUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Builds configuration from the environment.
 *
 * @returns Validated playground configuration
 * @throws {Error} When configured against a network where handing out funded keypairs is not appropriate
 */
export function getConfig(): PlaygroundConfig {
  const network = process.env.STELLAR_NETWORK || "testnet";

  // The playground creates a funded account for every visitor. That is only
  // ever acceptable on a test network, so this is a hard stop rather than a
  // warning: a pubnet misconfiguration would be handing out real money.
  if (network !== "testnet") {
    throw new Error(
      `STELLAR_NETWORK is '${network}'. The playground generates and funds a keypair for every visitor, ` +
        "which is only appropriate on testnet. Refusing to start.",
    );
  }

  return {
    port: parseInt(process.env.PLAYGROUND_PORT || "3004", 10),
    host: process.env.PLAYGROUND_HOST || "0.0.0.0",
    facilitatorUrl: trimUrl(process.env.FACILITATOR_URL || "http://localhost:3002"),
    demoServerUrl: trimUrl(process.env.DEMO_SERVER_URL || "http://localhost:3003"),
    bazaarUrl: trimUrl(process.env.BAZAAR_URL || "http://localhost:3001"),
    network: `stellar:${network}`,
    horizonUrl: trimUrl(process.env.HORIZON_URL || "https://horizon-testnet.stellar.org"),
    rpcUrl: trimUrl(process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org"),
    friendbotUrl: trimUrl(process.env.FRIENDBOT_URL || "https://friendbot.stellar.org"),
    explorerTxUrl: trimUrl(
      process.env.EXPLORER_TX_URL || "https://stellar.expert/explorer/testnet/tx",
    ),
    paidResourcePath: process.env.PAID_RESOURCE_PATH || "/paid-resource",
    paymentAsset:
      process.env.PAYMENT_ASSET || "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    allowedResourceOrigins: resourceAllowlist(),
    conformanceReport: process.env.CONFORMANCE_REPORT || "../conformance-report.json",
  };
}

/**
 * Origins the resource proxy may reach.
 *
 * An x402 seller has no reason to send CORS headers for a playground's origin,
 * so the browser cannot read a 402 challenge from one directly and the request
 * has to be relayed. Relaying a URL chosen by the caller is server-side request
 * forgery, so the set of reachable origins is fixed here at boot: the demo
 * seller, plus anything an operator names explicitly.
 *
 * @returns Allowed origins, normalized
 */
function resourceAllowlist(): string[] {
  const configured = (process.env.PLAYGROUND_ALLOWED_ORIGINS || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  const origins = new Set<string>();
  for (const entry of [process.env.DEMO_SERVER_URL || "http://localhost:3003", ...configured]) {
    try {
      origins.add(new URL(entry).origin);
    } catch {
      throw new Error(`'${entry}' is not a URL, so it cannot be an allowed resource origin.`);
    }
  }
  return [...origins];
}

/**
 * Builds the playground app.
 *
 * @param config - Playground configuration
 * @returns The Hono app
 */
export function createApp(config: PlaygroundConfig): Hono {
  const app = new Hono();

  app.use("*", secureHeaders());
  app.use("/api/*", cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"] }));

  // Everything here is already public: service URLs, a network name, and the
  // contract address of native XLM's SAC. No secret is reachable from this
  // process, so there is nothing here to withhold.
  app.get("/api/config", (c) =>
    c.json({
      facilitatorUrl: config.facilitatorUrl,
      demoServerUrl: config.demoServerUrl,
      bazaarUrl: config.bazaarUrl,
      network: config.network,
      horizonUrl: config.horizonUrl,
      rpcUrl: config.rpcUrl,
      friendbotUrl: config.friendbotUrl,
      explorerTxUrl: config.explorerTxUrl,
      paidResourceUrl: `${config.demoServerUrl}${config.paidResourcePath}`,
      paymentAsset: config.paymentAsset,
    }),
  );

  // The Evidence panel renders this. It is the same file CI uploads as an
  // artifact on every run, served verbatim rather than summarized, so what the
  // panel shows and what CI produced cannot drift apart.
  app.get("/api/conformance", async (c) => {
    const configured = config.conformanceReport;
    if (!configured) return c.json({ available: false, reason: "no report configured" }, 404);

    const path = isAbsolute(configured) ? configured : join(ROOT, configured);
    try {
      const raw = await readFile(path, "utf8");
      return c.json({ available: true, report: JSON.parse(raw) });
    } catch {
      return c.json(
        {
          available: false,
          reason:
            "No conformance report on disk. Run `npm run conformance` at the repository root to produce one.",
        },
        404,
      );
    }
  });

  // Relays one request to an allowlisted seller and hands back the status,
  // headers and body verbatim - including PAYMENT-REQUIRED and
  // PAYMENT-RESPONSE, which a browser could not otherwise read.
  //
  // The payment itself is still signed in the browser. This carries a signed
  // envelope; it never sees a key, and it cannot be pointed anywhere the
  // operator did not name.
  app.post("/api/resource", async (c) => {
    let request: { url?: unknown; method?: unknown; headers?: unknown };
    try {
      request = await c.req.json();
    } catch {
      return c.json({ error: "invalid_body", message: "Expected a JSON object." }, 400);
    }

    if (typeof request.url !== "string") {
      return c.json({ error: "invalid_url", message: "'url' must be a string." }, 400);
    }

    let target: URL;
    try {
      target = new URL(request.url);
    } catch {
      return c.json({ error: "invalid_url", message: `'${request.url}' is not a URL.` }, 400);
    }

    if (!config.allowedResourceOrigins.includes(target.origin)) {
      return c.json(
        {
          error: "origin_not_allowed",
          message:
            `This playground may only fetch resources from ${config.allowedResourceOrigins.join(", ")}. ` +
            "The proxy is allowlisted so it cannot be used to reach arbitrary hosts.",
        },
        403,
      );
    }

    const method = typeof request.method === "string" ? request.method.toUpperCase() : "GET";
    if (!["GET", "HEAD", "POST"].includes(method)) {
      return c.json({ error: "method_not_allowed", message: `Method ${method} is not relayed.` }, 405);
    }

    // Only protocol headers travel. Anything else the browser sets stays here.
    const forwardable = new Set(["accept", "content-type", "payment-signature", "x-payment"]);
    const headers: Record<string, string> = {};
    if (request.headers && typeof request.headers === "object") {
      for (const [name, value] of Object.entries(request.headers as Record<string, unknown>)) {
        if (typeof value === "string" && forwardable.has(name.toLowerCase())) headers[name] = value;
      }
    }

    try {
      const response = await fetch(target, {
        method,
        headers,
        signal: AbortSignal.timeout(30_000),
      });
      const body = await response.text();
      return c.json({
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body,
      });
    } catch (error) {
      return c.json(
        {
          error: "upstream_unreachable",
          message: `Could not reach ${target.origin}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
        502,
      );
    }
  });

  app.get("/api/health", (c) => c.json({ status: "ok", network: config.network }));

  app.use("/*", serveStatic({ root: "./public" }));
  app.get("/", serveStatic({ path: "./public/index.html" }));

  return app;
}

/**
 * Starts the playground.
 *
 * @param config - Optional overrides on top of environment configuration
 * @returns The running server
 */
export function start(config: PlaygroundConfig = getConfig()): ServerType {
  const app = createApp(config);
  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host });

  process.stdout.write(
    `Veridex x402 Playground\n` +
      `  listening    http://${config.host}:${config.port}\n` +
      `  facilitator  ${config.facilitatorUrl}\n` +
      `  seller       ${config.demoServerUrl}${config.paidResourcePath}\n` +
      `  network      ${config.network}\n` +
      `  proxy        ${config.allowedResourceOrigins.join(", ")}\n` +
      `  keys         generated in the browser; this process holds none\n`,
  );

  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start();
}

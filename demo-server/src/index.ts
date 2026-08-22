/**
 * Veridex Demo Resource Server
 * License: Apache-2.0
 *
 * A minimal x402 seller, so the conformance harness has something real to buy.
 *
 * It uses the stock `@x402/hono` middleware and delegates every verify/settle
 * decision to our facilitator over HTTP — no protocol code of our own on this
 * side. It declares Bazaar discovery metadata too, so a settled payment
 * exercises the catalog-ingestion path rather than leaving it untested.
 */

import { config as loadDotenv } from "dotenv";

// Local runs read the repository-root .env; docker compose injects the same
// variables through env_file, where this simply finds nothing to load.
loadDotenv({ path: [".env", "../.env"], quiet: true });

import { serve } from "@hono/node-server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { Hono } from "hono";

/**
 * Reads a required environment variable.
 *
 * @param name - Variable name
 * @returns Its trimmed value
 * @throws {Error} When unset or empty
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`${name} is required. Run 'npm run setup' at the repository root to generate a .env.`);
  }
  return value.trim();
}

const NETWORK = "stellar:testnet";
const port = Number(process.env.DEMO_SERVER_PORT ?? 3003);
const facilitatorUrl = (process.env.FACILITATOR_URL ?? "http://localhost:3002").replace(/\/+$/, "");
const payTo = required("SELLER_ADDRESS");
const asset = required("PAYMENT_ASSET");
const amount = process.env.PAYMENT_AMOUNT ?? "100000";

/**
 * Waits for the facilitator to answer `/supported`.
 *
 * The middleware syncs with the facilitator as soon as it is constructed. When
 * both services start at once that sync races and loses, and the first request
 * to a paid route answers 500 instead of 402. Blocking here turns a startup
 * race into a startup wait.
 *
 * @param url - Facilitator base URL
 * @param timeoutMs - How long to keep trying
 * @throws {Error} When the facilitator never becomes reachable
 */
async function waitForFacilitator(url: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not reachable";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/supported`, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(
    `Facilitator at ${url} did not answer /supported within ${timeoutMs / 1000}s (${lastError}). ` +
      "Start it first, or check FACILITATOR_URL.",
  );
}

await waitForFacilitator(facilitatorUrl);

const resourceServer = new x402ResourceServer(
  new HTTPFacilitatorClient({ url: facilitatorUrl }),
).register(NETWORK, new ExactStellarScheme());

const app = new Hono();

app.get("/health", (c) => c.json({ status: "ok", network: NETWORK, payTo }));

app.use(
  paymentMiddleware(
    {
      "GET /paid-resource": {
        accepts: [
          {
            scheme: "exact",
            network: NETWORK,
            // An explicit AssetAmount: the price is denominated in the token
            // contract we chose, not the library's default stablecoin.
            price: { asset, amount },
            payTo,
            maxTimeoutSeconds: 120,
          },
        ],
        serviceName: "Veridex demo",
        description: "A single boring JSON object, sold for a fixed price on Stellar testnet.",
        mimeType: "application/json",
        tags: ["demo", "testnet"],
        // Declared so a settled payment exercises Bazaar catalog ingestion.
        extensions: declareDiscoveryExtension({
          output: {
            example: {
              resource: "paid-resource",
              message: "Payment settled on Stellar testnet.",
              servedAt: "2026-01-01T00:00:00.000Z",
            },
          },
        }),
      },
    },
    resourceServer,
    undefined,
    undefined,
    // Sync with /supported on boot: if the facilitator does not actually
    // support this scheme and network, fail here rather than at payment time.
    true,
  ),
);

app.get("/paid-resource", (c) =>
  c.json({
    resource: "paid-resource",
    message: "Payment settled on Stellar testnet. This JSON is the thing you bought.",
    servedAt: new Date().toISOString(),
  }),
);

serve({ fetch: app.fetch, port, hostname: "0.0.0.0" });

process.stdout.write(
  `demo resource server on :${port}\n` +
    `  facilitator ${facilitatorUrl}\n` +
    `  payTo       ${payTo}\n` +
    `  price       ${amount} atomic units of ${asset}\n`,
);

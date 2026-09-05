/**
 * Veridex Demo Resource Server
 * License: Apache-2.0
 *
 * A minimal x402 seller, so the conformance harness has something real to buy.
 *
 * It uses the stock `@x402/hono` middleware and delegates every verify/settle
 * decision to our facilitator over HTTP - no protocol code of our own on this
 * side. It declares Bazaar discovery metadata too, so a settled payment
 * exercises the catalog-ingestion path rather than leaving it untested.
 */

import { config as loadDotenv } from "dotenv";

// Local runs read the repository-root .env; docker compose injects the same
// variables through env_file, where this simply finds nothing to load.
loadDotenv({ path: [".env", "../.env"], quiet: true });

import { serve } from "@hono/node-server";
import { Keypair } from "@stellar/stellar-sdk";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { Hono } from "hono";
import { applyUptoSettlementHeaders, UptoStellarServerScheme } from "./upto-server.js";
import {
  createProviderOutcome,
  createProviderQualityExtension,
  digestBytes,
  digestJson,
  encodeProviderOutcome,
  PROVIDER_OUTCOME_HEADER,
  PROVIDER_QUALITY_EXTENSION_KEY,
} from "./provider-quality.js";

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
const uptoUsageAmount = process.env.UPTO_USAGE_AMOUNT ?? "25000";
const providerOutcomeSecretKey = required("PROVIDER_OUTCOME_SECRET_KEY");
const providerOutcomeSigner = Keypair.fromSecret(providerOutcomeSecretKey);
if (providerOutcomeSigner.publicKey() !== payTo) {
  throw new Error("PROVIDER_OUTCOME_SECRET_KEY must correspond to SELLER_ADDRESS for the reference seller");
}

const bazaarUrl = process.env.BAZAAR_URL?.replace(/\/+$/, "");
const bazaarToken = process.env.BAZAAR_INTERNAL_TOKEN;

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
)
  .register(NETWORK, new ExactStellarScheme())
  .register(NETWORK, new UptoStellarServerScheme());
resourceServer.registerExtension(
  createProviderQualityExtension({
    requireOutcome: true,
    onObservation: (outcome) => {
      if (!bazaarUrl || !bazaarToken) return;
      return fetch(`${bazaarUrl}/provider-quality/observations`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${bazaarToken}` },
        body: JSON.stringify(outcome),
      }).then(() => undefined).catch(() => undefined);
    },
    onSettlement: (outcome, context) => {
      if (!bazaarUrl || !bazaarToken || !context.result.transaction) return;
      return fetch(`${bazaarUrl}/provider-quality/observations/settlement`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${bazaarToken}` },
        body: JSON.stringify({ signer: outcome.signer, signature: outcome.signature, settlementTx: context.result.transaction }),
      }).then(() => undefined).catch(() => undefined);
    },
  }),
);

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
        extensions: {
          ...declareDiscoveryExtension({
            output: {
              example: {
                resource: "paid-resource",
                message: "Payment settled on Stellar testnet.",
                servedAt: "2026-01-01T00:00:00.000Z",
              },
            },
          }),
          [PROVIDER_QUALITY_EXTENSION_KEY]: { requireOutcome: true },
        },
      },
      "GET /paid-resource-upto": {
        accepts: [
          {
            scheme: "upto",
            network: NETWORK,
            price: { asset, amount },
            payTo,
            maxTimeoutSeconds: 120,
          },
        ],
        serviceName: "Veridex demo",
        description: "A metered JSON response settled against a bounded Stellar upto authorization.",
        mimeType: "application/json",
        tags: ["demo", "testnet", "upto"],
        extensions: {
          ...declareDiscoveryExtension({
            output: {
              example: {
                resource: "paid-resource-upto",
                message: "Metered payment settled on Stellar testnet.",
                servedAt: "2026-01-01T00:00:00.000Z",
              },
            },
          }),
          [PROVIDER_QUALITY_EXTENSION_KEY]: { requireOutcome: true },
        },
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

app.get("/paid-resource", (c) => {
  const body = {
    resource: "paid-resource",
    message: "Payment settled on Stellar testnet. This JSON is the thing you bought.",
    servedAt: new Date().toISOString(),
  };
  const outcome = createProviderOutcome({
    resource: c.req.url,
    payTo,
    requestDigest: digestJson({ method: c.req.method, url: c.req.url }),
    responseDigest: digestBytes(JSON.stringify(body)),
    observedAt: Math.floor(Date.now() / 1000),
    usable: true,
    providerAtFault: false,
    attributable: "unknown",
    reasonCode: "ok",
    responseStatus: 200,
    callId: c.req.header("X-Request-Id") || undefined,
    signerSecretKey: providerOutcomeSecretKey,
  });
  c.header(PROVIDER_OUTCOME_HEADER, encodeProviderOutcome(outcome));
  return c.json(body);
});

app.get("/paid-resource-upto", (c) => {
  const body = {
    resource: "paid-resource-upto",
    message: "Metered payment settled on Stellar testnet. This JSON is the thing you bought.",
    servedAt: new Date().toISOString(),
  };
  const outcome = createProviderOutcome({
    resource: c.req.url,
    payTo,
    requestDigest: digestJson({ method: c.req.method, url: c.req.url }),
    responseDigest: digestBytes(JSON.stringify(body)),
    observedAt: Math.floor(Date.now() / 1000),
    usable: true,
    providerAtFault: false,
    attributable: "unknown",
    reasonCode: "ok",
    responseStatus: 200,
    usageAtomic: uptoUsageAmount,
    callId: c.req.header("X-Request-Id") || undefined,
    signerSecretKey: providerOutcomeSecretKey,
  });
  c.header(PROVIDER_OUTCOME_HEADER, encodeProviderOutcome(outcome));
  applyUptoSettlementHeaders((name, value) => c.header(name, value), uptoUsageAmount);
  return c.json(body);
});

serve({ fetch: app.fetch, port, hostname: "0.0.0.0" });

process.stdout.write(
  `demo resource server on :${port}\n` +
    `  facilitator ${facilitatorUrl}\n` +
    `  payTo       ${payTo}\n` +
    `  price       ${amount} atomic units of ${asset}\n`,
);

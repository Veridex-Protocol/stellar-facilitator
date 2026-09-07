#!/usr/bin/env node
/** Keyless MCP discovery/payment testnet smoke. License: Apache-2.0 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";

const root = new URL("../../", import.meta.url).pathname;
const buyerSecret = process.env.BUYER_SECRET_KEY;
if (!buyerSecret) throw new Error("BUYER_SECRET_KEY is required; run npm run setup");
const network = "stellar:testnet";
const bazaarUrl = process.env.BAZAAR_URL || "http://localhost:3201";
const facilitatorUrl = process.env.FACILITATOR_URL || "http://localhost:3202";
const resourceUrl = process.env.DEMO_SERVER_URL
  ? `${process.env.DEMO_SERVER_URL.replace(/\/$/, "")}/paid-resource`
  : "http://localhost:3203/paid-resource";
const horizonUrl = process.env.HORIZON_URL || "https://horizon-testnet.stellar.org";
const childEnv = { ...process.env };
delete childEnv.BUYER_SECRET_KEY;
delete childEnv.STELLAR_CLIENT_SECRET_KEY;
delete childEnv.FACILITATOR_SECRET_KEY;
delete childEnv.SELLER_SECRET_KEY;
Object.assign(childEnv, {
  BAZAAR_URL: bazaarUrl,
  FACILITATOR_URL: facilitatorUrl,
  STELLAR_NETWORK: "testnet",
  MCP_ALLOW_LOCAL_URLS: "true",
});

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [`${root}mcp-server/dist/index.js`],
  cwd: root,
  env: childEnv,
  stderr: "pipe",
});
const client = new Client({ name: "veridex-keyless-smoke", version: "1.0.0" }, { capabilities: {} });

function textPayload(result) {
  const text = result.content?.find((entry) => entry.type === "text")?.text;
  if (!text) throw new Error("MCP tool returned no text payload");
  return JSON.parse(text);
}

try {
  await client.connect(transport);
  const discovery = textPayload(await client.callTool({
    name: "discover_resources",
    arguments: { query: "boring JSON object", network, limit: 10 },
  }));
  if (!discovery.resources?.some((resource) => resource.resourceUrl === resourceUrl)) {
    throw new Error("MCP discovery did not return the paid resource");
  }

  const prepared = textPayload(await client.callTool({
    name: "pay_resource",
    arguments: { resourceUrl, maxAmount: "100000" },
  }));
  if (prepared.action !== "sign_payment" || prepared.signingLocation !== "client_wallet") {
    throw new Error("MCP did not return a keyless signing challenge");
  }
  const signer = createEd25519Signer(buyerSecret, network);
  const scheme = new ExactStellarScheme(signer);
  const terms = prepared.paymentRequired.accepts[0];
  const partial = await scheme.createPaymentPayload(prepared.paymentRequired.x402Version, terms);
  const paymentPayload = {
    ...partial,
    accepted: terms,
    resource: prepared.paymentRequired.resource,
    extensions: prepared.paymentRequired.extensions,
  };

  const paid = textPayload(await client.callTool({
    name: "pay_resource",
    arguments: { resourceUrl, maxAmount: "100000", paymentPayload },
  }));
  if (!paid.ok || !/^[0-9a-f]{64}$/i.test(paid.transaction || "")) {
    throw new Error(`MCP payment failed: ${JSON.stringify(paid)}`);
  }
  const horizon = await fetch(`${horizonUrl}/transactions/${paid.transaction}`);
  if (!horizon.ok) throw new Error(`Horizon did not find MCP transaction ${paid.transaction}`);
  const transaction = await horizon.json();
  if (!transaction.successful) throw new Error("MCP transaction was not successful");
  process.stdout.write(`${JSON.stringify({
    keylessMcp: true,
    buyerSecretInMcp: false,
    resource: resourceUrl,
    transaction: paid.transaction,
    ledger: transaction.ledger,
    payer: signer.address,
    payTo: terms.payTo,
    asset: terms.asset,
    amount: terms.amount,
    scheme: terms.scheme,
  }, null, 2)}\n`);
} finally {
  await client.close();
}
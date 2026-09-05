# Golden Path

## Buyer

Prerequisites: Node 22+, a funded Stellar testnet account, and a running seller/facilitator.

The repository demo creates funded testnet accounts and starts a seller and
facilitator with `npm run demo`. The `@veridex/stellar` package is prepared for
publication but is not yet on npm. Until publication, install the local SDK
tarball from `sdk-typescript` in the buyer project:

```bash
cd sdk-typescript
npm pack
cd ../path/to/your-project
npm install /path/to/stellar-facilitator/sdk-typescript/veridex-stellar-0.1.0.tgz
```

`@veridex/stellar` is not yet published to npm. For the current repository
release candidate, pack and install the SDK locally as described in its
[package README](../sdk-typescript/README.md); use the command above after
the package is published.

```ts
import { createVeridexClient } from "@veridex/stellar";

const client = createVeridexClient({
  network: "stellar:testnet",
  privateKey: process.env.BUYER_SECRET_KEY!,
});

const response = await client.fetch("http://localhost:3003/paid-resource");
console.log(await response.json());
```

The client delegates 402 parsing, Stellar signing, payment headers, and retry to the official x402 packages.

## Seller

Install `@x402/core`, `@x402/extensions`, `@x402/hono`, `@x402/stellar`, Hono, and an HTTP server adapter. Configure `network`, `asset`, `amount`, `payTo`, and `FACILITATOR_URL`, then wrap the route with `paymentMiddleware`. Bazaar and P2P are optional.

## Discovery

```ts
import { createBazaarClient, createVeridexClient } from "@veridex/stellar";

const bazaar = createBazaarClient({ bazaarUrl: "http://localhost:3001" });
const page = await bazaar.search({ query: "weather forecast", network: "stellar:testnet" });
const client = createVeridexClient({
  network: "stellar:testnet",
  privateKey: process.env.BUYER_SECRET_KEY!,
});
const response = await client.fetch(page.results[0].resourceUrl);
```

Discovery is settlement-seeded: a seller appears after a payment-backed catalog entry exists.

## Agent / MCP

Run the repository MCP server with the local stack. Its active tools are `discover_resources` and `pay_resource`; it uses the same official x402 payment flow.

The local demo resource uses a private Docker hostname, so enable local URLs
only for this local stdio session. Keep the default disabled for deployments
that may receive untrusted tool inputs.

```bash
MCP_ALLOW_LOCAL_URLS=true docker compose --profile mcp run --rm mcp-server
```
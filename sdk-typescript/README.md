# `@veridex/stellar`

TypeScript utilities for the Veridex Stellar payment and discovery stack.

## Canonical Buyer Path

The high-level buyer facade is the recommended entry point. It delegates 402 parsing, Stellar signing, payment headers, and retry to the official x402 packages.

The package is currently prepared for publication but is not yet available on
the public npm registry. Until publication, build and pack it from this
repository, then install the generated tarball in an external project:

```bash
cd sdk-typescript
npm pack
cd ../path/to/your-project
npm install /path/to/stellar-facilitator/sdk-typescript/veridex-stellar-0.1.0.tgz
```

After publication, the install command becomes:

```bash
npm install @veridex/stellar
```

```ts
import { createVeridexClient } from "@veridex/stellar";

const client = createVeridexClient({
  network: "stellar:testnet",
  privateKey: process.env.BUYER_SECRET_KEY!,
});

const response = await client.fetch("http://localhost:3003/paid-resource");
console.log(await response.json());
```

Prerequisites: Node 22+, a funded Stellar account, and a reachable x402 resource/facilitator. The repository demo provisions a testnet stack with `npm run demo`.

## Advanced APIs

`BazaarClient` reads discovery/search/provider-quality endpoints. `FacilitatorClient` reads facilitator capabilities and submits pre-built signed payloads. It does not perform the HTTP 402 challenge/retry loop; use `VeridexClient` above or official `@x402/fetch` for that.

```ts
import { createBazaarClient, createFacilitatorClient } from "@veridex/stellar";

const bazaar = createBazaarClient({ bazaarUrl: "http://localhost:3001" });
const page = await bazaar.search({ query: "weather forecast", network: "stellar:testnet" });

const facilitator = createFacilitatorClient({
  facilitatorUrl: "http://localhost:3002",
  network: "testnet",
});
console.log(await facilitator.getSupportedSchemes());
```

## Discovery

```ts
const page = await bazaar.search({
  query: "translate API",
  network: "stellar:testnet",
  minUptimeRatio: 0.95,
  limit: 5,
});
```

The default retrieval vector is deterministic feature hashing, a lexical signal alongside BM25, not learned semantic search.

## Provider Quality

The package also exports signed provider-outcome contracts, response-aware settlement hooks, aggregate verification/cache/policy helpers, and Bazaar provider-quality reads.

## Package Ownership

- Exact seller middleware: official `@x402/*` server packages.
- Exact buyer: `@veridex/stellar` or official `@x402/fetch` plus `@x402/stellar`.
- Agent orchestration: separate `@veridex/agentic-payments` package.
- Passkeys/wallet identity: separate sibling `@veridex/sdk` package.

License: Apache-2.0.

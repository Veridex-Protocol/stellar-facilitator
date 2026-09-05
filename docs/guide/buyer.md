# Buyer and agent path: pay for things you did not integrate with

You are writing a client, or an agent, that needs to pay for a service. You have no account with the seller and no API key, and in the agent case you may not know the endpoint exists until you go looking for it.

What you end up with is code that discovers a service and pays for it with no prior relationship of any kind.

## 1. An account holding the payment asset

```bash
npm run setup
grep BUYER_SECRET_KEY .env
```

You need a buyer signing key and the payment asset. When a facilitator advertises `areFeesSponsored: true` it pays the network fee itself, so a buyer holding USDC and no XLM can still transact. Read the flag rather than assuming it:

```bash
curl -s http://localhost:3002/supported \
  | jq '.kinds[] | select(.scheme=="exact") | .extra.areFeesSponsored'
```

## 2. Paying with `@veridex/stellar`

This is the recommended Veridex buyer path:

`@veridex/stellar` is prepared for publication but is not yet available on the
public npm registry. For this release candidate, build and pack the SDK from
the repository, then install the tarball in the buyer project:

```bash
cd sdk-typescript
npm pack
cd ../path/to/your-project
npm install /path/to/stellar-facilitator/sdk-typescript/veridex-stellar-0.1.0.tgz
```

After publication, use `npm install @veridex/stellar` instead.

```ts
import { createVeridexClient } from "@veridex/stellar";

const client = createVeridexClient({
  network: "stellar:testnet",
  privateKey: process.env.BUYER_SECRET_KEY!,
});

// The 402, signature, payment header, and retry happen inside.
const response = await client.fetch("http://localhost:3003/forecast");
console.log(await response.json());
```

That is the entire beginner buyer flow. The facade receives the 402, delegates signing to the official x402 packages, retries with the payment header, and returns the paid response.

The official `@x402/fetch` plus `@x402/stellar` packages remain a supported advanced path when you need direct x402 policy or extension registration. The repository conformance harness uses that lower-level path independently of this source tree.

## 3. Bounding what you spend with the advanced x402 client

The high-level facade follows the payment option offered by the resource. For an explicit spend policy, use the official x402 client directly:

```ts
import { x402Client } from "@x402/core/client";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";

const network = "stellar:testnet";
const client = new x402Client().register(
  network,
  new ExactStellarScheme(createEd25519Signer(process.env.BUYER_SECRET_KEY!, network)),
);

client.registerPolicy((version, requirements) =>
  requirements.filter((r) => BigInt(r.amount) <= 1_000_000n)   // 0.1 XLM
);
```

The policy runs against every offered payment option and filters them. If nothing survives the filter, no payment is made and the 402 stands.

For a metered service, where the amount is not known up front, see the section on the [`upto` scheme](#metered-payments-with-upto) below.

## 4. Discovery, for agents

This is the part with no equivalent in a normal API integration, which is finding a service you were never told about.

```bash
curl -s "http://localhost:3001/discovery/search?q=weather+forecast&network=stellar:testnet&limit=5" | jq
```

```json
{
  "results": [
    {
      "resourceUrl": "http://localhost:3003/forecast",
      "serviceName": "Acme forecasts",
      "description": "Hourly weather forecast for a named city.",
      "payTo": "GAJWHHLF…",
      "network": "stellar:testnet",
      "scheme": "exact",
      "compositeScore": 0.82,
      "telemetry": { "livenessStatus": "HEALTHY", "settlementCount": 3 }
    }
  ],
  "total": 1,
  "partialResults": false
}
```

### Filtering

| Parameter | Use |
| --- | --- |
| `type` | Either `http` or `mcp` |
| `payTo` | Only this seller |
| `network` | Either `stellar:testnet` or `stellar:pubnet` |
| `extensions` | Comma-separated, matching resources that declare all of them |
| `limit`, `offset` | Page size and start, where `limit` caps at 100 |
| `cursor` | Continuation token, which supersedes `offset` |

### Paging

Page with `nextCursor` rather than by computing an offset yourself:

```ts
let cursor: string | undefined;
do {
  const url = new URL("http://localhost:3001/discovery/search");
  url.searchParams.set("q", "weather");
  if (cursor) url.searchParams.set("cursor", cursor);

  const page = await (await fetch(url)).json();
  handle(page.results);
  cursor = page.nextCursor;
} while (cursor);
```

A cursor is bound to the query that issued it. Changing the query or the filters part way through returns `400 invalid_cursor` rather than silently handing you the wrong page, because the same offset under different terms is a different set of rows.

### Two response fields worth reading

The `partialResults` flag being true means a retrieval leg filled its candidate pool, so ranking saw a truncated set and this is not a complete answer. The accompanying `partialReason` says so in words. Narrow the query if completeness matters to you.

The `telemetry.livenessStatus` field reports Bazaar evidence from signed heartbeat telemetry and confirmed settlements. It is not an active HTTP probe. Ranking filters offline resources and demotes degraded ones, but callers should still handle request failure.

## 5. Discover and pay, end to end

This is the whole point, which is an agent paying for a service it found seconds ago:

```ts
const found = await (await fetch(
  "http://localhost:3001/discovery/search?q=weather+forecast&limit=1"
)).json();

const resource = found.results[0];
if (!resource) throw new Error("nothing matched");

const response = await client.fetch(resource.resourceUrl);
console.log(await response.json());
```

There is no prior integration, no API key, and no account with the seller.

## 6. From inside a client runtime

The MCP server exposes discovery and payment as tools, so a client or automated workflow can do all of the above without you writing any HTTP code.

```bash
docker compose --profile mcp run --rm mcp-server
```

| Tool | What it does |
| --- | --- |
| `discover_resources` | Searches the Bazaar and returns ranked resources with telemetry |
| `pay_resource` | Performs the 402 challenge, the payment and the retry, then returns the result |

Inputs and outputs are structured, and every failure carries a machine-readable reason code, so an agent can branch on `invalid_exact_stellar_payload_simulation_failed` without parsing prose.

## Metered payments with upto

For services whose cost is not known up front, such as token billing or compute time, the `upto` scheme lets you authorize a ceiling and have the facilitator settle actual usage.

```bash
curl -s http://localhost:3002/supported | jq '.kinds[] | select(.scheme=="upto")'
```

```json
{
  "x402Version": 2,
  "scheme": "upto",
  "network": "stellar:testnet",
  "extra": { "contractId": "CAHV6TIAOVSICUJHI6OBZSW2N5ZKRPGKHE2SH6OAEJHPHCLF5DXWAGG2" }
}
```

Read `extra.contractId` rather than hardcoding it, because every operator deploys their own instance and the address differs between facilitators.

Your authorization commits you to a specific set of things and nothing beyond them. Your signature covers `max_amount`, so a settlement above the ceiling fails. It covers `pay_to`, so the payment cannot be redirected. It covers a request digest, so it cannot be reused for different work. The pair of payer and settlement id is recorded in the contract itself, so an authorization settles exactly once, including when you pay from a smart account. Finally, the unused remainder returns to you in the same transaction, atomically.

The facilitator separately signs the amount it charged and a digest of what it delivered, which means the ledger records what you were charged and what for rather than only the facilitator's own log saying so.

The scheme is advertised on testnet only and it is not audited, so treat it as experimental. Contract and validator tests exist, but the complete stock HTTP seller-to-facilitator conformance path remains an evidence gate. If `upto` is absent from `/supported`, that facilitator has no confirmed contract and you should not attempt it.

## Handling failure

Every rejection carries a reason code and a sentence.

| Reason | What it means |
| --- | --- |
| `invalid_exact_stellar_payload_wrong_amount` | Terms changed between the 402 and your payment, so re-read and retry |
| `invalid_exact_stellar_payload_simulation_failed` | Usually an insufficient balance or a missing trustline |
| `invalid_exact_stellar_signature_expiration_too_far` | Soroban RPC ledger skew, which the facilitator already retried, so re-sign with a fresh ledger read |
| `settlement_capacity_exceeded` | The facilitator's signers are all busy and no funds moved |

The last of those returns HTTP 503 with a `Retry-After` header, and it is always safe to retry because it is refused before anything is submitted to the network.

## Next

The [seller path](./seller.md) covers selling something of your own. The [operator path](./operator.md) covers running the facilitator these examples point at.

# Buyer and agent path: pay for things you did not integrate with

You are writing a client, or an agent, that needs to pay for a service. You have no account with the seller and no API key, and in the agent case you may not know the endpoint exists until you go looking for it.

What you end up with is code that discovers a service and pays for it with no prior relationship of any kind.

## 1. An account holding the payment asset

```bash
npm run setup
grep BUYER_SECRET_KEY .env
```

You need the payment asset only. When a facilitator advertises `areFeesSponsored: true` it pays the network fee itself, so a buyer holding USDC and no XLM can still transact. Read the flag rather than assuming it:

```bash
curl -s http://localhost:3002/supported \
  | jq '.kinds[] | select(.scheme=="exact") | .extra.areFeesSponsored'
```

## 2. Paying

The library ships a drop-in `fetch` wrapper, and this is the whole integration:

```ts
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";

const NETWORK = "stellar:testnet";

const signer = createEd25519Signer(process.env.BUYER_SECRET_KEY!, NETWORK);
const client = new x402Client().register(NETWORK, new ExactStellarScheme(signer));

const pay = wrapFetchWithPayment(fetch, client);

// Identical to fetch. The 402, the signature and the retry all happen inside.
const response = await pay("http://localhost:3003/forecast");
console.log(await response.json());
```

That is the entire buyer side. The wrapper receives the 402, reads the terms, signs an authorization entry, retries with it, and returns the paid response.

Nothing in that snippet is specific to our facilitator. It is stock `@x402/fetch`, and the same code works against any conformant Stellar facilitator. That is deliberate, and it is why our own conformance harness uses exactly this path while importing nothing from our source.

## 3. Bounding what you spend

An agent paying automatically needs a ceiling. Register a policy that rejects terms you are not willing to meet, and it runs before anything is signed:

```ts
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

The `telemetry.livenessStatus` field reports whether the resource is currently reachable. Ranking already filters offline resources and demotes degraded ones, because handing an agent a dead endpoint is a failed task rather than a ranking inaccuracy. The field is there if you want to filter harder than that.

## 5. Discover and pay, end to end

This is the whole point, which is an agent paying for a service it found seconds ago:

```ts
const found = await (await fetch(
  "http://localhost:3001/discovery/search?q=weather+forecast&limit=1"
)).json();

const resource = found.results[0];
if (!resource) throw new Error("nothing matched");

const response = await pay(resource.resourceUrl);
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

The scheme is advertised on testnet only and it is not audited, so treat it as experimental. If `upto` is absent from `/supported`, that facilitator has no contract deployed and you should not attempt it.

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

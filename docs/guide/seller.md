# Seller path: get paid for an endpoint

You have an API, or an MCP tool, and you want agents to pay per call. This takes about ten minutes and it needs no registration anywhere.

What you end up with is a paid endpoint that appears in the Bazaar catalog on its first settlement, with no separate listing step to remember.

## 1. Get an address that can receive payment

Any Stellar account works. For testnet:

```bash
npm run setup
grep SELLER_ADDRESS .env
```

For your own service, generate a keypair and fund it. You only need the public key on the server, because a resource server never signs payments and therefore never needs the secret.

## 2. Declare the price

The middleware handles the protocol. All you describe is what you sell and what it costs.

Install the official seller packages. A basic exact payment does not require
`@veridex/stellar`, a Bazaar database, or a P2P node.

```bash
npm install @x402/core @x402/extensions @x402/hono @x402/stellar hono @hono/node-server
```

```ts
import { serve } from "@hono/node-server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { Hono } from "hono";

const NETWORK = "stellar:testnet";

const resourceServer = new x402ResourceServer(
  new HTTPFacilitatorClient({ url: "http://localhost:3002" }),
).register(NETWORK, new ExactStellarScheme());

const app = new Hono();

app.use(
  paymentMiddleware(
    {
      "GET /forecast": {
        accepts: [{
          scheme: "exact",
          network: NETWORK,
          // A SEP-41 token contract address, and the amount in atomic units.
          price: { asset: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
                   amount: "100000" },          // 0.01 XLM
          payTo: process.env.SELLER_ADDRESS!,
          maxTimeoutSeconds: 120,
        }],
        serviceName: "Acme forecasts",
        description: "Hourly weather forecast for a named city.",
        mimeType: "application/json",
        tags: ["weather", "forecast"],
        // This is what makes the endpoint discoverable. See step 4.
        extensions: declareDiscoveryExtension({
          output: { example: { city: "Lisbon", tempC: 19, at: "2026-08-23T14:00:00Z" } },
        }),
      },
    },
    resourceServer,
    undefined,
    undefined,
    true,   // check the facilitator supports this scheme at boot, not at payment time
  ),
);

app.get("/forecast", (c) => c.json({ city: "Lisbon", tempC: 19, at: new Date().toISOString() }));

serve({ fetch: app.fetch, port: 3003 });
```

That final `true` argument is worth understanding. It makes the server confirm at startup that the facilitator actually supports `exact` on `stellar:testnet`, so a misconfiguration becomes a failed boot rather than a failed payment in front of a customer.

Express and Next adapters exist as well, in `@x402/express` and `@x402/next`, and they take the same shape.

## 3. Check that the 402 is well formed

```bash
curl -i http://localhost:3003/forecast
```

```
HTTP/1.1 402 Payment Required
payment-required: eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJQYXltZW50IHJlcXVpcmVkIiwi…
```

Decode the header to see exactly what a buyer sees. Note that this must be a GET rather than a HEAD request, because the middleware only emits the challenge on the method the route is registered for.

```bash
curl -s -D- -o /dev/null http://localhost:3003/forecast \
  | awk -F': ' '/^payment-required/{print $2}' | tr -d '\r' | base64 -d | jq '.accepts[0]'
```

```json
{
  "scheme": "exact",
  "network": "stellar:testnet",
  "amount": "100000",
  "asset": "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  "payTo": "GAJWHHLFUA62X5Z4XGFXRZA3CBUC7IZXFWAJ46637REXBYBCNP2BJRXY",
  "maxTimeoutSeconds": 120,
  "extra": { "areFeesSponsored": true }
}
```

The `areFeesSponsored: true` field means your buyers need only the payment asset and no XLM for fees, because the facilitator sponsors them.

## 4. Discovery is automatic, and it tells you when it fails

The `declareDiscoveryExtension` call in step 2 is the entire listing process. When a payment settles, the facilitator catalogs the resource. There is no registration call and nothing to remember to do afterwards.

The catalog reports the outcome back on the settle response, and the facilitator passes it to you in the `EXTENSION-RESPONSES` header as base64 JSON. On success it decodes to this:

```json
{ "bazaar": { "status": "success" } }
```

When something is wrong with your metadata, it names the problem instead:

```json
{ "bazaar": { "status": "rejected",
              "rejectedReason": "routeTemplate contains path traversal (..)" } }
```

Log that header. It is the only signal you get about whether your listing landed.

You can confirm the listing directly:

```bash
curl -s "http://localhost:3001/discovery/resources?payTo=$SELLER_ADDRESS" | jq '.results[0]'
```

### Why your first listing needs a payment

A listing must name a settlement that the catalog confirms on Horizon itself, and one settlement lists exactly one resource. A resource therefore becomes discoverable when someone pays for it, and not before.

This is deliberate for two reasons. It means catalog spam costs a real payment per entry, and it means every listing is auditable by a third party from the transaction hash alone. The practical consequence is that you cannot list a service nobody has bought yet, so pay for your own endpoint once to seed it.

### Writing metadata that agents can use

The description is what retrieval matches on, and an agent decides from it whether to spend money. A description like `"Weather API"` is nearly useless, whereas `"Hourly weather forecast for a named city, returns temperature in Celsius and conditions"` is what actually gets found and called.

These constraints are enforced at ingest, and a rejection always states which one failed:

| Field | Rule |
| --- | --- |
| `serviceName` | At most 32 characters, printable ASCII |
| `tags` | At most 5, each at most 32 characters |
| `iconUrl` | No IP literals, no loopback, no decimal or hex IP forms |
| `routeTemplate` | Percent-decoded first, then rejected for `..` or `://` |

## 5. Staying discoverable

Liveness comes from either of two signals, whichever is more recent. A settlement confirmed on Horizon keeps you healthy for 24 hours. A P2P heartbeat, if you run a mesh node, keeps you healthy for 30 seconds.

You do not need a mesh node. A resource that takes payments stays listed on settlements alone, which is the entire point of automatic cataloging. Ranking also weights uptime, latency, and settlement count, so a working endpoint that gets used ranks above one that does not.

## Getting paid in USDC

The examples use native XLM's Stellar Asset Contract because it needs no trustline. For USDC, or any other SEP-41 asset, the receiving account needs a trustline first or the payment will fail at settlement.

```bash
stellar tx new change-trust \
  --source-account "$SELLER_SECRET_KEY" \
  --line USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 \
  --network testnet
```

Then use the USDC SEP-41 contract address as `price.asset`. Everything else stays
the same.

## MCP tools

An MCP tool is a first-class resource type rather than a special case. Declare it with the MCP form of the extension, and it is keyed on the pair of `resource.url` and `input.toolName`, so several tools on one server list separately.

```ts
extensions: declareDiscoveryExtension({
  toolName: "get_forecast",
  description: "Hourly weather forecast for a named city.",
  inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
}),
```

## When something is wrong

Every rejection carries a machine-readable reason code and a sentence explaining it. If a payment to your endpoint fails, the reason tells you why:

```json
{ "isValid": false,
  "invalidReason": "invalid_exact_stellar_payload_event_wrong_to",
  "invalidMessage": "The simulated transfer credits an account other than the 'payTo' address in the payment requirements." }
```

The full table lives in [`reasons.ts`](../../facilitator-service/src/reasons.ts), and a test asserts that it stays exhaustive against the installed packages.

## Next

The [buyer and agent path](./buyer.md) shows how to pay for what you just built.
The [operator path](./operator.md) covers running the facilitator yourself.

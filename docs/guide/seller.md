# Seller path: protect a Stellar testnet endpoint

A basic exact seller needs official x402 middleware, a Stellar receiving
address, an asset contract, and a facilitator URL. Bazaar, federation, and
provider quality are optional.

## 1. Install

```bash
npm install @hono/node-server hono \
  @x402/core@2.21.0 @x402/extensions@2.21.0 \
  @x402/hono@2.21.0 @x402/stellar@2.21.0
```

The pinned versions match the repository's proven testnet path. Review and test
before changing them.

## 2. Configure

For the repository quickstart, `.env` supplies:

```text
SELLER_ADDRESS=<Stellar G-address>
PAYMENT_ASSET=<SEP-41 contract address>
FACILITATOR_URL=http://localhost:3002
```

The seller needs the public receiving address, not a payer key. The reference
server additionally signs experimental provider outcomes with
`PROVIDER_OUTCOME_SECRET_KEY`; that is optional and separate from accepting
payment.

## 3. Protect a route

```ts
import { serve } from "@hono/node-server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { Hono } from "hono";

const network = "stellar:testnet";
const facilitatorUrl = process.env.FACILITATOR_URL ?? "http://localhost:3002";
const payTo = process.env.SELLER_ADDRESS!;
const asset = process.env.PAYMENT_ASSET!;

const resourceServer = new x402ResourceServer(
  new HTTPFacilitatorClient({ url: facilitatorUrl }),
).register(network, new ExactStellarScheme());

const app = new Hono();

app.use(paymentMiddleware(
  {
    "GET /forecast": {
      accepts: [{
        scheme: "exact",
        network,
        price: { asset, amount: "100000" },
        payTo,
        maxTimeoutSeconds: 120,
      }],
      serviceName: "Acme forecasts",
      description: "Hourly weather forecast for a named city.",
      mimeType: "application/json",
      tags: ["weather", "forecast"],
      extensions: {
        ...declareDiscoveryExtension({
          output: { example: { city: "Lisbon", tempC: 19 } },
        }),
      },
    },
  },
  resourceServer,
  undefined,
  undefined,
  true,
));

app.get("/forecast", (context) =>
  context.json({ city: "Lisbon", tempC: 19 }),
);

serve({ fetch: app.fetch, port: 3003 });
```

The final `true` syncs supported schemes at startup. The price amount is in the
asset's atomic units. `asset` is a SEP-41 contract address, and
`extra.areFeesSponsored` is supplied by the facilitator when sponsorship is
actually enabled.

## 4. Inspect the x402 v2 challenge

```bash
curl -sS -D /tmp/forecast-headers -o /dev/null http://localhost:3003/forecast
awk -F': ' 'tolower($1)=="payment-required" {print $2}' /tmp/forecast-headers \
  | tr -d '\r' | base64 -d | jq
```

The decoded `PaymentRequired` contains resource metadata, `accepts`, and the
optional Bazaar extension. Each accepted requirement contains `scheme`, CAIP-2
`network`, `asset`, `amount`, `payTo`, `maxTimeoutSeconds`, and `extra`.

The paid retry uses `PAYMENT-SIGNATURE`; it is not an Authorization bearer
token. A successful response carries `PAYMENT-RESPONSE`.

## 5. Become discoverable

`declareDiscoveryExtension()` places the current Bazaar declaration in
`PaymentRequired.extensions.bazaar`. The client echoes the declaration in its
v2 payment payload. After successful settlement, Veridex:

```text
settlement
-> durable transaction-keyed outbox
-> asynchronous Bazaar ingestion
-> live 402/payment-term validation
-> settlement/payTo integrity validation
-> catalog row
```

The immediate settle response reports `bazaar.status: "queued"`; it does not
claim that indexing finished synchronously. Confirm the row later:

```bash
curl -fsS \
  "http://localhost:3001/discovery/resources?payTo=$SELLER_ADDRESS&network=stellar:testnet" \
  | jq '.results'
```

An existing HTTP listing is periodically revalidated. Matching live terms
refresh it; missing, changed, or unsafe terms quarantine it by soft-dropping it
from search. This hardening is implemented/tested, but migrations `005/006` and
the periodic lifecycle lack a captured destructive-stack proof.

## 6. Dynamic routes

Current upstream Bazaar conventions use route keys such as
`"GET /weather/:country/:city"`. Declare parameter schemas through
`pathParamsSchema`:

```ts
"GET /weather/:country/:city": {
  accepts: exactRequirements,
  extensions: {
    ...declareDiscoveryExtension({
      pathParamsSchema: {
        properties: {
          country: { type: "string", description: "Country code" },
          city: { type: "string", description: "City slug" },
        },
        required: ["country", "city"],
      },
      output: { example: { country: "pt", city: "lisbon", tempC: 19 } },
    }),
  },
}
```

At runtime, `/weather/pt/lisbon` supplies path parameter values. Do not invent a
flattened `pathParams` field beside the extension. Veridex percent-decodes route
templates before rejecting traversal (`..`) and scheme injection (`://`).

## 7. Custom `upto`

The reference server registers `UptoStellarServerScheme` and sets a settlement
override after provider execution. That adapter is local to this repository;
stock `@x402/stellar@2.21.0` does not export a Stellar `upto` server scheme.

Use it only for the experimental testnet path described in the
[scheme specification](../specifications/scheme_upto_stellar.md). The resource
must provide a signed result digest, actual usage must not exceed the authorized
maximum, and zero/partial/full-cap settlements remain distinct.

## 8. Troubleshooting

Branch on protocol or Veridex machine-readable errors, not message text. Common
seller actions include fixing a mismatched `payTo`/asset/amount, funding the
receiving trustline where required, refreshing expired terms, or waiting for an
asynchronous catalog retry. See [errors](../errors.md).

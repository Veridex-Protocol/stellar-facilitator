# Buyer path: discover and pay on Stellar testnet

Start the reference stack with [the quickstart](../quickstart.md). It creates a
funded buyer and writes `BUYER_SECRET_KEY` to `.env`.

## 1. Install the focused buyer package

`@veridex/stellar` is not currently published to npm. Build and pack it from
this repository:

```bash
cd sdk-typescript
npm pack
```

Install the generated `veridex-stellar-0.1.0.tgz` in your buyer project. Do not
replace this with `npm install @veridex/stellar` until registry publication is
actually confirmed.

## 2. Pay an exact resource

```ts
import { createVeridexClient } from "@veridex/stellar";

const client = createVeridexClient({
  network: "stellar:testnet",
  privateKey: process.env.BUYER_SECRET_KEY!,
});

const response = await client.fetch("http://localhost:3003/paid-resource");
if (!response.ok) throw new Error(`resource returned HTTP ${response.status}`);
console.log(await response.json());
```

The same buyer path works for a gateway resource, for example
`http://localhost:3005/hello`. The buyer validates the live terms and does not
need to know whether the seller uses native middleware or the gateway.

The facade delegates the x402 v2 flow to the official packages:

1. Read HTTP 402 and decode `PAYMENT-REQUIRED` as `PaymentRequired`.
2. Select `PaymentRequirements` with `scheme: "exact"` and
   `network: "stellar:testnet"`.
3. Create a signed `PaymentPayload` whose selected requirements are in
   `accepted`.
4. Retry with `PAYMENT-SIGNATURE`.
5. Decode `PAYMENT-RESPONSE` after settlement.

The buyer signs the authorization. The facilitator submits the transaction and,
when `extra.areFeesSponsored` is true, pays the network fee. The facilitator
does not custody the payment value.

Check sponsorship instead of assuming it:

```bash
curl -fsS http://localhost:3002/supported \
  | jq '.kinds[] | select(.scheme=="exact" and .network=="stellar:testnet") | .extra.areFeesSponsored'
```

## 3. Discover a resource

The focused Bazaar client defaults to pubnet unless configured, so current
testnet code must set `defaultNetwork` or pass `network` on every call:

```ts
import { createBazaarClient } from "@veridex/stellar";

const bazaar = createBazaarClient({
  bazaarUrl: "http://localhost:3001",
  defaultNetwork: "stellar:testnet",
});

const page = await bazaar.search({ query: "demo", limit: 5 });
const resource = page.results[0];
if (!resource) throw new Error("no resource matched");

const response = await client.fetch(resource.resourceUrl);
console.log(await response.json());
```

Discovery is advisory. Before signing, compare the live 402 terms with local
policy for scheme, network, asset, `payTo`, atomic-unit amount, and timeout.

The Veridex search endpoint supports `q`, `type`, `payTo`, `network`, `scheme`,
`extensions`, `tags`, `minUptimeRatio`, `limit`, `offset`, and opaque `cursor`
where documented by [Bazaar OpenAPI](../openapi/bazaar.yaml). Continue with
`nextCursor`; a cursor is bound to the query and filters that created it.

## 4. Advanced official client policy

Use the official client directly when you need custom payment-option policy:

```ts
import { x402Client } from "@x402/core/client";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";

const network = "stellar:testnet";
const x402 = new x402Client()
  .register(network, new ExactStellarScheme(
    createEd25519Signer(process.env.BUYER_SECRET_KEY!, network),
  ))
  .registerPolicy((_version, requirements) =>
    requirements.filter((requirement) => BigInt(requirement.amount) <= 1_000_000n),
  );
```

In x402 v2 the field is `amount`; `maxAmountRequired` belongs to v1.

## 5. Metered payments with Veridex `upto`

Select the custom scheme explicitly:

```ts
const meteredClient = createVeridexClient({
  network: "stellar:testnet",
  privateKey: process.env.BUYER_SECRET_KEY!,
  scheme: "upto",
});

const response = await meteredClient.fetch(
  "http://localhost:3003/paid-resource-upto",
);
```

The 402 `PaymentRequirements.amount` is the maximum authorization. The seller
reports actual usage through settlement overrides after executing the response:

| Case | Result |
|---|---|
| `actual = 0` | Terminal on-chain settlement; full ceiling refunded |
| `0 < actual < maximum` | Partial charge; remainder refunded atomically |
| `actual = maximum` | Full authorized amount charged |
| `actual > maximum` | Facilitator and contract reject settlement |

The payer authorization binds `payTo`, token, maximum, validity window,
facilitator, settlement ID, and request digest. The facilitator authorization
binds actual amount and result digest. The contract records replay state.

This is Veridex-specific and testnet-proven but unaudited. Installed stock
`@x402/stellar@2.21.0` exposes only `exact`; upstream Stellar `upto`
interoperability is not implied.

## 6. Handle errors by code

There are two layers:

- x402 protocol responses use `invalidReason`/`invalidMessage` for verify and
  `errorReason`/`errorMessage` for settle.
- Veridex service/SDK/MCP wrappers use the canonical Veridex
  `{code, reason, retryable, category}` metadata where applicable.

Do not parse prose. Branch on the machine-readable field and use
`retryable`/`Retry-After` where supplied. See the [error reference](../errors.md).

## 7. Verify proof

`PAYMENT-RESPONSE` is the x402 settlement result. Veridex may additionally add a
signed `x402job/1` receipt. These are payment evidence; provider-quality outcome
and aggregate records are separate. See [payment proof](../payment-proof.md).

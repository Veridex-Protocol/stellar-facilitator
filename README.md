# Veridex Stellar x402

Veridex is a Stellar x402 v2 facilitator plus an HTTPS API gateway, Bazaar
discovery, a keyless MCP agent interface, focused buyer/seller tooling, and an
experimental provider-quality layer.

| Role | Start here |
|---|---|
| Buyer | Use `createVeridexClient()` from the local `@veridex/stellar` package or official x402 client packages. |
| Existing API seller | Put `@veridex/x402-gateway` in front of an HTTPS API without changing its handlers. |
| Native seller | Protect an HTTP route with official x402 middleware for maximum application control. |
| Agent builder | Search through Bazaar or MCP, apply local policy, then sign with the buyer wallet. |
| Operator | Run the facilitator, PostgreSQL Bazaar, reference seller, and optional MCP service. |

Payment authority, discovery recommendation, and provider-quality evidence are
separate. Bazaar helps find resources; it cannot change a signed recipient,
asset, network, or amount. Provider quality is a policy signal, not payment
authorization.

## Current status

Current validation scope is `stellar:testnet`. No pubnet/mainnet transaction or
production-readiness claim is part of the current evidence set.

| Capability | Status |
|---|---|
| Stellar `exact` | Testnet proven with stock `@x402/stellar@2.21.0` behavior |
| Veridex Stellar `upto` | Testnet proven; custom, experimental, and unaudited |
| Bazaar catalog/discovery | Testnet proven for settlement-backed cataloging, search, and captured restart persistence |
| MCP | Testnet proven for keyless discovery and exact paid calls |
| `@veridex/stellar` buyer SDK | Built, packed, and externally exercised; npm publication remains pending |
| Seller integration | Working with official x402 middleware; discovery is optional |
| HTTPS API gateway | Testnet proven through the Playground: settlement, upstream response, Bazaar listing, and signed provider outcome |
| Provider quality | Implemented and tested; representative independent-observer operation is not proven |
| Federation | Local three-process/three-database restart proof; multi-operator production federation is not claimed |
| Pubnet | Approval-gated and unvalidated |
| External security audit | Pending |

See the [testnet acceptance matrix](docs/rfp/testnet-acceptance-matrix.md) and
[conformance report](docs/rfp/testnet-conformance-report.md) for recorded
transactions and limitations.

## Testnet quickstart

Requirements: Node.js 22+ and Docker.

```bash
npm run demo
```

From a clean clone, this installs dependencies, creates fresh Friendbot-funded
testnet accounts, writes `.env`, starts PostgreSQL/Bazaar/facilitator/reference
seller, runs conformance, and writes `conformance-report.json`. The harness
re-reads settlement from Stellar instead of trusting a returned hash.

| Service | Default URL |
|---|---|
| Bazaar | `http://localhost:3001` |
| Facilitator | `http://localhost:3002` |
| Reference seller | `http://localhost:3003` |
| Gateway | `http://localhost:3005` |
| Playground | `http://localhost:3004` |

For individual commands, expected output, clean-state steps, and port overrides,
use the [canonical testnet quickstart](docs/quickstart.md).

## x402 v2 HTTP flow

```text
buyer -> protected resource
resource -> HTTP 402 + PAYMENT-REQUIRED
buyer -> PAYMENT-SIGNATURE with a signed PaymentPayload
resource -> facilitator /verify
resource -> execute work
resource -> facilitator /settle
facilitator -> Stellar settlement
resource -> paid response + PAYMENT-RESPONSE
```

x402 v2 separates core types, scheme logic, and transport encoding:

- `PaymentRequired` contains `x402Version`, resource information, accepted
  `PaymentRequirements`, and optional extensions.
- `PaymentRequirements` contains `scheme`, CAIP-2 `network`, `asset`, atomic-unit
  `amount`, `payTo`, timeout, and scheme-specific `extra`.
- `PaymentPayload` contains the selected requirements in `accepted` plus the
  scheme-specific signed `payload`.
- `SettleResponse` reports success/failure, transaction, network, optional actual
  amount, and extensions.
- HTTP carries base64 JSON in `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, and
  `PAYMENT-RESPONSE`. `X-PAYMENT` and `maxAmountRequired` are v1 compatibility
  terminology, not active examples here.

The seller/resource server owns the HTTP 402 exchange. Veridex supplies the
facilitator and optional discovery/evidence services; those are not additional
sources of payment authority.

## Buyer

```ts
import { createVeridexClient } from "@veridex/stellar";

const client = createVeridexClient({
  network: "stellar:testnet",
  privateKey: process.env.BUYER_SECRET_KEY!,
});

const response = await client.fetch("http://localhost:3003/paid-resource");
console.log(await response.json());
```

`exact` is the default. Use `scheme: "upto"` only for a route advertising the
Veridex custom testnet scheme. The focused package is currently consumed from
this repository or a packed tarball; do not assume registry publication. See
the [buyer guide](docs/guide/buyer.md).

## Seller

The reference seller uses official `@x402/hono` and `@x402/stellar` server
integration. It declares Bazaar metadata in `PaymentRequired.extensions.bazaar`
through `declareDiscoveryExtension()`. After confirmed settlement, the
facilitator queues catalog work to a durable local outbox and delivers it
asynchronously to Bazaar.

Accepting payment does not require Bazaar, federation, or provider quality. See
the [seller guide](docs/guide/seller.md).

### Gateway seller

For an existing API, the gateway owns the 402/verify/settle edge and forwards
the original request only after confirmed settlement:

```text
existing HTTPS API -> gateway -> 402 -> facilitator -> Stellar -> original API
```

It preserves safe request fields, blocks private/reserved upstreams, applies
timeouts/body/concurrency/rate limits, declares the same Bazaar extension, and
records normalized payment/provider events for the future Developer Portal.
Start with the [gateway quickstart](docs/gateway-quickstart.md).

## Bazaar and MCP

Veridex exposes:

- `GET /discovery/resources` for filtered catalog browsing.
- `GET /discovery/search` for PostgreSQL full-text plus lexical
  feature-hash/RRF search, opaque cursors, and bounded telemetry scores.

Feature hashing is lexical, not learned semantic retrieval. Current response
shapes are in the [Bazaar guide](bazaar-service/README.md) and
[OpenAPI](docs/openapi/bazaar.yaml).

The custom stdio MCP service exposes `discover_resources` and `pay_resource`.
`pay_resource` is two-phase and exact-only: MCP returns a bounded challenge, the
client wallet signs it, and MCP re-fetches/matches the challenge before
submission. MCP does not hold a payer private key. See the
[MCP guide](mcp-server/README.md).

## Veridex Stellar `upto`

`upto` separates the authorized maximum from the actual settled amount:

```text
0 <= actual <= maximum
```

The payer signs bound terms including payer, `payTo`, token, ceiling, validity,
facilitator, settlement ID, and request digest. After work executes, the
facilitator attests to `actual` and the result digest. The active Soroban
contract atomically pulls the ceiling, pays `actual`, refunds the remainder,
leaves no residual allowance/balance, and records replay state.

Zero, partial, and full-cap usage are distinct outcomes. Zero is a terminal
on-chain settlement that refunds the full ceiling; the ceiling is never an
automatic charge. Over-cap settlement is rejected.

This is a Veridex testnet implementation. Installed stock
`@x402/stellar@2.21.0` exposes `exact` only, so upstream Stellar `upto`
interoperability is not claimed. See the
[Stellar `upto` specification](docs/specifications/scheme_upto_stellar.md).

## Documentation

- [Quickstart](docs/quickstart.md)
- [Gateway](docs/gateway.md), [gateway quickstart](docs/gateway-quickstart.md),
  and [Developer Portal boundary](docs/developer-portal-integration.md)
- [Developer guide index](docs/guide/README.md)
- [Buyer](docs/guide/buyer.md), [seller](docs/guide/seller.md),
  [agent](docs/guide/agent.md), and [operator](docs/guide/operator.md) guides
- [Architecture 3.2](docs/architecture.md)
- [Standards alignment and drift policy](docs/standards-alignment.md)
- [Errors](docs/errors.md) and [payment proof](docs/payment-proof.md)
- [Provider quality](docs/provider-quality.md) and
  [federation](docs/federation.md)
- [Package selection](docs/package-selection.md)
- [Facilitator OpenAPI](docs/openapi/x402.yaml) and
  [Bazaar OpenAPI](docs/openapi/bazaar.yaml)

## Validate

```bash
npm run docs:check
npm run typecheck
npm test
npm run build
cargo test --locked --manifest-path contracts/upto-settlement/Cargo.toml
```

The repository is Apache-2.0. Optional Playground `sharp`/`libvips` artifacts
have explicit license-policy exceptions and still require distribution review.
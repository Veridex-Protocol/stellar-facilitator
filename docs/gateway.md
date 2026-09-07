# Veridex Stellar x402 Gateway

**Status:** Exact gateway flow is proven on `stellar:testnet`; this is not a production-readiness claim. See the [gateway testnet proof](rfp/gateway-testnet-proof-2026-09-07.md).

The gateway is for a developer who already operates an API:

```text
existing HTTPS API
-> Veridex Gateway
-> canonical x402 v2 exact challenge
-> existing Veridex facilitator
-> Stellar settlement
-> original API
```

The gateway is an edge adapter, not a second facilitator. It uses
`x402ResourceServer`, `ExactStellarScheme`, and `HTTPFacilitatorClient` from the
same pinned x402 packages as the native seller path.

## Package decision

`gateway-service/` is a new deployable package in this repository. A separate
package is justified because HTTPS proxying, SSRF controls, body/response
limits, route configuration, lifecycle, and edge metrics are a distinct trust
boundary from settlement and catalog storage.

| Responsibility | Owner |
|---|---|
| Gateway configuration, proxying, lifecycle, edge events | `@veridex/x402-gateway` |
| Canonical x402 types and Stellar scheme | `@x402/core`, `@x402/stellar` |
| Settlement, receipts, Soroban/RPC/channel handling | Facilitator service |
| Buyer challenge/sign/retry | `@veridex/stellar` or official x402 client |
| Agent budget and approval behavior | `@veridex/agentic-payments` |
| Discovery admission, search, revalidation | Bazaar service |
| Passkey identity and wallets | `@veridex/sdk` |
| Developer/project identity and managed authorization | Relayer and Developer Portal |

The gateway does not introduce a wallet, checkout, authentication system,
catalog, or payment wire format.

## Exact request order

```text
request
-> 402 PAYMENT-REQUIRED
-> PAYMENT-SIGNATURE
-> facilitator /verify
-> facilitator /settle
-> confirmed SettleResponse
-> original API
-> provider outcome
-> response + PAYMENT-RESPONSE
```

Unpaid requests never reach the upstream. Settlement deliberately precedes the
upstream call. If settlement succeeds and the upstream then fails, the gateway
returns an upstream error with `PAYMENT-RESPONSE` and the transaction hash. It
does not claim or attempt an automatic refund.

## Configuration

The JSON configuration matches the conceptual `createGateway()` fields:

```json
{
  "id": "my-api",
  "upstream": "https://api.example.com",
  "publicBaseUrl": "https://paid.example.com",
  "facilitatorUrl": "https://facilitator.example.com",
  "payTo": "G...",
  "network": "stellar:testnet",
  "asset": "C...",
  "price": "50000",
  "routes": [
    {
      "path": "/weather",
      "methods": ["GET"],
      "bazaar": { "enabled": true }
    }
  ]
}
```

Amounts are atomic-unit integer strings. V1 supports `exact`. Generic `upto`
is intentionally absent because no generic HTTP signal determines billable
usage. A future `UsageAdapter` must provide explicit, domain-defined usage
before a gateway route may advertise `upto`.

## Routing and identity

Configured routes support `GET`, `POST`, `PUT`, `PATCH`, and `DELETE`. The
gateway preserves method, path, query, safe headers, and bounded bodies. It
removes authorization, proxy, hop-by-hop, payment, cookie, host, and forwarded
headers before the upstream call.

Resource identity is deterministic over public base URL, route template,
scheme, and network. Query values do not create separate catalog resources.
The upstream receives a stable payment-derived `Idempotency-Key` on retries.

## Persistence and portal boundary

Configuration remains separate from append-only payment/provider event files.
The self-hosted runtime uses private-mode JSONL files under
`.veridex/gateway/` or `GATEWAY_DATA_DIRECTORY`. This is zero-database V1
durability, not an HA managed datastore.

Authenticated read endpoints are enabled only when
`GATEWAY_MANAGEMENT_TOKEN` is configured:

- `GET /v1/gateways/:id`
- `GET /v1/gateways/:id/events`
- `GET /v1/gateways/:id/earnings`

Managed create/update/delete APIs are not implemented. They must use the
existing developer/project authentication boundary rather than trusting a
client-supplied developer ID.

## Fees and earnings

V1 records gross and net seller amount from confirmed exact terms. Gateway fee
is explicitly `"0"`. Facilitator fee is `null`/unknown unless a future
facilitator result supplies an attributable seller fee. The gateway never
manufactures fee or revenue data.

See [quickstart](gateway-quickstart.md), [security](gateway-security.md),
[Bazaar](gateway-bazaar.md), [Playground](gateway-playground.md), and
[Developer Portal integration](developer-portal-integration.md).
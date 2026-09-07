# Developer Portal integration boundary

The full portal UI is not part of the gateway V1. This document defines the
boundary so a later portal does not force payment-core changes.

## Existing platform ownership

- `@veridex/sdk` owns passkeys, wallets, Stellar passkey signing, and
  cross-origin server sessions.
- The relayer owns registered applications/projects and API keys.
- The Developer Portal owns its sealed-cookie BFF, workspace selection, API
  clients, data fetching, and dashboard presentation.
- `@veridex/agentic-payments` owns autonomous buyer policy and sessions.
- The Stellar gateway owns only seller configuration and observed payment,
  upstream, settlement, Bazaar, and provider facts.

The managed service must derive developer/project identity from authenticated
server context. `developerId` in a self-hosted config is correlation metadata,
not authorization.

## Available now

With `GATEWAY_MANAGEMENT_TOKEN`, the self-hosted gateway exposes
`veridex.portal.stellar-gateway/v1` containing:

- gateway lifecycle, public URL, upstream origin, and developer correlation;
- routes/resources, terms, Bazaar declaration, and MCP declaration status;
- normalized challenged/verified/settled/rejected/failed payment events;
- transaction hash, payer where available, settlement latency, and provider
  outcomes;
- exact gross amount, zero gateway fee, unknown facilitator fee, and net seller
  amount.

## Designed for the future portal

The portal BFF should expose project-scoped reads conceptually equivalent to:

```text
GET /developers/me/gateways
GET /developers/me/resources
GET /developers/me/payments
GET /developers/me/earnings
GET /developers/me/transactions
GET /developers/me/provider-quality
GET /developers/me/bazaar
```

Analytics can derive volume, revenue, average payment, success/failure rate,
top resources, settlement latency, and provider fault rate from normalized
events. Buyer aggregation must follow privacy policy.

## Not implemented

- Portal pages or dashboard calculations.
- Managed gateway create/update/delete APIs.
- Relayer/server-session authorization on gateway management routes.
- Durable multi-tenant SQL storage and ownership tables.
- Webhooks, export jobs, fee billing, API performance aggregation, and MCP
  activity ingestion.
- Credential vaulting or authenticated upstream header injection.

The production integration should replace the JSONL `GatewayEventStore` with a
project-scoped datastore adapter. It must not move the portal into the payment
critical path.
# Deployment and operations

This guide documents the current self-hosted testnet deployment. It is not a
pubnet or production deployment recipe. Production HA, TLS, backups, external
monitoring, alerts, and independent security review remain operator release
gates.

## Current tested deployment

Requirements:

- Node.js 22+
- Docker with Compose
- outbound access to Stellar testnet Horizon, Soroban RPC, Friendbot, and npm

```bash
git clone https://github.com/Veridex-Protocol/stellar-facilitator.git
cd stellar-facilitator
npm run demo
```

For clean-state and port-override details, use the
[testnet quickstart](quickstart.md).

The default Compose deployment starts:

| Service | Host URL/port | State |
|---|---|---|
| PostgreSQL + pgvector | Internal only | Named volume |
| Bazaar | `http://localhost:3001` | PostgreSQL catalog; process-local P2P state |
| Facilitator | `http://localhost:3002` | Process-local signer/quarantine/metrics; durable named outbox volume |
| Reference seller | `http://localhost:3003` | Stateless reference route |
| Gateway | `http://localhost:3005` | Static route config; JSONL payment/provider events in named volume |
| Playground | `http://localhost:3004` | Browser-local testnet signer and real gateway/native flows |

## Installation and bootstrap

The explicit sequence behind `npm run demo` is:

```bash
npm run install:all
npm run setup
docker compose up --build -d postgres bazaar facilitator demo-server gateway playground
npm run conformance
```

`npm run setup` creates Friendbot-funded testnet accounts and writes `.env` with
mode `0600`. Recreate accounts after a testnet reset:

```bash
npm run setup -- --force
docker compose up --build -d postgres bazaar facilitator demo-server
```

Do not use generated testnet keys on any network holding value.

## Health and readiness

```bash
curl -fsS http://localhost:3001/health
curl -fsS http://localhost:3001/ready
curl -fsS http://localhost:3002/health
curl -fsS http://localhost:3002/ready
curl -fsS http://localhost:3003/health
curl -fsS http://localhost:3005/health
curl -fsS http://localhost:3005/metrics
```

The facilitator performs boot-time checks before advertising capabilities:

- configured secret derives the public signer;
- claimed fee sponsor is funded;
- advertised testnet `upto` contract exists;
- job descriptors use advertised schemes/networks/assets;
- required public/internal configuration is present.

Always treat `GET /supported` as the runtime authority:

```bash
curl -fsS http://localhost:3002/supported | jq
```

`extra.areFeesSponsored` describes the checked deployment. Do not infer it from
documentation.

## Database and migrations

Compose runs PostgreSQL 16 with pgvector. Bazaar applies ordered SQL migrations
from `bazaar-service/src/db/migrations/`. Six migrations are currently tracked.

For localhost-only SQL access:

```bash
docker compose -f docker-compose.yml -f docker-compose.host-db.yml up -d
psql "host=127.0.0.1 port=${DATABASE_HOST_PORT:-55432} dbname=veridex_bazaar user=postgres"
```

The latest clean-room run applied all six migrations to an empty volume and
then passed `36/36` conformance. Periodic revalidation is implemented and
package-tested; a timed live stale-row refresh/quarantine drill remains open.

## Settlement signers

Each Stellar source account has one sequence number. Configure disjoint funded
channel keys per facilitator process:

```text
CHANNEL_SECRET_KEYS=SA...,SB...,SC...
SETTLE_QUEUE_TIMEOUT_MS=30000
```

The scheduler leases one signer per settlement and rejects saturated waits with
`settlement_capacity_exceeded` before submission. An unsuccessful result carrying
a transaction hash quarantines the exact leased signer. After reconciling the
hash, recover it explicitly:

```bash
curl -X POST \
  "$FACILITATOR_URL/internal/channels/$SIGNER/recover" \
  -H "Authorization: Bearer $FACILITATOR_INTERNAL_TOKEN"
```

Lease/quarantine state is process-local. Instances must never share channel
keys; durable multi-instance ownership is a production target.

## RPC coordination

Testnet can use an ordered provider list:

```text
SOROBAN_RPC_URLS=https://rpc-primary.example,https://rpc-secondary.example
RPC_REQUEST_TIMEOUT_MS=5000
```

The coordinator fails over reads/pre-submit health checks, submits to exactly
one provider, computes the envelope hash locally, and reconciles an ambiguous
result without blind resubmission. Conflicting final states fail safely.

Current proof is deterministic tests plus a live loopback testnet drill, not an
independent-operator or pubnet deployment.

## Catalog outbox

Confirmed settlement creates a transaction-keyed file-spool event before
asynchronous Bazaar delivery. In Compose the spool uses a named volume.

```text
CATALOG_OUTBOX_DIRECTORY=.veridex/catalog-outbox
CATALOG_OUTBOX_REPLAY_INTERVAL_MS=5000
```

Monitor `veridex_catalog_outbox_pending` and
`veridex_catalog_outbox_oldest_age`. This design isolates settlement from a
Bazaar outage on one host; it is not a shared HA queue.

## MCP

Run the optional stdio server:

```bash
MCP_ALLOW_LOCAL_URLS=true docker compose --profile mcp run --rm mcp-server
```

Use the local URL override only for this development stack. MCP holds no payer
key; signing remains client-side. See the [MCP guide](../mcp-server/README.md).

## Metrics and logs

```bash
curl -fsS http://localhost:3001/metrics
curl -fsS http://localhost:3002/metrics
curl -fsS http://localhost:3005/metrics
docker compose logs --no-log-prefix facilitator | npm run outcomes
```

Metrics are process-local unless scraped externally. The repository does not
ship Grafana dashboards, an alert manager, durable metrics retention, or
end-to-end request correlation. See [metrics](metrics.md).

Gateway events persist under `GATEWAY_DATA_DIRECTORY`; Compose uses the
`gateway-data` volume. `GATEWAY_MANAGEMENT_TOKEN` enables read-only `/v1`
contracts. Do not expose those routes without edge TLS and authenticated
project ownership. The local JSONL store is not multi-instance safe.

## Current facilitator request shape

Manual `/verify` and `/settle` calls use x402 v2 objects:

```json
{
  "x402Version": 2,
  "paymentPayload": {
    "x402Version": 2,
    "resource": { "url": "http://localhost:3003/paid-resource" },
    "accepted": {
      "scheme": "exact",
      "network": "stellar:testnet",
      "asset": "<SEP-41 contract>",
      "amount": "100000",
      "payTo": "<seller G-address>",
      "maxTimeoutSeconds": 120,
      "extra": { "areFeesSponsored": true }
    },
    "payload": { "transaction": "<base64 Stellar envelope>" }
  },
  "paymentRequirements": {
    "scheme": "exact",
    "network": "stellar:testnet",
    "asset": "<SEP-41 contract>",
    "amount": "100000",
    "payTo": "<seller G-address>",
    "maxTimeoutSeconds": 120,
    "extra": { "areFeesSponsored": true }
  }
}
```

Do not use flattened `{scheme, network, transactionXdr}` bodies or
`maxAmountRequired` in v2. Prefer the SDK/middleware instead of manually building
signed payloads.

## Production and pubnet gates

Before any public production claim:

1. Complete independent review of exact integration, fee sponsorship, custom
   `upto`, and cross-service controls.
2. Obtain explicit pubnet approval and publish pubnet transaction/conformance
   evidence. No such execution is part of the current evidence set.
3. Deploy pinned, reviewed container images; do not use `latest` tags.
4. Provide TLS termination, edge authentication/rate limiting, secret management,
   and key rotation.
5. Provide HA PostgreSQL and a tested backup/restore procedure.
6. Define shared outbox/channel ownership or strict instance partitioning.
7. Use independently operated RPC endpoints and test disagreement/ambiguity.
8. Deploy external metrics retention, dashboards, alert routing, and tested
   incident runbooks.
9. Prove multi-process federation restart/persistence before claiming production
   federation.
10. Publish reproducible `upto` WASM hashes/contract IDs and resolve audit
    findings before enabling the scheme.

The current repository is testnet design-partner evidence, not a ready-made
production topology.

# Veridex Stellar x402 Facilitator

Apache-2.0 implementation of canonical x402 v2 `exact` payments on Stellar, a
federated Bazaar discovery service, an MCP buyer, and a draft `upto` Soroban
contract.

## Settle a payment yourself

From a clean clone, no secrets, about a minute:

```bash
npm run demo
```

That creates Friendbot-funded testnet accounts, starts the stack, and runs the
conformance harness a stock x402 client installed from public npm paying for a
real resource on Stellar testnet. The settled transaction is then re-read from
Horizon, so a facilitator that returned a plausible hash without settling
anything would fail the run. Results land in `conformance-report.json`.

The same run happens in CI on every push and pull request, with accounts created
during the run and no stored secrets, so a fork gets the same green run.

## Developer guide

Three role-based paths, each runnable against testnet from a clean clone:

- [Seller path](docs/guide/seller.md) sells an API or MCP tool and gets it listed.
- [Buyer and agent path](docs/guide/buyer.md) discovers a service and pays for it.
- [Operator path](docs/guide/operator.md) runs the facilitator and catalog.

Start at [`docs/guide/`](docs/guide/README.md).

## Documentation

Full documentation is organized under [`docs/`](docs/) and throughout the workspace:

### Guides & Integration Paths
- **[Developer Guides Index](docs/guide/README.md)**: Role-based walkthroughs for integrating and operating.
  - **[Seller Path](docs/guide/seller.md)**: Host an API/MCP tool, return HTTP 402 challenges, and auto-list in the Bazaar.
  - **[Buyer & Agent Path](docs/guide/buyer.md)**: Discover endpoints via Bazaar/MCP and execute Stellar payments.
  - **[Operator Path](docs/guide/operator.md)**: Deploy a facilitator node, set up channel accounts, and run the catalog.

### Architecture & Operations
- **[System Architecture](docs/architecture.md)**: System design, payment and discovery planes, trust boundaries, and release invariants.
- **[Deployment Guide](docs/deployment.md)**: Production deployment guide, environment variables, PostgreSQL configuration, and Docker setup.
- **[Testnet Go-Live Runbook](testnet_docs.md)**: Operational checklist, boot-gated validation rules, channel pool sizing, and known limits.
- **[Bazaar Database Setup](bazaar-service/database_setup.md)**: PostgreSQL + pgvector schema initialization and migrations.

### Architecture Decision Records (ADRs)
- **[ADR Index & Reading Guide](docs/adr/README.md)**: Technical decision logs ([ADR-001](docs/adr/adr-001-discovery-federation.md) through [ADR-011](docs/adr/adr-011-upto-converge-upstream.md)):
  - [ADR-001: Discovery Federation](docs/adr/adr-001-discovery-federation.md) - Gossip mesh & catalog trust boundaries.
  - [ADR-002: Ranking & Embeddings](docs/adr/adr-002-ranking-and-embeddings.md) - Hybrid BM25 & feature-hash ranking.
  - [ADR-003: Settlement Liveness](docs/adr/adr-003-settlement-liveness.md) - Horizon settlement liveness vs P2P heartbeats.
  - [ADR-004: Catalog Integrity](docs/adr/adr-004-catalog-integrity.md) - Verified Horizon settlement binding.
  - [ADR-005: Verified Capabilities](docs/adr/adr-005-advertise-only-what-is-verified.md) - Boot-gated network capability checks.
  - [ADR-006: Recomputable Receipts](docs/adr/adr-006-recomputable-receipts.md) - RFC 8785 canonical JSON receipts (`x402job/1`).
  - [ADR-007: Settlement Throughput](docs/adr/adr-007-settlement-throughput.md) - Channel account leasing scheduler.
  - [ADR-008: Ledger-Skew Retry](docs/adr/adr-008-ledger-skew-retry.md) - Soroban RPC ledger-skew retry handling.
  - [ADR-009: Wire Conformance](docs/adr/adr-009-discovery-wire-conformance.md) - Wire filters, opaque cursors, and response headers.
  - [ADR-010: Conformance as Acceptance](docs/adr/adr-010-conformance-as-acceptance.md) - Conformance harness & log evidence.
  - [ADR-011: `upto` Contract Convergence](docs/adr/adr-011-upto-converge-upstream.md) - Metered usage contract constraints.

### Specifications & API References
- **[Protocol Specification](specification.md)**: Main x402 facilitator and Bazaar protocol specification.
- **[x402 Stellar Specification v2](docs/specifications/spec-v2.md)**: Technical spec for exact payments and discovery.
- **[Stellar `upto` Scheme Specification](docs/specifications/scheme_upto_stellar.md)**: Metered settlement scheme specification.
- **OpenAPI 3.0 Specifications**:
  - [Facilitator API OpenAPI Spec](docs/openapi/x402.yaml)
  - [Bazaar Discovery API OpenAPI Spec](docs/openapi/bazaar.yaml)

### Workspace Component Documentation
- **[SDKs Overview](sdks/README.md)** (with [TypeScript SDK](sdk-typescript/README.md) & [Python SDK](sdk-python/README.md))
- **[MCP Buyer Server](mcp-server/README.md)**
- **[Soroban Smart Contracts](contracts/README.md)**
- **[Interactive Playground](playground/README.md)**

## Implemented

- Canonical facilitator endpoints: `GET /supported`, `POST /verify`, `POST /settle`
- Stellar `exact` payments through `@x402/stellar`, with fee sponsorship
- Every advertised capability confirmed against the network at boot - the
  process refuses to start rather than advertise something untrue of it
- A reason code *and* a sentence on every rejection path, with the table tested
  exhaustive against the installed packages
- Retry for the Soroban RPC ledger-skew defect (x402-foundation/x402#3168),
  scoped to that one rejection and never applied to a failure carrying a
  transaction hash
- `x402job/1` recomputable receipts, signed over RFC 8785 canonical JSON
- Capability descriptor (`x402ccd/0`) built from configuration, not hardcoded
- Bounded settlement concurrency over channel accounts, so bursty agent traffic
  never collides on a sequence number (see Throughput below)
- PostgreSQL/pgvector catalog whose entries are bound to a settlement the
  Bazaar confirms on Horizon itself
- Signed GossipSub announcements, replay/freshness checks, heartbeats, liveness
  pruning
- Hybrid RRF ranking over BM25, feature-hash vectors, and live telemetry
- Discovery filters the spec names - `type`, `payTo`, `network`, `extensions`,
  `limit`, `offset` - on both `/discovery/resources` and `/discovery/search`
- Opaque cursor pagination, bound to the query that issued it, and a
  `partialResults` flag that reports a genuinely truncated candidate pool
- Cataloging outcomes reported to the seller in the `EXTENSION-RESPONSES`
  header on the settle response
- MCP tools: `discover_resources` plus a real HTTP 402 challenge/payment/retry
- TypeScript and Python buyer clients; TypeScript, Python, and Go seller helpers
- Soroban `upto` settlement contract, **deployed to testnet** at
  [`CAHV6TIA…`](https://stellar.expert/explorer/testnet/contract/CAHV6TIAOVSICUJHI6OBZSW2N5ZKRPGKHE2SH6OAEJHPHCLF5DXWAGG2)
  and boot-gated, though not yet audited

## Not built

Stated here rather than blurred into the list above:

- **Semantic retrieval.** The vector leg of Bazaar ranking is 384-dimensional
  feature hashing. It is a second lexical signal, not a learned embedding.
- **Catalog binding to a URL.** Entries are bound to a confirmed payment and one
  payment lists one resource, but the ledger does not record which URL was
  served. Binding that needs the resource server to sign the pairing.
- **`upto` audited.** The contract is deployed and advertised on testnet, with a
  reproducible wasm hash, but it has had no independent security review and is
  not integrated end to end.
- **A live ledger-skew recovery.** The retry is tested deterministically; it has
  not yet been observed rescuing a real degraded RPC window.

## Repository Map

| Path | Component | Documentation |
|---|---|---|
| `facilitator-service/` | x402 Payment Facilitator (`/verify`, `/settle`, `/supported`, `/.well-known/x402`) | [README](facilitator-service/README.md) |
| `bazaar-service/` | Federated Catalog & Hybrid Search Engine | [README](bazaar-service/README.md) |
| `mcp-server/` | Model Context Protocol Discovery & Payment Server | [README](mcp-server/README.md) |
| `playground/` | Next.js sandbox: pay on testnet, then verify the payment yourself | [README](playground/README.md) |
| `sdk-typescript/` | TypeScript Client & Seller Helpers | [README](sdk-typescript/README.md) |
| `sdk-python/` | Python Client & Seller Helpers | [README](sdk-python/README.md) |
| `sdks/` | Multi-language seller helpers (TypeScript, Python, Go) | [README](sdks/README.md) |
| `contracts/upto-settlement/`| Soroban `upto` Smart Contract | [README](contracts/upto-settlement/README.md) |
| `demo-server/` | Reference x402 Protected Resource Server | [README](demo-server/README.md) |
| `conformance/` | Conformance Test Harness | [README](conformance/README.md) |
| `scripts/` | Testnet Bootstrap, Concurrency Probes & Sync Scripts | [Overview](scripts/) |
| `docs/` | Architecture, ADRs, Specifications & Role Guides | [Guides](docs/guide/) |

## Requirements

- Node.js 22+
- Docker, for the one-command demo
- PostgreSQL 16 with pgvector (included in Compose)
- Rust stable for contract tests; Stellar CLI to build/deploy the WASM

## Running it directly

```bash
cp .env.testnet.example .env     # or: npm run setup
npm run install:all
docker compose up --build postgres bazaar facilitator demo-server
```

- Facilitator: `http://localhost:3002`
- Bazaar: `http://localhost:3001`
- Demo resource server: `http://localhost:3003`
- Optional MCP stdio server: `docker compose --profile mcp run --rm mcp-server`

`CHANNEL_POOL_SIZE=0` is the safe default and uses the configured signer. For concurrent settlement, provision persistent funded channel accounts in `CHANNEL_SECRET_KEYS`; do not enable automatic channel creation outside disposable testing.

## Verify

```bash
npm run typecheck
npm test
npm run conformance                     # against a running stack
cargo test --locked --manifest-path contracts/upto-settlement/Cargo.toml
python3 -m compileall -q sdk-python/veridex
docker compose config --quiet
```

## Discovery

`GET /discovery/resources` and `GET /discovery/search` accept the filters the
x402 discovery spec names:

| Parameter             | Meaning                                                  |
| --------------------- | -------------------------------------------------------- |
| `type`              | `http` or `mcp`                                      |
| `payTo`             | Stellar address receiving payment                        |
| `network`           | CAIP-2 identifier, e.g.`stellar:testnet`               |
| `extensions`        | Comma-separated; matches resources declaring all of them |
| `limit`, `offset` | Page size and start;`limit` is clamped to 100          |
| `cursor`            | Opaque continuation token; supersedes`offset`          |

Paging uses `nextCursor` rather than a client-computed offset. A cursor is bound to the query and filters that issued it, so presenting one against a different query returns `400 invalid_cursor` instead of silently answering with the wrong page the same offset under different terms is a different set of rows.

`partialResults` is answered, not hardcoded. It is true when a retrieval leg filled its candidate pool, meaning ranking saw a truncated set and this page is not a complete answer; `partialReason` says so in words.

Cataloging outcomes come back in the `EXTENSION-RESPONSES` header base64 JSON of `{"bazaar":{"status":…,"rejectedReason":…}}` - on the Bazaar's ingest response *and* on the facilitator's `/settle` response, so a seller learns from the same call that settled the payment whether its listing landed.

**A settlement counts as liveness.** Liveness used to derive from P2P heartbeats alone, which meant an automatically catalogued resource was pruned to `OFFLINE` within minutes and vanished from search unless its seller also ran a libp2p node. That defeats automatic cataloging. A settlement this service confirmed on Horizon is proof the endpoint was reachable and served a paying caller, so it restores `HEALTHY` and keeps the resource discoverable (`SETTLEMENT_LIVENESS_WINDOW_MS`, default 24h).

## Throughput

A Stellar account has one sequence number, so two settlements from the same account race for it: one lands, the other returns `tx_bad_seq` and is retried until it wins. Measured here before this was addressed, one settlement took **307 seconds** and the resource server's HTTP client had long since returned a 502 the buyer paid and got nothing.

The fix is channel accounts plus a settlement scheduler that makes the guarantee airtight:

- **Channel accounts.** Each funded account in `CHANNEL_SECRET_KEYS` advances its own sequence number. `npm run setup` provisions three.
- **A settlement scheduler.** `@x402/stellar` round-robins across signers, which makes a collision less likely but not impossible: with N signers the N+1st concurrent request still lands on a busy account. The scheduler leases a signer before `settle()` and pins `selectSigner` to it, so no account is ever used twice at once. Overflow queues in FIFO order and, past `SETTLE_QUEUE_TIMEOUT_MS`, is refused with `settlement_capacity_exceeded` and an explicit "no funds moved".

Settlement concurrency is therefore exactly the pool size, and the way to raise it is to fund more channel accounts. Measure it:

```bash
npm run probe -- --n 6
```

Latest run, 4 signers, 6 simultaneous settlements:

```
  succeeded           6/6
  confirmed on ledger 6/6
  latency             min 6509ms  p50 11884ms  max 11991ms
  source accounts     3 distinct
  scheduler           3 queued, 0 refused, longest wait 7658ms
```

`/stats` exposes the same counters under `settlementConcurrency`. A rising `queued`, or any `totalRejected`, means the pool is too small for the load.

## Reliability figures

`/stats` keeps counters in process memory. They reset on restart, which makes them fine for a dashboard and useless as the basis of a published claim. Anything stated publicly comes from the structured `request_outcome` log lines and recomputes with:

```bash
docker compose logs --no-log-prefix facilitator | npm run outcomes
```

## API notes

`/x402/verify` and `/x402/settle` are compatibility aliases. Pre-canonical payload handling is isolated under `/legacy/verify` and `/legacy/settle`. Networks on the canonical path are `stellar:testnet` and `stellar:pubnet`; assets are SEP-41 contract addresses, not classic identifiers such as `native`.

Testnet launch requirements and remaining operator-owned steps are in [testnet_docs.md](testnet_docs.md). OpenAPI definitions are in [docs/openapi/](docs/openapi/) ([`x402.yaml`](docs/openapi/x402.yaml) and [`bazaar.yaml`](docs/openapi/bazaar.yaml)). System architecture details are in [docs/architecture.md](docs/architecture.md) and deployment steps are in [docs/deployment.md](docs/deployment.md).

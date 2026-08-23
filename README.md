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

Start at [`docs/guide/`](docs/guide/).

## Implemented

- Canonical facilitator endpoints: `GET /supported`, `POST /verify`, `POST /settle`
- Stellar `exact` payments through `@x402/stellar`, with fee sponsorship
- Every advertised capability confirmed against the network at boot — the
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
- Discovery filters the spec names — `type`, `payTo`, `network`, `extensions`,
  `limit`, `offset` — on both `/discovery/resources` and `/discovery/search`
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

## Layout

| Path                           | What it is                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------- |
| `facilitator-service/`       | The facilitator.`/verify`, `/settle`, `/supported`, `/.well-known/x402` |
| `bazaar-service/`            | Catalog, hybrid search, P2P mesh                                                |
| `demo-server/`               | A minimal seller, so the harness has something real to buy                      |
| `conformance/`               | The harness. Imports nothing from this repository                               |
| `mcp-server/`                | MCP buyer                                                                       |
| `contracts/upto-settlement/` | Soroban`upto` prototype                                                       |
| `scripts/`                   | Testnet bootstrap, log summarizer                                               |

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

Cataloging outcomes come back in the `EXTENSION-RESPONSES` header base64 JSON of `{"bazaar":{"status":…,"rejectedReason":…}}` — on the Bazaar's ingest response *and* on the facilitator's `/settle` response, so a seller learns from the same call that settled the payment whether its listing landed.

**A settlement counts as liveness.** Liveness used to derive from P2P heartbeats alone, which meant an automatically catalogued resource was pruned to `OFFLINE` within minutes and vanished from search unless its seller also ran a libp2p node. That defeats automatic cataloging. A settlement this service confirmed on Horizon is proof the endpoint was reachable and served a paying caller, so it restores `HEALTHY` and keeps the resource discoverable (`SETTLEMENT_LIVENESS_WINDOW_MS`, default 24h).

## Throughput

A Stellar account has one sequence number, so two settlements from the same account race for it: one lands, the other returns `tx_bad_seq` and is retried until it wins. Measured here before this was addressed, one settlement took **307 seconds** and the resource server's HTTP client had long since returned a 502 the buyer paid and got nothing.

The fix is the remedy the RFP names, plus the part that makes it airtight:

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

Testnet launch requirements and the remaining operator-owned steps are in [testnet_docs.md](testnet_docs.md). OpenAPI definitions are in [docs/openapi](docs/openapi/).

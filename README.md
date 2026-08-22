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
conformance harness — a stock x402 client installed from public npm paying for a
real resource on Stellar testnet. The settled transaction is then re-read from
Horizon, so a facilitator that returned a plausible hash without settling
anything would fail the run. Results land in `conformance-report.json`.

The same run happens in CI on every push and pull request, with accounts created
during the run and no stored secrets, so a fork gets the same green run.

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
- Persistent channel keys, safe zero-channel operation, leasing and cooldown
- PostgreSQL/pgvector catalog whose entries are bound to a settlement the
  Bazaar confirms on Horizon itself
- Signed GossipSub announcements, replay/freshness checks, heartbeats, liveness
  pruning
- Hybrid RRF ranking over BM25, feature-hash vectors, and live telemetry
- MCP tools: `discover_resources` plus a real HTTP 402 challenge/payment/retry
- TypeScript and Python buyer clients; TypeScript, Python, and Go seller helpers
- Soroban `upto` prototype, tested and **not deployed** — the scheme is absent
  from `/supported` until a contract is confirmed on-chain

## Not built

Stated here rather than blurred into the list above:

- **Semantic retrieval.** The vector leg of Bazaar ranking is 384-dimensional
  feature hashing. It is a second lexical signal, not a learned embedding.
- **Catalog binding to a URL.** Entries are bound to a confirmed payment and one
  payment lists one resource, but the ledger does not record which URL was
  served. Binding that needs the resource server to sign the pairing.
- **`upto` in production.** The contract has tests. It is not deployed, not
  advertised, and not integrated end to end.
- **A live ledger-skew recovery.** The retry is tested deterministically; it has
  not yet been observed rescuing a real degraded RPC window.

## Layout

| Path | What it is |
| --- | --- |
| `facilitator-service/` | The facilitator. `/verify`, `/settle`, `/supported`, `/.well-known/x402` |
| `bazaar-service/` | Catalog, hybrid search, P2P mesh |
| `demo-server/` | A minimal seller, so the harness has something real to buy |
| `conformance/` | The harness. Imports nothing from this repository |
| `mcp-server/` | MCP buyer |
| `contracts/upto-settlement/` | Soroban `upto` prototype |
| `scripts/` | Testnet bootstrap, log summarizer |

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

`CHANNEL_POOL_SIZE=0` is the safe default and uses the configured signer. For
concurrent settlement, provision persistent funded channel accounts in
`CHANNEL_SECRET_KEYS`; do not enable automatic channel creation outside
disposable testing.

## Verify

```bash
npm run typecheck
npm test
npm run conformance                     # against a running stack
cargo test --locked --manifest-path contracts/upto-settlement/Cargo.toml
python3 -m compileall -q sdk-python/veridex
docker compose config --quiet
```

## Reliability figures

`/stats` keeps counters in process memory. They reset on restart, which makes
them fine for a dashboard and useless as the basis of a published claim.
Anything stated publicly comes from the structured `request_outcome` log lines
and recomputes with:

```bash
docker compose logs --no-log-prefix facilitator | npm run outcomes
```

## API notes

`/x402/verify` and `/x402/settle` are compatibility aliases. Pre-canonical
payload handling is isolated under `/legacy/verify` and `/legacy/settle`.
Networks on the canonical path are `stellar:testnet` and `stellar:pubnet`;
assets are SEP-41 contract addresses, not classic identifiers such as `native`.

Testnet launch requirements and the remaining operator-owned steps are in
[TESTNET_GO_LIVE.md](TESTNET_GO_LIVE.md). OpenAPI definitions are in
[docs/openapi](docs/openapi/).

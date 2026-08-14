# Veridex Stellar Facilitator v2

Apache-2.0 implementation of canonical x402 v2 exact payments on Stellar, a federated Bazaar discovery service, an MCP buyer, and a draft/tested Soroban `upto` contract.

## Implemented

- Canonical facilitator endpoints: `GET /supported`, `POST /verify`, `POST /settle`
- Stellar exact payments through `@x402/stellar`, with fee sponsorship
- Persistent channel keys, safe zero-channel operation, leasing and cooldown
- PostgreSQL/pgvector catalog with passive settlement ingestion
- Signed GossipSub announcements, replay/freshness checks, active heartbeats, and liveness pruning
- Hybrid keyword/vector/telemetry ranking (deterministic local feature-hash vectors)
- MCP tools: `discover_resources` and an actual HTTP 402 challenge/payment/retry flow
- TypeScript and Python buyer clients; TypeScript, Python, and Go seller helpers
- Soroban `upto` prototype; the non-custodial one-signature design remains release-gated

The authoritative production target is [architecture.md](docs/architecture.md). The `upto` wire and contract design is [scheme_upto_stellar.md](docs/specifications/scheme_upto_stellar.md); it remains a release-gated draft and is not advertised until its contract redesign, conformance suite, and security review are complete. Historical proposal material is retained under `docs/specifications/`.

## Requirements

- Node.js 22+
- PostgreSQL 16 with pgvector (included in Compose)
- Rust stable for contract tests; Stellar CLI for WASM build/deployment
- A funded Stellar testnet facilitator account

## Local startup

```bash
cp .env.testnet.example .env
# Fill FACILITATOR_SECRET_KEY and FACILITATOR_PUBLIC_KEY.
docker compose up --build postgres bazaar facilitator
```

The safe default is `CHANNEL_POOL_SIZE=0`, which uses the configured facilitator signer. For concurrent production settlement, provision persistent funded channel accounts and put their comma-separated secrets in `CHANNEL_SECRET_KEYS`; do not enable automatic channel creation outside disposable testing.

Services:

- Facilitator: `http://localhost:3002`
- Bazaar: `http://localhost:3001`
- Optional MCP stdio server: `docker compose --profile mcp run --rm mcp-server`

## Verify

```bash
npm --prefix facilitator-service ci && npm --prefix facilitator-service test -- --run
npm --prefix bazaar-service ci && npm --prefix bazaar-service test -- --run
npm --prefix mcp-server ci && npm --prefix mcp-server run build
npm --prefix sdk-typescript ci && npm --prefix sdk-typescript run build
python3 -m compileall -q sdk-python/veridex
cargo test --locked --manifest-path contracts/upto-settlement/Cargo.toml
docker compose config --quiet
```

OpenAPI definitions are in [docs/openapi](docs/openapi/). Testnet launch requirements and the remaining operator-owned steps are in [TESTNET_GO_LIVE.md](TESTNET_GO_LIVE.md).

## API notes

`/x402/verify` and `/x402/settle` remain compatibility aliases. Old noncanonical payload handling is isolated under `/legacy/verify` and `/legacy/settle`. Networks on the canonical payment path are `stellar:testnet` and `stellar:pubnet`; assets are SEP-41 contract addresses, not classic `native` asset identifiers.

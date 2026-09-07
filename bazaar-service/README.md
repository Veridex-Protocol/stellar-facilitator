# Veridex Bazaar Service (`@veridex/bazaar-service`)

Settlement-backed discovery and lexical hybrid search for x402-protected HTTP
resources and MCP tools on Stellar. Federation is locally process-proven, not a
production claim.

---

## Architecture Overview

Bazaar is an advisory discovery layer. Listings and ranking do not authorize
payment; buyers must validate the live signed x402 requirements.

```text
  Resource Seller                  Bazaar Discovery Engine                 Client / Buyer
         │                                   │                                    │
         ├── Settle Payment via x402 ───────►│                                    │
         │   (carrying bazaar extension)     ├── Confirm Settlement on Horizon    │
         │                                   ├── Validate Schema & Route Safety   │
         │                                   ├── Index in PostgreSQL / pgvector   │
         │                                   ├── Broadcast Signed GossipSub Msg   │
         │                                   │                                    │
         │                                   │◄── GET /discovery/search ──────────┤
         │                                   │    (Lexical hybrid / filters)      │
         │                                   ├── Hybrid Search & RRF Ranking      │
         │                                   │─── Return Ranked JSON Results ────►│
```

### Core Features

1. **Hybrid Search with Reciprocal Rank Fusion (RRF)**:
   - Fuses PostgreSQL full-text cover-density ranking (`ts_rank_cd`) with `pgvector` feature-hash vector cosine distance using Reciprocal Rank Fusion ($k=60$).
   - Telemetry metrics (uptime ratio, latency, reliability) modulate the score as a quality multiplier without displacing relevant search matches.
2. **Asynchronous Cataloging with Settlement Verification**:
   - A confirmed payment carrying the `bazaar` extension creates a durable facilitator outbox event.
   - Bazaar ingestion happens asynchronously; immediate settlement status is `queued`, not synchronously cataloged.
   - Verifies the settlement transaction on Horizon before listing to prevent catalog spam.
   - Enforces settlement/payee integrity, live 402 terms, owner/delegate authorization for updates, and database invariants to prevent hijacking.
3. **P2P Federated GossipSub Mesh (libp2p)**:
   - Relays announcements across peer nodes with RFC 8785 canonical deterministic JSON signing (preventing relay peer tampering).
4. **Search Quality Evaluation Harness**:
   - Built-in information retrieval benchmark suite measuring **nDCG@5**, **nDCG@10**, **MRR**, and **Recall@k** against judged query datasets with automated CI regression gates.

---

## API Endpoints

| Method | Path | Description | Authentication |
|---|---|---|---|
| `GET` | `/discovery/search` | Natural language hybrid search with RRF ranking and filters | Public |
| `GET` | `/discovery/resources` | Paginated catalog listing with filter queries | Public |
| `POST` | `/announce` | Publish signed announcement to the P2P GossipSub mesh | Bearer Token |
| `POST` | `/catalog/ingest` | Internal ingestion endpoint called by facilitator upon settlement | Bearer Token |
| `GET` | `/.well-known/x402` | Capability Descriptor (`x402ccd/0`) | Public |
| `GET` | `/health` | Database and P2P peer connectivity health check | Public |
| `GET` | `/stats` | Live search, telemetry, and P2P mesh statistics | Public |
| `GET` | `/ready` | Database/P2P readiness | Public |
| `GET` | `/metrics` | Prometheus text metrics | Public |
| `GET` | `/v1/provider` | Current signed provider aggregate or insufficient-data state | Public |
| `GET` | `/v1/provider/observations` | Digest-only observation history | Public |
| `GET` | `/v1/provider/disagreements` | Cross-source disagreement history | Public |

---

## Query Parameters for `/discovery/search`

- `q`: Search query string (e.g. `weather API`, `Soroban RPC node`, `image generation`)
- `type`: Resource type (`http` or `mcp`)
- `network`: CAIP-2 network filter; active examples use `stellar:testnet`
- `scheme`: Payment scheme (`exact`, `upto`)
- `payTo`: Filter to resources paying a specific Stellar G-address
- `tags`: Comma-separated list of tags
- `extensions`: Comma-separated extension keys; all must be present
- `minUptimeRatio`: Minimum recorded uptime ratio
- `limit`: Results per page (1-100, default 20)
- `offset`: Offset index (clamped non-negative)
- `cursor`: Opaque pagination token returned in `nextCursor`

---

## Configuration

| Variable | Description | Default |
|---|---|---|
| `DATABASE_HOST` | PostgreSQL host | `localhost` |
| `DATABASE_PORT` | PostgreSQL port | `5432` |
| `DATABASE_NAME` | Database name | `veridex_bazaar` |
| `DATABASE_USER` | Database username | `postgres` |
| `DATABASE_PASSWORD` | Database password | `""` |
| `P2P_LISTEN_ADDRS` | libp2p listen multiaddresses | `/ip4/0.0.0.0/tcp/4001` |
| `P2P_BOOTSTRAP_PEERS` | Comma-separated bootstrap multiaddresses | `""` |
| `BAZAAR_INTERNAL_TOKEN` | Shared secret for catalog and in-band provider observation writes | Required |
| `PROVIDER_QUALITY_AUTHORIZED_SIGNERS` | Comma-separated in-band observation signers | Optional |
| `PROVIDER_OBSERVER_TOKEN` | Separate bearer credential for independent observations; at least 24 characters | Disabled |
| `PROVIDER_OBSERVER_AUTHORIZED_SIGNERS` | Comma-separated independent observer signers | Disabled |
| `BAZAAR_PORT` | HTTP server port | `3001` |

---

## Getting Started

### 1. Start Database
```bash
docker compose up -d postgres
```

### 2. Run Locally
```bash
npm run dev
```

### 3. Run Test Suite
```bash
npm test
```

The response format is Veridex-specific (`results`, `total`, `nextCursor`,
`partialResults`, and component scores); storage/search response shape is not
defined by the x402 core protocol. Feature hashing is lexical rather than
semantic. See [standards alignment](../docs/standards-alignment.md),
[provider quality](../docs/provider-quality.md), and
[federation](../docs/federation.md).

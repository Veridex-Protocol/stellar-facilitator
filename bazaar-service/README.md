# Veridex Bazaar Service (`@veridex/bazaar-service`)

Federated discovery engine and search catalog for x402-protected APIs and MCP tools on Stellar.

---

## Architecture Overview

The Bazaar Service provides a trustless discovery layer where client software can search, filter, and inspect paid resources without a pre-existing integration:

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
2. **Automated Cataloging with Settlement Verification**:
   - Zero-step automatic indexing when a payment carries the `bazaar` extension.
   - Verifies the settlement transaction on Horizon before listing to prevent catalog spam.
   - Enforces cryptographic owner signatures (`ownerSignature`) and database invariants to prevent listing hijacking.
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

---

## Query Parameters for `/discovery/search`

- `q`: Search query string (e.g. `weather API`, `Soroban RPC node`, `image generation`)
- `type`: Resource type (`http` or `mcp`)
- `network`: Network filter (e.g. `stellar:testnet`, `stellar:pubnet`)
- `scheme`: Payment scheme (`exact`, `upto`)
- `payTo`: Filter to resources paying a specific Stellar G-address
- `tags`: Comma-separated list of tags
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
| `INTERNAL_TOKEN` | Shared secret with facilitator for `/catalog/ingest` and `/announce` | Required |
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

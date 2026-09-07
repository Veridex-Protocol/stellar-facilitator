# Veridex Facilitator Service (`@veridex/facilitator-service`)

Stellar x402 v2 facilitator for testnet-proven `exact` and the custom,
experimental Veridex `upto` scheme. It provides non-custodial verification,
Soroban auth-entry validation, channel-pooled settlement, fee sponsorship, and
custom Veridex receipts. Production/pubnet readiness is not claimed.

---

## Architecture Overview

The Facilitator Service is a security-sensitive settlement gateway between HTTP
402 resource servers, buyer clients, and Stellar. It is not “trustless”: callers
rely on it to verify and submit correctly, then independently inspect ledger
evidence.

```text
  Client (Buyer)           Resource Server (Seller)        Facilitator Service           Stellar / Soroban
       │                              │                             │                           │
       ├── HTTP GET /resource ───────►│                             │                           │
       │◄── 402 Payment Required ─────┤                             │                           │
       │    (with x402 headers)       │                             │                           │
       │                              │                             │                           │
       ├── Retry GET with payment ───►│                             │                           │
       │   authorization              ├── POST /verify ────────────►│                           │
       │                              │◄── { isValid: true } ───────┤                           │
       │                              │                             │                           │
       │                              ├── POST /settle ────────────►│ (Lease channel signer)    │
       │                              │                             ├── Submit Fee-Bump Tx ────►│
       │                              │◄── { success: true, tx } ───┤◄── Confirm on Ledger ─────┤
       │◄── 200 OK + Resource Data ───┤                             │                           │
```

### Core Features

1. **Multi-Scheme Routing (`exact` and `upto`)**:
   - `exact`: Standard per-request fixed payment using Soroban authorization entries and SEP-41 token contracts (USDC, XLM, EURC).
   - `upto`: Custom metered Soroban settlement with a signed ceiling, actual usage, atomic payment/refund, and replay state. The contract retains no balance after invocation; it is experimental and unaudited.
2. **Fee Sponsorship**:
   - Covers Stellar transaction fees using FeeBump transactions so buyers need only payment assets (e.g. USDC) and zero native XLM balance.
3. **Channel Account Pool**:
   - High-throughput parallel settlement execution using dedicated channel accounts to avoid Stellar sequence number contention (`tx_bad_seq`).
4. **Ledger-Skew Retry Engine**:
   - Resilient retry loop protecting against transient Soroban RPC validation divergence without double-spending.
5. **Rate Limiting & Proxy Protection**:
   - Fixed-window rate limiter with `TRUSTED_PROXY_COUNT` support to prevent spoofed `X-Forwarded-For` header rotation.
6. **Capability Descriptor (`x402ccd/0`)**:
   - Dynamic capability discovery at `/.well-known/x402`.

---

## API Endpoints

| Method | Path | Description | Authentication |
|---|---|---|---|
| `GET` | `/supported` | Lists supported networks, payment schemes, and fee sponsorship status | Public |
| `POST` | `/verify` | Validates a payment authorization payload against payment requirements | Public |
| `POST` | `/settle` | Submits authorization to Stellar, pays fees, and returns settlement receipt | Public |
| `GET` | `/.well-known/x402` | Emits x402 Capability Descriptor (`x402ccd/0`) | Public |
| `GET` | `/health` | Service and RPC connectivity health check | Public |
| `GET` | `/stats` | Telemetry counters and channel pool concurrency metrics | Public |
| `GET` | `/metrics` | Prometheus text metrics | Public |
| `POST` | `/internal/channels/:address/recover` | Recover a reconciled quarantined signer | Internal bearer token |

---

## Configuration

Set the following environment variables (or copy from `.env.testnet.example`):

| Variable | Description | Default |
|---|---|---|
| `STELLAR_NETWORK` | Stellar network (`testnet` or `pubnet`) | `testnet` |
| `HORIZON_URL` | Horizon API endpoint | `https://horizon-testnet.stellar.org` |
| `SOROBAN_RPC_URL` | Soroban RPC endpoint | `https://soroban-testnet.stellar.org` |
| `SOROBAN_RPC_URLS` | Ordered, comma-separated independent Soroban RPC providers. Enables bounded failover when at least two are configured; testnet only in this release. | Value of `SOROBAN_RPC_URL` |
| `RPC_REQUEST_TIMEOUT_MS` | Per-provider coordinator timeout | `5000` |
| `CATALOG_OUTBOX_DIRECTORY` | Durable local spool for post-settlement catalog events | `.veridex/catalog-outbox` |
| `CATALOG_OUTBOX_REPLAY_INTERVAL_MS` | Retry interval for retained catalog events | `5000` |
| `FACILITATOR_INTERNAL_TOKEN` | Bearer token required to recover a reconciled quarantined signer | Required for recovery route |
| `FACILITATOR_SECRET_KEY` | Stellar S-secret key for the facilitator master signer | Required |
| `CHANNEL_SECRET_KEYS` | Comma-separated list of funded channel signer secret keys | Optional |
| `MAX_TRANSACTION_FEE_STROOPS`| Max network fee per settlement sponsored by facilitator | `50000` (0.005 XLM) |
| `TRUSTED_PROXY_COUNT` | Number of trusted reverse proxies in front of service | `0` |
| `FACILITATOR_PORT` | HTTP listening port | `3002` |

Catalog delivery is durable but remains outside settlement success. A confirmed
payment writes one transaction-keyed outbox event before the bounded Bazaar
attempt. Timeouts and 5xx responses retain the event for replay; a definitive
catalog acceptance or metadata rejection acknowledges it. In Compose the spool
uses the `facilitator-outbox` volume.

An unsuccessful settlement result carrying a transaction hash quarantines the
exact leased signer. After reconciling that hash, an operator recovers it with:

```bash
curl -X POST "$FACILITATOR_URL/internal/channels/$SIGNER/recover" \
   -H "Authorization: Bearer $FACILITATOR_INTERNAL_TOKEN"
```

---

## Getting Started

### 1. Install Dependencies
```bash
npm install
```

### 2. Run Locally
```bash
npm run dev
```

### 3. Run Test Suite
```bash
npm test
```

Canonical request/response schemas are in
[Facilitator OpenAPI](../docs/openapi/x402.yaml). x402 v2 uses
`PaymentRequirements.amount`, `PaymentPayload.accepted`, and `SettleResponse`.
HTTP resources carry protocol objects through `PAYMENT-REQUIRED`,
`PAYMENT-SIGNATURE`, and `PAYMENT-RESPONSE`.

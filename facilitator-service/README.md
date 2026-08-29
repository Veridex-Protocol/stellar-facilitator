# Veridex Facilitator Service (`@veridex/facilitator-service`)

Production-grade x402 v2 payment facilitator for the Stellar network. Provides non-custodial verification, Soroban auth-entry validation, channel-pooled settlement, and fee sponsorship for both `exact` and `upto` payment schemes.

---

## Architecture Overview

The Facilitator Service sits as the trustless settlement gateway between HTTP 402 resource servers (sellers), agent runtimes (buyers), and the Stellar blockchain:

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
   - `upto`: Metered smart contract escrow settlement via Soroban smart contract with ceiling authorization and actual usage charging.
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

---

## Configuration

Set the following environment variables (or copy from `.env.testnet.example`):

| Variable | Description | Default |
|---|---|---|
| `STELLAR_NETWORK` | Stellar network (`testnet` or `pubnet`) | `testnet` |
| `HORIZON_URL` | Horizon API endpoint | `https://horizon-testnet.stellar.org` |
| `SOROBAN_RPC_URL` | Soroban RPC endpoint | `https://soroban-testnet.stellar.org` |
| `FACILITATOR_SECRET_KEY` | Stellar S-secret key for the facilitator master signer | Required |
| `CHANNEL_SECRET_KEYS` | Comma-separated list of funded channel signer secret keys | Optional |
| `MAX_TRANSACTION_FEE_STROOPS`| Max network fee per settlement sponsored by facilitator | `50000` (0.005 XLM) |
| `TRUSTED_PROXY_COUNT` | Number of trusted reverse proxies in front of service | `0` |
| `FACILITATOR_PORT` | HTTP listening port | `3002` |

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

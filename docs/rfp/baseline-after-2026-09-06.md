# Baseline to After

| Capability | Before | After | Evidence |
|---|---|---|---|
| Catalog integrity | Settlement proof and payee anti-hijack only | Live 402 agreement on resource/network/scheme/asset/payee/amount; stale rows refresh or quarantine | Migration `005`; 13 live-term and 3 periodic tests |
| RPC failover | One Soroban RPC URL; no ambiguous-submission reconciliation | Ordered testnet providers, health, read failover, exactly-one submission, local hash reconciliation, disagreement failure | 6 RPC coordinator tests through JSON-RPC and actual Stellar SDK client |
| Durable catalog delivery | Bounded direct handoff after settlement; failed delivery was lost | Transaction-keyed atomic file-spool outbox with asynchronous delivery, retry, restart replay, pending/age metrics | Unavailable-Bazaar retention/replay regression; live stack drained to zero |
| Channel concurrency | Per-signer scheduler and one-level testnet probe | Timed settlement-only `10/25/50/100` matrix plus exact-signer quarantine and authenticated explicit recovery | 185-request load smoke; 32 confirmed, zero retries/sequence errors; quarantine/recovery tests |
| Search evaluation | 10 documents/6 queries; hybrid-only nDCG/MRR/Recall@5 | 10 documents/50 categorized queries; lexical baseline/current; Recall@1/5/20, nDCG@5/10, MRR, coverage, no-result, p50/p95 | Committed 2026-09-06 report; hybrid nDCG@10 `0.8633` |
| Provider quality | Signed outcomes/aggregates and one policy ceiling | Explicit policy modes plus persisted in-band/independent sources and cross-source disagreement | Migration `006`; focused store and SDK tests |
| Metrics | Structured logs and `/stats`; docs claimed unimplemented endpoints | Tested Prometheus text endpoints for facilitator and Bazaar required metrics | Metrics endpoint tests; documented semantics |
| Federation | Signed deltas; two-node relay | Local three-node A/B/C signed upsert/revoke/restore convergence and unauthorized signer rejection | Live in-process libp2p test plus deterministic conflict tests |
| MCP | In-process payer private key; seller text interpolated into prose | Two-phase challenge/external-signature flow with no payer key; seller data isolated as `untrusted_seller_data` | MCP tests; keyless testnet settlements at ledgers `4539099` and `4539121` |
| Stable errors | Package-specific shapes and partial reason maps | Canonical 19-code registry with facilitator/Bazaar/MCP/SDK snapshots and CI drift check | `npm run errors:check`; adapter tests |
| Policy evidence | Custom signer types only | Public agent SDK budget fixture: `$2` passes `$10`, `$12` blocks, cumulative `$2 + $9` blocks | `npm run policy:proof`; explicitly off-chain, not deployed smart-account proof |
| Dependency gate | Manual license inventory | CI error/license gates; Next `16.3.4` and Stellar SDK `16.2.0`; zero Playground production advisories | `npm run licenses:check`; 14 explicit optional libvips exceptions remain for legal review |
| SDK | Packed external real payment previously proven | Fresh external public import/payment; registry still 404 | External consumer settled at ledger `4539556`; npm lookup |
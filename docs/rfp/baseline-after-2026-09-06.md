# Baseline to After

| Capability | Before | After | Evidence |
|---|---|---|---|
| Catalog integrity | Settlement proof and payee anti-hijack only | Live 402 agreement on resource/network/scheme/asset/payee/amount; stale rows refresh or quarantine | Migration `005`; 13 live-term and 3 periodic tests |
| RPC failover | One Soroban RPC URL; no ambiguous-submission reconciliation | Ordered testnet providers, health, read failover, exactly-one submission, local hash reconciliation, disagreement failure | 6 RPC coordinator tests through JSON-RPC and actual Stellar SDK client |
| Channel concurrency | Per-signer scheduler and one-level testnet probe | Existing scheduler preserved; matrix harness adds 10/25/50/100, p95, throughput, retries, sequence errors, channel deltas | Harness syntax/argument check; live matrix not run |
| Search evaluation | 10 documents/6 queries; hybrid-only nDCG/MRR/Recall@5 | 10 documents/11 categorized queries; lexical baseline/current; Recall@1/5/20, nDCG@5/10, MRR, coverage, no-result, p50/p95 | Committed 2026-09-06 report; 7 regression tests |
| Provider quality | Signed outcomes/aggregates and one policy ceiling | Explicit `sell`, `sell-and-warn`, `hold` over `warnMax`/`holdMax` with outage-preserving behavior | 16 focused provider tests within 43-test SDK suite |
| Metrics | Structured logs and `/stats`; docs claimed unimplemented endpoints | Tested Prometheus text endpoints for facilitator and Bazaar required metrics | Metrics endpoint tests; documented semantics |
| Federation | Signed deltas; two-node relay | Local three-node A/B/C signed upsert/revoke/restore convergence and unauthorized signer rejection | Live in-process libp2p test plus deterministic conflict tests |
| MCP | Discovery/payment, SSRF, spend ceiling; seller text interpolated into prose | Seller metadata and paid bodies isolated as structured `untrusted_seller_data` | 17 MCP tests including malicious seller text |
| SDK | Packed external real payment previously proven | Fresh 43-file dry-run and external public import; registry still 404 | `npm pack --dry-run`; temporary consumer import; npm lookup |
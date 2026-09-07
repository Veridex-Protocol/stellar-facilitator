# Architecture v3 Gap Audit

Date: 2026-09-06; reconciled 2026-09-07. Target: `docs/architecture.md` version 3.1. Baseline:
`3098ba4` plus the dated evidence worktree. `PROVEN` means live
testnet evidence exists; `IMPLEMENTED NOT PROVEN` means executable behavior and
local tests exist but no post-change live proof.

| Architecture promise | Current implementation | Current evidence | Gap | Action |
|---|---|---|---|---|
| Payment plane is independent from discovery | Settlement enqueues transaction-keyed catalog work, returns queued status, and delivers asynchronously | Fresh `36/36`; unavailable-Bazaar retention/replay regression | HA/shared outbox is not implemented | **IMPLEMENTED + PROVEN/TESTED** on one host; preserve the plane boundary |
| Discovery plane is advisory | Bazaar metadata never authorizes settlement; payment terms are signed and live terms are revalidated | Fresh payment evidence; anti-hijack/live-term tests | Periodic revalidation lacks a captured live drill | **PROVEN** for payment authority; revalidation is `IMPLEMENTED NOT LIVE-PROVEN` |
| Durable post-settlement outbox | Atomic file spool in a named volume, idempotent transaction IDs, asynchronous replay, pending/age metrics | Unavailable-Bazaar retention/restart/replay test; live queue drained to zero | Single-host spool is not HA | **IMPLEMENTED + TESTED**; multi-instance queue remains deployment work |
| PostgreSQL is Bazaar source of truth | Catalog, telemetry, observations, aggregates, delta state, revalidation, and source disagreement use six migrations | Fresh empty volume applied all six migrations before `36/36`; migration tests | Timed live periodic revalidation remains unexercised | **PROVEN** migration/bootstrap; revalidation remains `IMPLEMENTED NOT LIVE-PROVEN` |
| pgvector catalog retrieval | `vector(384)` and cosine leg exist | Build/tests and prior catalog run | Current feature hash is lexical, not semantic | **PROVEN** as pgvector-backed lexical feature retrieval; do not call semantic |
| Hard filters, lexical, vector, RRF, bounded quality | Filters are pushed into retrieval CTEs; lexical/feature-hash RRF and bounded telemetry modulation | 10-document/50-query reviewed report and regression tests | No PostgreSQL production-latency or diverse-activity benchmark | **IMPLEMENTED + TESTED** as a small lexical regression set; do not call semantic |
| Versioned asynchronous embedding worker | Embeddings are generated synchronously during ingestion; HTTP provider falls back to local feature hashing | Embedding fallback tests and backlog gauge | No job table, version, independent worker, retry, or lexical-first publication | **TARGET ONLY**: separate embedding from admission after durable outbox work |
| Channel accounts provide throughput | Static signers are leased exclusively; uncertain results quarantine the exact signer until authenticated recovery | Scheduler tests; `10/25/50/100` load smoke with 32/185 confirmed and zero sequence errors | Real ambiguous-submission and multi-instance persistence drills absent | **IMPLEMENTED + TESTED**; measured saturation is not production throughput |
| Independent RPC failover and reconciliation | Testnet loopback coordinator health-checks, submits once, computes hash, polls providers, rejects final disagreement | Deterministic suite; live loopback drill recorded 7 failovers/5 primary failures and success; metrics exposed | Genuinely independent providers and pubnet are unproven | **IMPLEMENTED + PARTIAL PROOF**; retain testnet-only boundary |
| Signed federation, owner/delegate authority | Full signed catalog deltas, revision/digest ordering, owner/delegate maps, revoke/restore, GossipSub | Local live three-node lifecycle and deterministic tests | No three-process persistence/restart proof; announcement replay cache is memory-only | **PROTOTYPE**: keep label; add process-level restart drill, do not claim multi-operator maturity |
| Telemetry/liveness | Heartbeats, settlement-derived liveness, pruning, search exclusion, stats, and state-change metric exist | Circuit-breaker/tracker/metrics tests; prior restart evidence | Process-level mesh-down/local-search drill remains absent | **IMPLEMENTED + TESTED** locally |
| Provider-quality loop | Signed outcomes, source-aware persistence, cross-source disagreement, Wilson aggregates, seller policy | Bazaar/SDK tests; migration `006`; prior seller flow | No diverse independent-observer corpus | **IMPLEMENTED + TESTED**; public-scale maturity remains open |
| Provider states are conservative | `insufficient_data`, `provisional`, `published`, `n`, faults, Wilson upper bound, window | Aggregate tests | Documentation must keep “upper confidence bound,” not probability | **IMPLEMENTED NOT PROVEN** at public scale |
| Seller policy is local and observatory-independent | `sell`, `sell-and-warn`, `hold` with `warnMax`/`holdMax`; cached/unavailable indexer preserves sale policy | Boundary and outage tests | No live seller mode demonstration | **IMPLEMENTED NOT PROVEN** |
| MCP has no payer signing key | Two-phase challenge/external-signature flow; live challenge is re-fetched and matched before submission | Deterministic tests and keyless testnet settlements at ledgers `4539099`, `4539121` | Broad external-client interoperability remains | **IMPLEMENTED + PROVEN** for the exercised client path |
| MCP treats seller content as data | Discovery descriptions and paid bodies are nested under `untrusted_seller_data` | Malicious-text test | Prompt injection remains possible in consuming agents | **IMPLEMENTED NOT PROVEN**; document mitigation, never claim solved |
| Smart-account policy validates signed path | Public agent SDK enforces per-transaction and rolling limits; Stellar SDK accepts custom contract signers | Local monorepo consumer `$10/$2/$12` plus cumulative artifact | Harness requires the sibling package; no deployed `__check_auth`, oracle-backed stablecoin, or signed-path proof | **PARTIAL**: off-chain policy proven locally; on-chain enforcement remains target-only |
| Exact remains canonical and distinct | Official `@x402/stellar` exact handler; scheme routing is explicit | Fresh stock-client `36/36` conformance | None for testnet exact path | **PROVEN** on testnet |
| `upto` enforces `actual <= max` and remains distinct | Custom contract/scheme routes explicitly; active contract binds terms and replay state | 27 active Rust tests and prior direct/HTTP testnet transactions | Architecture sections still describe an obsolete prototype/target shape | **PROVEN** on testnet, experimental and unaudited; update architecture after validation |
| Stable outward errors are shared | Canonical 19-code registry with facilitator/Bazaar/MCP/SDK snapshots and adapters | Drift gate and package tests | External consumer adoption remains | **IMPLEMENTED + TESTED** without changing canonical x402 reason fields |
| Prometheus observability | Facilitator/Bazaar expose RPC failover/latency, P2P invalid, liveness, channel, outbox, payment, search, and provider signals | Endpoint tests and docs | External retention/alerts and unavailable upstream fee amount remain | **IMPLEMENTED + TESTED** for observable repository signals |
| Failure-domain policy is proven | Outbox replay, RPC scenarios, channel quarantine, and isolated P2P behavior are automated | Focused tests plus fresh six-migration conformance/load/loopback drills | Embedding/P2P process, timed revalidation, and real ambiguity drills remain | **PARTIAL PROOF** with explicit open drills |
| Public reviewer proof | Playground exposes payment, Bazaar search/provenance, local policy, wire, receipts, attacks, and evidence | Next `16.3.4` build/smoke and responsive browser checks | No `upto`/keyless MCP execution UI or deployed smart-account proof | **IMPLEMENTED + PARTIAL**; keep policy panel claim local |
| Permissive dependency path | Direct runtime dependencies are permissive; errors/license gates run in CI; Playground audits clean | Lockfile/license report and production audits | 14 optional `sharp`/`libvips` LGPL artifacts require legal review | **IMPLEMENTED + REVIEW REQUIRED** for Playground distribution |

## Invariant Check

| Invariant | Status |
|---|---|
| Payment never depends on discovery, embeddings, or P2P | Preserved; durable asynchronous catalog replay is implemented |
| Facilitator never holds buyer funds | Preserved by exact and active `upto` design/evidence |
| Discovery cannot change signed `payTo` | Preserved and live-term hardened |
| `actual <= max` | Preserved by contract and facilitator tests |
| Exact/upto never silently interchange | Preserved by explicit scheme routing/tests |
| Retry does not blindly double-settle | Preserved by hash-aware retry guard and RPC coordinator |
| Every Veridex adapter rejection has stable registry metadata | Implemented and drift-checked; canonical upstream x402 fields remain unchanged |
| Amounts remain integer atomic units | Preserved on payment paths |

## Priority From This Audit

1. Exercise a timed live stale-row revalidation through refresh and quarantine.
2. Run genuinely independent RPC operators plus a real ambiguous-submission quarantine/recovery drill.
3. Build and audit the deployed smart-account/stablecoin signed policy path.
4. Run a diverse, representative activity corpus without manufacturing volume or extrapolating production throughput.
5. Prove multi-process federation restart/persistence and define HA outbox/quarantine state ownership.
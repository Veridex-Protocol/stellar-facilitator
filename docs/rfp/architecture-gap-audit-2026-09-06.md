# Architecture v3 Gap Audit

Date: 2026-09-06. Target: `docs/architecture.md` version 3.0-draft. Baseline:
commit `c2cf80d` plus the dependency/evidence worktree. `PROVEN` means live
testnet evidence exists; `IMPLEMENTED NOT PROVEN` means executable behavior and
local tests exist but no post-change live proof.

| Architecture promise | Current implementation | Current evidence | Gap | Action |
|---|---|---|---|---|
| Payment plane is independent from discovery | Settlement succeeds before a bounded best-effort Bazaar handoff | Prior testnet payments; hung-Bazaar HTTP regression | No durable replay of failed catalog work | **PARTIAL**: preserve isolation; add a durable asynchronous outbox rather than extending the response wait |
| Discovery plane is advisory | Bazaar metadata never authorizes settlement; payment terms are signed and revalidated | Exact/upto verifier tests; catalog anti-hijack and live-term tests | None in payment authority | **PROVEN** for prior payment path; post-hardening catalog gate is `IMPLEMENTED NOT PROVEN` |
| Durable post-settlement outbox | Facilitator directly POSTs to Bazaar after settlement with a timeout | Timeout/isolation tests only | No durable queue, replay, job status, or outbox age | **TARGET ONLY**: implement durable append/replay before claiming database-outage retention |
| PostgreSQL is Bazaar source of truth | Catalog, telemetry, observations, aggregates, delta state, and revalidation state use PostgreSQL migrations | Prior clean Docker persistence; migration tests | Migration `005` not clean-room exercised | **PROVEN** baseline, latest migration `IMPLEMENTED NOT PROVEN` |
| pgvector catalog retrieval | `vector(384)` and cosine leg exist | Build/tests and prior catalog run | Current feature hash is lexical, not semantic | **PROVEN** as pgvector-backed lexical feature retrieval; do not call semantic |
| Hard filters, lexical, vector, RRF, bounded quality | Filters are pushed into retrieval CTEs; lexical/feature-hash RRF and bounded telemetry modulation | 10-document/11-query report and regression tests | Golden set is below required 50; no production DB latency benchmark | **PARTIAL**: expand to at least 50 honest queries and measure real engine separately |
| Versioned asynchronous embedding worker | Embeddings are generated synchronously during ingestion; HTTP provider falls back to local feature hashing | Embedding fallback tests and backlog gauge | No job table, version, independent worker, retry, or lexical-first publication | **TARGET ONLY**: separate embedding from admission after durable outbox work |
| Channel accounts provide throughput | Static durable signers are leased exclusively by scheduler; legacy pool has cooldown/resync | Scheduler/unit tests; prior small testnet probe | 10/25/50/100 not run; uncertain signer cannot be identified/quarantined | **PARTIAL**: run matrix; expose leased signer/outcome before implementing quarantine |
| Independent RPC failover and reconciliation | Testnet loopback JSON-RPC coordinator health-checks, submits once, computes hash, polls providers, rejects final disagreement | Six deterministic tests through actual Stellar SDK client | No live independent-provider drill; no failover/latency metric yet; pubnet intentionally disabled | **IMPLEMENTED NOT PROVEN**: add metrics and live testnet drill |
| Signed federation, owner/delegate authority | Full signed catalog deltas, revision/digest ordering, owner/delegate maps, revoke/restore, GossipSub | Local live three-node lifecycle and deterministic tests | No three-process persistence/restart proof; announcement replay cache is memory-only | **PROTOTYPE**: keep label; add process-level restart drill, do not claim multi-operator maturity |
| Telemetry/liveness | Heartbeats, settlement-derived liveness, pruning, search exclusion, and stats exist | Circuit-breaker/tracker tests; prior restart evidence | Liveness-change metric absent; direct-probe policy is limited | **PARTIAL**: instrument state transitions and run mesh-down/local-search drill |
| Provider-quality loop | Signed in-band outcomes, observation persistence, signed Wilson aggregates, seller policy | Bazaar and SDK tests; prior seller flow | In-band vs independent source is not modeled; disagreement is SDK memory only | **PARTIAL**: persist observation source and cross-source disagreement asynchronously |
| Provider states are conservative | `insufficient_data`, `provisional`, `published`, `n`, faults, Wilson upper bound, window | Aggregate tests | Documentation must keep “upper confidence bound,” not probability | **IMPLEMENTED NOT PROVEN** at public scale |
| Seller policy is local and observatory-independent | `sell`, `sell-and-warn`, `hold` with `warnMax`/`holdMax`; cached/unavailable indexer preserves sale policy | Boundary and outage tests | No live seller mode demonstration | **IMPLEMENTED NOT PROVEN** |
| MCP has no payer signing key | MCP currently reads `STELLAR_CLIENT_SECRET_KEY` and signs exact payments in-process | Tests prove local key path and SSRF, not signer isolation | Direct contradiction with architecture and requested invariant | **PARTIAL / MUST FIX**: return challenge as data and accept only externally signed payloads; remove secret-key config |
| MCP treats seller content as data | Discovery descriptions and paid bodies are nested under `untrusted_seller_data` | Malicious-text test | Prompt injection remains possible in consuming agents | **IMPLEMENTED NOT PROVEN**; document mitigation, never claim solved |
| Smart-account policy validates signed path | TypeScript SDK supports custom contract signer hooks | Type tests only | No budget policy, `$10/$2/$12` fixture, public proof, or live authorization | **TARGET ONLY**: build deterministic policy first, then approval-gated testnet proof |
| Exact remains canonical and distinct | Official `@x402/stellar` exact handler; scheme routing is explicit | Prior stock-client testnet conformance and local tests | Fresh post-hardening run pending | **PROVEN** baseline |
| `upto` enforces `actual <= max` and remains distinct | Custom contract/scheme routes explicitly; active contract binds terms and replay state | 27 active Rust tests and prior direct/HTTP testnet transactions | Architecture sections still describe an obsolete prototype/target shape | **PROVEN** on testnet, experimental and unaudited; update architecture after validation |
| Stable outward errors are shared | Facilitator has exhaustive reasons; MCP has one structured wrapper; Bazaar/SDK/upto shapes differ | Local reason tests | No shared registry; generic/heterogeneous errors remain | **PARTIAL**: implement canonical package-local registry and adapters without breaking x402 fields |
| Prometheus observability | Facilitator/Bazaar expose text metrics for most requested signals | Endpoint tests and docs | RPC failover/latency, P2P invalid, and liveness-change metrics absent; fee amount unavailable upstream | **PARTIAL**: add directly observable metrics; leave unavailable fee value explicit |
| Failure-domain policy is proven | Bazaar timeout isolation and RPC scenarios have local tests; isolated P2P mode exists | Focused tests | No durable outbox, embedding/P2P process drills, channel quarantine, or fresh clean run | **PARTIAL**: automate drills and classify results |
| Public reviewer proof | Exact Playground displays wire, receipt, refusals, and ledger link | Prior real exact smoke proof | No Bazaar search, upto, MCP, or smart-policy panels | **PARTIAL**: add Bazaar search and proof fields first; smart policy after signer isolation |
| Permissive dependency path | Direct runtime dependencies are permissive; MCP audit fixed | Lockfile/license report | Playground optional `sharp`/`libvips` LGPL artifacts require legal review; no CI license gate | **PARTIAL**: add allow/deny lockfile check and separate Playground legal decision |

## Invariant Check

| Invariant | Status |
|---|---|
| Payment never depends on discovery, embeddings, or P2P | Preserved for settlement result; durable catalog replay missing |
| Facilitator never holds buyer funds | Preserved by exact and active `upto` design/evidence |
| Discovery cannot change signed `payTo` | Preserved and live-term hardened |
| `actual <= max` | Preserved by contract and facilitator tests |
| Exact/upto never silently interchange | Preserved by explicit scheme routing/tests |
| Retry does not blindly double-settle | Preserved by hash-aware retry guard and RPC coordinator |
| Every rejection has stable code and reason | Not yet true across all services |
| Amounts remain integer atomic units | Preserved on payment paths |

## Priority From This Audit

1. Remove payer-key custody from MCP and prove external signing boundaries.
2. Implement a durable asynchronous catalog outbox and database-down replay test.
3. Add missing RPC failover/latency and liveness/P2P-invalid metrics.
4. Expand the search benchmark to at least 50 reviewed queries.
5. Implement shared errors and smart-account budget policy, then extend the proof UI.
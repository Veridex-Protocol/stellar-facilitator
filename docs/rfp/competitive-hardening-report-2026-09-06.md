# Competitive Hardening Report

## Executive Verdict

Veridex remains **GREEN**. The previously proven testnet exact, custom HTTP
`upto`, Bazaar, MCP, restart, and packed-SDK paths are materially stronger:
catalog publication now checks live 402 terms and periodically quarantines
stale listings; durable outbox replay keeps discovery outside settlement;
testnet RPC coordination preserves transaction hashes without blind
resubmission; ambiguous outcomes quarantine the exact signer; MCP is keyless;
and stable errors, provider-source disagreement, metrics, search evaluation,
and license gates are implemented and tested. Fresh conformance is `36/36`, and
the `10/25/50/100` load smoke is recorded. It is not GREEN+ because migrations
`005/006` lack a captured destructive clean-stack run, the activity corpus is
not diverse, independent RPC/federation operations remain unproven, and the
smart-account/stablecoin policy path is not deployed or audited.

## What Was Added

- Live catalog 402 validation plus periodic refresh/quarantine, kept outside settlement.
- Durable transaction-keyed catalog outbox with asynchronous restart replay.
- Bounded multi-provider testnet RPC failover and hash reconciliation.
- Exact-signer quarantine and authenticated explicit recovery.
- Prometheus text endpoints for facilitator and Bazaar.
- Search baseline/current benchmark over 50 reviewed queries.
- Explicit `sell`, `sell-and-warn`, `hold` provider policy thresholds.
- Persisted in-band/independent provider sources and cross-source disagreement.
- Keyless two-phase MCP plus structured `untrusted_seller_data` boundaries.
- Canonical 19-code cross-service error registry and CI drift check.
- Local live three-node signed federation lifecycle test.
- Executed `10/25/50/100` testnet load smoke.
- Off-chain public SDK `$10/$2/$12` and cumulative-budget proof.
- Security, dependency-license, reuse/original, and before/after evidence.

## What Was Already Present

Canonical upstream exact settlement, custom testnet `upto`, payment/discovery
plane separation, settlement provenance, owner/delegate signatures, channel
signer leasing, hybrid RRF search, provider observations/aggregates, receipts,
MCP payment/discovery, public exact Playground, Docker bootstrap, 36/36
conformance, and external packed-SDK payment proof.

## RFP Scorecard

| Area | Score / 10 | Evidence | Remaining gap |
|---|---:|---|---|
| Facilitator | 9.0 | Canonical endpoints; fresh `36/36`; outbox/quarantine | External audit and multi-instance operations |
| Exact | 9.0 | Official `@x402/stellar`; prior ledger proof | Independent audit |
| Upto | 8.0 | 27 contract tests; prior partial/zero/HTTP proof | Experimental, unaudited, no upstream stock support |
| Bazaar | 9.0 | Settlement + live-term gates; periodic quarantine; source disagreement | Clean-stack migrations `005/006` and revalidation drill |
| Search | 8.0 | 10 docs, 50 reviewed queries, baseline/current report | Small regression corpus; no learned semantic retrieval |
| MCP | 8.5 | Keyless testnet smoke; SSRF/data boundary tests | Broad external-client proof; prompt injection remains risk |
| Buyer DX | 8.5 | Public facade, guides, prior payment | npm publication |
| Seller DX | 8.5 | Official exact middleware; custom `upto` demo | Upstream `upto` convergence |
| SDK | 8.5 | 43 tests; clean tarball/public import | Registry returns 404 |
| Conformance | 9.0 | Fresh 2026-09-06 ledger run `36/36` | Destructive migration bootstrap evidence |
| Security | 8.0 | Attack matrix, keyless MCP, quarantine, stable errors | External audit, DNS rebinding, real ambiguity drill |
| Operations | 8.0 | Compose, readiness, outbox, metrics, load/failure drills | TLS/backup/alerts and multi-instance state |
| Federation | 7.0 | Local live A/B/C signed lifecycle | Multi-process restart/persistence and multi-operator proof |
| Provider Quality | 8.0 | Signed outcomes, source/disagreement persistence, three-mode policy | Diverse independent-observer and live-scale evidence |

## Testnet Evidence

Latest conformance ledger run: 2026-09-06.

| Evidence | Value |
|---|---|
| Buyers | 1 recorded clean-run buyer |
| Sellers | 1 recorded clean-run seller |
| Resources | 2 persisted/discoverable after restart: exact and `upto` |
| Exact count | At least 2 successful exact settlements in the conformance flow; no activity-volume claim |
| Upto count | 3 successful recorded settlements: direct partial, direct zero, custom HTTP partial |
| MCP count | 1 recorded attached-session payment |
| Discovery count | 1 recorded discovery-originated repeat payment after restart |
| Exact transaction | `4b36d1f406fb1560c9e61873c911fd71a26f9408f2ffbaf24239259f65cdee08`, ledger `4539054` |
| Upto partial | `b4b474d151de351b84e9af1a6c39e8145d33481ff3f741300f2dec631c1a3142`, ledger `4539058` |
| Upto zero | `638b71e6dddd4dd0e214355b998ffda28e79c042f091655aa2b03d3dc421e2bf`, ledger `4539060` |
| HTTP upto | `dfd596e8f790f6df3587e66b72fe22d4f4dc5d773922b58318a221348af19169`, ledger `4518157` |
| Keyless MCP | Successful paid calls at ledgers `4539099` and `4539121` |
| External SDK | Successful packed-consumer payment at ledger `4539556` |

## Concurrency Evidence

The reproducible command is `npm run probe:matrix`. Payload preparation is
sequential; only settlement is timed concurrently. The four runs produced:

| Concurrency | Confirmed | Success | p50 | p95 |
|---:|---:|---:|---:|---:|
| 10 | 9 | 90% | 22.869s | 33.031s |
| 25 | 9 | 36% | 30.079s | 32.448s |
| 50 | 8 | 16% | 29.632s | 34.293s |
| 100 | 6 | 6% | 30.246s | 30.280s |

Across 185 requests, 32 were ledger-confirmed, 90 were rejected at scheduler
capacity, and 63 failed simulation. There were zero retries and zero sequence
errors. This demonstrates saturation of a three-signer testnet pool; it is not
a production throughput or representative-activity claim.

## Search Evidence

- Dataset: 10 documents, 50 reviewed queries across exact, paraphrase, zero-overlap,
  ambiguous, no-result, MCP, and filtered categories.
- Labels: hand-authored graded relevance 0-3; no-result queries use empty qrels.
- Lexical baseline: nDCG@10 `0.8589`, MRR `0.8766`, Recall@5/20 `0.8546`, coverage `0.8936`.
- Current feature-hash/RRF: nDCG@10 `0.8633`, MRR `0.8794`, Recall@5/20 `0.8546`, coverage `0.8936`.
- Current no-result accuracy: `1.0`; in-memory latency p50 `0.637ms`, p95 `1.696ms`.
- Zero lexical overlap remains a miss. Semantic search is not claimed.

## Reliability Evidence

| Drill | Result |
|---|---|
| RPC failover | Deterministic scenarios pass; loopback live testnet drill recorded 7 failovers/5 primary failures and payment success; independent operators pending |
| Database/Bazaar outage | Durable outbox test retains work across unavailable Bazaar/restart and replays it; settlement remains independent |
| Embedding outage | Fallback provider is implemented/tested; full process outage drill pending |
| Mesh outage | Isolated-node mode exists; full process outage drill pending |
| Channel uncertainty | Hash and exact leased signer are preserved; signer is quarantined until authenticated explicit recovery; live ambiguity drill pending |
| Restart | Prior clean run preserved catalog/provider state; outbox restart replay tested; migrations `005/006` lack destructive clean-stack evidence |

## Security Matrix

Payment/payee/asset/amount/network binding, replay, catalog spoofing, route
traversal, SSRF, federation signatures/order, sequence exclusion, and RPC
disagreement have focused controls and tests. MCP seller text is explicitly
data, not instruction, but prompt injection is not solved. DNS rebinding,
channel uncertainty, Sybil ranking, custom smart-account policy, and all
contract/payment controls still require independent audit.

## Package Evidence

- Tarball: yes; 43 entries, 36.8 KB packed, runtime JS/declarations/maps plus README/LICENSE/package metadata.
- npm published: no; registry returned `404` on 2026-09-06.
- External project: yes; public `createVeridexClient`, `BazaarClient`, and `SellerPolicyEngine` imports resolved.
- Real testnet payment from packed package: proven in the prior acceptance run, not repeated here.

## Federation Evidence

Two-node relay remains covered. Three local independent libp2p nodes passed
A-to-B, B-to-C, and A-to-C connectivity with signed upsert, revoke, restore,
deterministic revision convergence, and unauthorized signer rejection. Replay
and conflicts are deterministic tests. Multi-process restart persistence and
multi-operator deployment remain unproven.

## Failures Found

| Failure | Severity | Classification | Fixed? |
|---|---|---|---|
| Catalog trusted submitted terms without live 402 agreement | High | Code gap | Yes |
| Stale listings had no payment-term refresh/quarantine | High | Code gap | Yes |
| Single RPC endpoint/no ambiguous hash reconciliation | High | Reliability gap | Yes, local testnet mode |
| Feature-hash collision could create arbitrary no-result rows | Medium | Search correctness | Yes |
| Seller text was interpolated into MCP prose | Medium | Prompt-injection hardening | Yes, bounded as data |
| MCP x402 caret drifted to 2.22.0 | Medium | Reproducibility | Yes, pinned 2.21.0 |
| MCP `fast-uri`/`qs` advisories | High/Medium | Dependency vulnerability | Yes, lockfile; audit clean |
| Playground transitive `sharp`/`libvips` LGPL artifacts | Medium | License review | No; legal review required |
| Legacy `contracts/upto_escrow` fails current Rust compile | Low | Deprecated prototype/toolchain | No; active `upto-settlement` passes 27 tests |
| Shared machine-readable error registry absent | Medium | Contract consistency | Yes, 19-code registry and drift gate |
| Smart-account `$10/$2/$12` testnet demo absent | Medium | Evidence gap | Partly: off-chain SDK policy proven; deployed signed path absent |
| Uncertain channel cannot be tied to quarantine | High | Reliability gap | Yes locally; real ambiguous-submission drill pending |

## Validation

- Typecheck: pass across all configured packages.
- Build: pass with Playground on Next `16.3.4` and explicit webpack.
- JavaScript: 288 tests pass (`135 + 89 + 19 + 45`).
- Rust: active `upto-settlement` 27 pass; legacy `upto_escrow` compile fails.
- Go: tests and vet pass; no external modules.
- Python: 9 tests pass on Python 3.14.6 venv.
- Search evaluation: pass and committed report.
- Compose: primary and host-DB configurations pass.
- Bash syntax: pass.
- MCP production audit: zero vulnerabilities after lock update.
- Testnet conformance: fresh `36/36` run passed; destructive migration bootstrap was not repeated.
- Playground and MCP production audits: zero vulnerabilities.
- Error registry, license policy, and policy budget proof: pass.

## Safe Claims

**Proven on testnet:** fresh exact/direct `upto`, prior custom HTTP `upto`, Bazaar
cataloging, keyless MCP payment/discovery, receipts, loopback RPC failover, load
smoke, and packed-SDK payment.

**Locally implemented/tested:** live catalog revalidation, durable outbox,
signer quarantine/recovery, Prometheus metrics, provider source/disagreement,
three-node transport, canonical errors, and an off-chain budget policy proof
against the locally available sibling `@veridex/agentic-payments` package.

**Experimental/unaudited:** `upto`, provider-quality service maturity,
federation beyond local proof, multi-provider RPC deployment.

**Unpublished:** `@veridex/stellar`; publishable tarball only.

**Approval-gated:** pubnet/mainnet, public fee-sponsoring Playground, production claims.

## Top 5 Next Actions

1. Capture a destructive empty-volume bootstrap applying migrations `005/006`, then rerun `36/36`.
2. Exercise two genuinely independent testnet RPC operators and a real ambiguous submission while observing signer quarantine/recovery.
3. Build and audit the deployed smart-account/stablecoin `$10/$2/$12` signed path; keep the off-chain proof separately labeled.
4. Run a representative 50-100-payment activity corpus without manufacturing diversity or extrapolating production throughput.
5. Run multi-process federation restart/persistence with independent operators and durable replay state.
# Competitive Hardening Report

## Executive Verdict

Veridex remains **GREEN**. The previously proven testnet exact, custom HTTP
`upto`, Bazaar, MCP, restart, and packed-SDK paths are materially stronger:
catalog publication now checks live 402 terms and periodically quarantines
stale listings; testnet RPC coordination preserves transaction hashes without
blind resubmission; Prometheus metrics, explicit provider policy thresholds,
three-node local federation, reproducible search evaluation, and MCP untrusted
data boundaries are implemented and tested. It is not GREEN+ because these
post-baseline changes have not had a fresh clean-room ledger run, the 10/25/50/100
testnet matrix and representative activity harness were not executed, the
smart-account budget demo and shared error registry remain open, and uncertain
channel-to-signer quarantine is incomplete.

## What Was Added

- Live catalog 402 validation plus periodic refresh/quarantine, kept outside settlement.
- Bounded multi-provider testnet RPC failover and hash reconciliation.
- Prometheus text endpoints for facilitator and Bazaar.
- Search baseline/current benchmark with full requested IR and latency metrics.
- Explicit `sell`, `sell-and-warn`, `hold` provider policy thresholds.
- Structured MCP `untrusted_seller_data` boundaries.
- Local live three-node signed federation lifecycle test.
- 10/25/50/100 concurrency matrix harness and richer probe reporting.
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
| Facilitator | 9.0 | Canonical endpoints; 129 tests | Fresh post-hardening testnet run |
| Exact | 9.0 | Official `@x402/stellar`; prior ledger proof | Independent audit |
| Upto | 8.0 | 27 contract tests; prior partial/zero/HTTP proof | Experimental, unaudited, no upstream stock support |
| Bazaar | 9.0 | Settlement + live-term gates; periodic quarantine | Fresh migration/revalidation deployment proof |
| Search | 8.0 | 10 docs, 11 queries, baseline/current report | Small corpus; no learned semantic retrieval |
| MCP | 8.5 | 17 tests; SSRF/spend/data boundary | External multi-client proof; prompt injection remains risk |
| Buyer DX | 8.5 | Public facade, guides, prior payment | npm publication |
| Seller DX | 8.5 | Official exact middleware; custom `upto` demo | Upstream `upto` convergence |
| SDK | 8.5 | 43 tests; clean tarball/public import | Registry returns 404 |
| Conformance | 9.0 | Latest ledger run 36/36 | Rerun after hardening |
| Security | 7.5 | Attack/control matrix and focused tests | External audit, DNS rebinding, channel uncertainty |
| Operations | 8.0 | Compose, readiness, metrics, RPC health | Failure drill artifact, TLS/backup/alerts |
| Federation | 7.0 | Local live A/B/C signed lifecycle | Multi-process restart/persistence and multi-operator proof |
| Provider Quality | 8.0 | Signed outcomes, Wilson aggregate, three-mode policy | Independent mismatch persistence and live scale evidence |

## Testnet Evidence

Latest actual ledger run: 2026-09-05, not rerun after hardening.

| Evidence | Value |
|---|---|
| Buyers | 1 recorded clean-run buyer |
| Sellers | 1 recorded clean-run seller |
| Resources | 2 persisted/discoverable after restart: exact and `upto` |
| Exact count | At least 2 successful exact settlements in the conformance flow; no activity-volume claim |
| Upto count | 3 successful recorded settlements: direct partial, direct zero, custom HTTP partial |
| MCP count | 1 recorded attached-session payment |
| Discovery count | 1 recorded discovery-originated repeat payment after restart |
| Exact transaction | `fd0eee4826e3cfedc3196c98fb73a6f8e34a5e245c4756136552c15fe217eb26`, ledger `4518124` |
| Upto partial | `ce73e6f7127f4e5740b51382cce92683dc8fbe14c2c93adb17e962ddb0977f56`, ledger `4518129` |
| Upto zero | `eb6e600e1aab6022775f5a434509daae4362849cf3b505567542922bf7a97006`, ledger `4518131` |
| HTTP upto | `dfd596e8f790f6df3587e66b72fe22d4f4dc5d773922b58318a221348af19169`, ledger `4518157` |

## Concurrency Evidence

The reproducible command is `npm run probe:matrix`. It executes
`10,25,50,100` sequentially and reports success rate, throughput, p50, p95,
RPC failures, sequence errors, retries, source accounts, scheduler, and channel
state. It was syntax/argument validated but not run against testnet here, so
success rate, p50, p95, and sequence-error counts are **not measured**. No
production throughput claim is made.

## Search Evidence

- Dataset: 10 documents, 11 queries across exact, paraphrase, zero-overlap,
  ambiguous, no-result, MCP, and filtered categories.
- Labels: hand-authored graded relevance 0-3; no-result queries use empty qrels.
- Lexical baseline: nDCG@10 `0.8578`, MRR `0.9000`, Recall@5/20 `0.8667`, coverage `0.9`.
- Current feature-hash/RRF: nDCG@10 `0.8771`, MRR `0.9000`, Recall@5/20 `0.8667`, coverage `0.9`.
- Current no-result accuracy: `1.0`; in-memory latency p50 `0.922ms`, p95 `10.688ms`.
- Zero lexical overlap remains a miss. Semantic search is not claimed.

## Reliability Evidence

| Drill | Result |
|---|---|
| RPC failover | Local tests pass for primary, pre-submit failover, ambiguous timeout, unresolved hash, and disagreement; live independent-provider drill pending |
| Database/Bazaar outage | HTTP-level test proves a completed settlement returns success within bounded handoff timeout |
| Embedding outage | Fallback provider is implemented/tested; full process outage drill pending |
| Mesh outage | Isolated-node mode exists; full process outage drill pending |
| Channel uncertainty | Hash is preserved; leased signer quarantine is not implemented |
| Restart | Prior clean run preserved catalog/provider state; not rerun after migration `005` |

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
| Shared machine-readable error registry absent | Medium | Contract consistency | No |
| Smart-account `$10/$2/$12` testnet demo absent | Medium | Evidence gap | No |
| Uncertain channel cannot be tied to quarantine | High | Reliability gap | No |

## Validation

- Typecheck: pass across all configured packages.
- Build: pass; Playground emits existing native-addon bundling warnings.
- JavaScript: 272 tests pass (`129 + 83 + 17 + 43`).
- Rust: active `upto-settlement` 27 pass; legacy `upto_escrow` compile fails.
- Go: tests and vet pass; no external modules.
- Python: 9 tests pass on Python 3.14.6 venv.
- Search evaluation: pass and committed report.
- Compose: primary and host-DB configurations pass.
- Bash syntax: pass.
- MCP production audit: zero vulnerabilities after lock update.
- Clean-room/testnet conformance: not rerun after hardening.

## Safe Claims

**Proven on testnet:** prior exact, custom HTTP/direct `upto`, Bazaar cataloging,
MCP payment/discovery, restart persistence, receipts, and packed-SDK payment.

**Locally implemented/tested:** live catalog revalidation, Prometheus metrics,
three-mode provider policy, MCP untrusted-data boundaries, three-node transport,
RPC failover/reconciliation, expanded search benchmark, concurrency harness.

**Experimental/unaudited:** `upto`, provider-quality service maturity,
federation beyond local proof, multi-provider RPC deployment.

**Unpublished:** `@veridex/stellar`; publishable tarball only.

**Approval-gated:** pubnet/mainnet, public fee-sponsoring Playground, production claims.

## Top 5 Next Actions

1. Run a fresh destructive clean-room bootstrap and 36/36 conformance with migration `005` and two independent testnet RPC providers.
2. Run and commit the `10,25,50,100` testnet matrix; implement signer quarantine before claiming uncertain-channel recovery.
3. Implement the canonical cross-service `{code, reason, retryable, category, details}` registry.
4. Build the real signed smart-account `$10` budget demo and expose it in the reviewer Playground.
5. Run the representative 50-100-payment activity harness and multi-process federation restart drill without manufacturing volume.
# Testnet RFP Acceptance Matrix

Status: `GREEN` for the reproducible exact + HTTP `upto` + Bazaar + MCP testnet paths, with the experimental and upstream limitations listed below.

Scope: `stellar:testnet` only. No pubnet or mainnet activity was performed.

| RFP item | Implementation | Test/evidence | Status |
|---|---|---|---|
| Facilitator `/verify` | Canonical x402 v2 HTTP endpoint | Full conformance group 6; fresh real payment | Testnet proven |
| Facilitator `/settle` | Canonical x402 v2 HTTP endpoint | Fresh Horizon-confirmed settlements; receipt checks | Testnet proven |
| Custom `__check_auth` support | Delegated to official Stellar Soroban authorization validation; no custom-account fixture is implemented here | Exact auth-entry tests; no live custom-account fixture | Deferred/upstream-dependent |
| `/supported` and CAIP-2 | Advertises `stellar:testnet`, x402 v2, fee sponsorship | Conformance group 1 and live `/supported` | Testnet proven |
| Exact Stellar payment | Official `@x402/stellar` scheme and stock client | Clean `npm run demo`; 36/36 conformance | Testnet proven |
| Auth entry validation | Official Stellar scheme validation | Deterministic facilitator tests and conformance rejection cases | Implemented/tested |
| Expiry, replay, recipient, amount, asset, network binding | Canonical scheme validation | Conformance rejection matrix; contract tests for replay | Testnet proven for exact; contract-proven for `upto` |
| SEP-41 / 7-decimal amount handling | Asset contract IDs and atomic amounts | Exact clean payment with native XLM SAC and 100000 atomic units | Testnet proven |
| Fee sponsorship | Boot-time Horizon funding check and `areFeesSponsored` | Live `/supported`, facilitator readiness, settlement | Testnet proven |
| Non-custodial boundary | Facilitator signs settlement transaction; payer signs payment | Receipt/payer/settlement evidence | Implemented/tested |
| Caller authentication | Internal catalog bearer token; edge CORS/rate-limit hooks | Unauthorized `/catalog/ingest` returns 401; rate-limit tests | Implemented/tested |
| External caller authentication | No API-key layer is required on the canonical self-hosted endpoints | Edge authentication is deployment-specific and was not exercised in local Compose | Deployment responsibility |
| Self-hosting | Docker Compose and service-local configuration | Clean bootstrap from empty `.env` and volume | Testnet proven |
| Bazaar resources API | `/discovery/resources` with `type`, `payTo`, `network`, `extensions`, `limit`, `offset` | Conformance group 7 | Testnet proven |
| Bazaar search | PostgreSQL `ts_rank_cd` full-text + deterministic lexical feature-hash/RRF + telemetry | Search conformance and live discovery | Testnet proven; not learned semantic search |
| Search evaluation | 10-document, 50-query categorized golden set; lexical baseline versus feature-hash/RRF; Recall@1/5/20, nDCG@5/10, MRR, coverage, no-result, p50/p95 | `npm --prefix bazaar-service run search:eval`; hybrid nDCG@10 `0.8633`, MRR `0.8794`, Recall@5/20 `0.8546`, coverage `0.8936` | Implemented/tested; small in-memory reviewer set, not production semantic quality or a diverse activity corpus |
| Cursor pagination | Opaque query-bound cursor and `partialResults` | Conformance group 7 | Testnet proven |
| Automatic cataloging | Seller Bazaar declaration -> facilitator -> Bazaar ingest | Fresh payment created catalog row and discovery result | Testnet proven |
| Catalog integrity | Settlement proof plus bounded live HTTP 402 term validation for resource/network/scheme/asset/payee/amount | Prior forged/unbacked conformance; 13 live-term and 3 periodic-state tests | Settlement proof testnet-proven; live-term hardening locally tested |
| Periodic catalog revalidation | Stale HTTP rows are re-fetched asynchronously; failures are quarantined/soft-dropped; successful rows update `last_verified_at` | `catalog-revalidation.test.ts`; migration `005` applied in fresh empty-volume run | Implemented/tested; timed live stale-row drill pending |
| Discovery failure isolation | Settlement transaction is queued to a durable file-spool outbox; Bazaar delivery/replay is asynchronous and cannot change settlement success | Unavailable-Bazaar retention/restart/replay regression; live outbox currently drained to zero | Implemented/tested |
| Route-template and traversal validation | Bazaar metadata validation | Bazaar deterministic tests | Implemented/tested |
| `EXTENSION-RESPONSES` | Bazaar result relayed on direct `/settle` and seller middleware response | Fresh `upto`-enabled conformance 36/36 | Testnet proven |
| MCP discovery | Stdio `discover_resources` tool | Attached Docker MCP protocol run | Testnet proven |
| MCP payment | Two-phase `pay_resource`: return bounded challenge, accept externally signed payload, re-fetch and match live challenge, submit | Keyless testnet smoke at ledgers `4539099` and `4539121`; no private key in MCP configuration | Testnet proven; client wallet retains custody |
| MCP SSRF protection | Local/private/metadata targets blocked by default; local opt-in | MCP tests and attached local session with explicit opt-in | Implemented/tested |
| MCP untrusted-content boundary | Seller metadata and paid bodies returned inside structured `untrusted_seller_data` objects | MCP malicious seller-text test | Implemented/tested; prompt injection not claimed solved |
| Exact buyer SDK | `createVeridexClient` public export | Packed tarball external consumer made real payment | Publishable; npm publication pending |
| Seller DX | Official `@x402/hono` + `@x402/stellar` path | Demo seller and seller guide | Testnet proven |
| Existing API gateway DX | Exact-only edge adapter with SSRF/header/body/time/rate controls, settle-before-forward order, Bazaar declaration, payment/provider events, CLI, Compose, and real-flow Playground module | 7 focused tests plus Playground transaction `060730898ee9a579d3a22ebbbbe59a3320f315828bf017b2522eec3cb9900e51` at ledger `4553830`; original API response, signed outcome, durable events, and searchable Bazaar row independently confirmed | Testnet proven; production auth, HA idempotency, and external audit remain open |
| Developer Portal foundation | Versioned gateway snapshot/events/earnings contracts and replaceable event-store interface; existing relayer/project identity boundary preserved | Gateway management auth and contract tests; portal codebase boundary review | Foundation implemented; portal UI, managed auth/CRUD, and multi-tenant datastore not implemented |
| Discovery buyer DX | Search -> select URL -> buyer fetch | Clean-stack discovery-driven payment | Testnet proven |
| `upto` contract | Boot-gated deployed testnet Soroban contract | Partial, zero, replay, unused authorization checks | Testnet proven; unaudited |
| `upto` direct settlement path | Facilitator routes `upto`; direct conformance settlement | Fresh conformance group 8: partial, zero, replay, unused authorization all pass | Testnet proven; experimental |
| HTTP `upto` seller/client wire path | Custom `UptoStellarServerScheme`, response usage override, signed result digest, explicit `@veridex/stellar` `scheme: "upto"` buyer selection, and pre-verification replay check | Latest clean-room 402 -> payer auth -> provider usage -> facilitator auth -> Soroban settlement returned HTTP 200; transaction `dfd596e8f790f6df3587e66b72fe22d4f4dc5d773922b58318a221348af19169` succeeded at ledger `4518157`; replay `/verify` returned `invalid_upto_stellar_authorization_already_settled` | Testnet proven; experimental and unaudited |
| Upstream stock `@x402/stellar` `upto` interoperability | Upstream `@x402/stellar@2.21.0` exposes exact only; Veridex supplies the custom scheme adapter | Package inspection and explicit custom-client test | Deferred upstream convergence |
| Provider outcomes | Signed response digest/payTo/resource-bound outcome extension; source derives from distinct credentials; signed per-call duplicate reports count once while disagreements remain stored | Live observations and deterministic extension/source-escalation/deduplication/disagreement tests; migration `006` | Implemented/tested; independent corpus and mature service remain open |
| Provider policy | Attribution-aware settle/skip policy in extension | Deterministic provider-quality tests | Implemented/tested; not a mature public reputation service |
| Provider policy modes | Explicit `sell`, `sell-and-warn`, `hold` over evidence state and configurable `warnMax`/`holdMax`; indexer outage preserves payment availability | Provider-quality threshold boundary tests | Implemented/tested; broader live mode matrix deferred |
| Federation | Signed GossipSub catalog deltas, replay/order/conflict/revoke/restore and owner/delegate authority | Three-process/three-database proof with restart retention plus deterministic delta tests | Locally process-proven; multi-operator/public deployment pending |
| RPC failover | Ordered testnet providers, health state, bounded read failover, one-provider submission, local-hash reconciliation, disagreement failure | 7 coordinator tests including actual Stellar SDK client, JSON-RPC error failover, ambiguous timeout, and disagreement | Implemented/tested; independent live-provider drill pending; testnet-only |
| Concurrency harness | Real facilitator/channel-pool probe with sequential payload preparation and timed settlement-only `10,25,50,100` levels | 185 testnet requests: 32 confirmed, 90 capacity rejects, 63 simulation failures, zero retries and sequence errors; success `90%/36%/16%/6%` | Executed load smoke; demonstrates three-signer saturation, not production throughput or diverse activity |
| Health/readiness | `/health`, `/ready`, Bazaar DB/P2P readiness | Clean Docker boot and restart checks | Testnet proven |
| Migrations | Automatic Bazaar migration runner; six tracked migrations | Fresh empty database applied `001` through `006` before `36/36` conformance | Testnet proven |
| Receipts | Signed `x402job/1`, RFC8785 claims/digests | Independent conformance verification | Testnet proven |
| Observability | Correlated structured Facilitator/MCP outcomes, `/stats`, Facilitator/Bazaar Prometheus endpoints, and MCP per-tool metrics | Facilitator, Bazaar, and MCP metrics/operation tests | Implemented/tested; external Prometheus retention/alerts not included |
| Cross-service errors | Canonical 19-code registry with package-local snapshots and drift check | Facilitator, Bazaar, MCP, and SDK adapters/tests; CI runs `errors:check` | Implemented/tested; canonical x402 fields preserved |
| Agent budget policy | Public `@veridex/agentic-payments@2.0.7` `PolicyEngine` + `SpendingLimitRule` | Reproducible `$10` cap: `$2` passes, `$12` blocks, and `$9` after `$2` blocks at `$11` cumulative | Off-chain SDK policy proven; no deployed smart-account or oracle-backed stablecoin proof |
| Dependency licenses | Offline direct/transitive inventory and CI gate | Playground Next `16.3.4` / Stellar SDK `16.2.0` audit clean; 14 optional `sharp`/`libvips` LGPL artifacts explicitly excepted | Core permissive path verified; Playground distribution still requires legal review |
| TLS, backups, edge caller auth | Deployment/edge concerns are not part of local Compose | Deployment documentation; no local TLS terminator or restore drill | Deferred to deployment |
| TLS and backups | Deployment guidance exists; no local TLS terminator or restore drill is part of Compose | Documentation only | Deployment responsibility/deferred |
| Security boundary | SSRF, auth, rate limit, body limit, replay and binding controls | Focused tests and live unauthorized probes | Implemented/tested; no external security audit claimed |
| Pubnet/mainnet | Existing network-switch interfaces only | Not executed by design | Approval-gated/deferred |
| CI | Workflow exists, but GitHub Actions failed before runner steps during audit | Local tests green; hosted runs were infrastructure failures | CI infrastructure gap |

## Classification

The latest clean-stack `36/36` artifact was generated at `2026-09-07T01:19:35Z` after fresh Friendbot accounts and an empty PostgreSQL volume applied all six migrations. It includes exact transaction `a7f65fe111515479a3b5a5a96b962022489b0e40d9674345178d6564582a27e2` at ledger `4544070`, direct `upto` partial `3275e082985a903e8a5e0e4be3f2cdba015f03b0f1f20fcc198d5a9c0955183d` at ledger `4544074`, and zero `795b75c950c2f91bff4d61970ba192b220af9e1203108eeaaa6d2cb1bafcac61` at ledger `4544076`. Federation is locally process-proven but not multi-operator proven, periodic revalidation remains package-tested rather than live-drilled, `upto` remains experimental and unaudited, the deployed smart-account proof remains absent, and no pubnet/mainnet or production-readiness claim is made.

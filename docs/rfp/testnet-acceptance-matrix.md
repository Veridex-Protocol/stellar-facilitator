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
| Bazaar search | BM25 + deterministic feature-hash + telemetry ranking | Search conformance and live discovery | Testnet proven; not learned semantic search |
| Search evaluation | Judged benchmark with nDCG, MRR, recall, and precision metrics | `search-eval.test.ts`, 6 tests pass with regression thresholds | Implemented/tested |
| Search evaluation | nDCG, MRR, recall, and precision metrics with regression thresholds | `search-eval.test.ts`, 6 tests pass | Implemented/tested |
| Cursor pagination | Opaque query-bound cursor and `partialResults` | Conformance group 7 | Testnet proven |
| Automatic cataloging | Seller Bazaar declaration -> facilitator -> Bazaar ingest | Fresh payment created catalog row and discovery result | Testnet proven |
| Catalog integrity | Settlement proof checked against Horizon | Forged/unbacked catalog rejection in conformance | Testnet proven |
| Route-template and traversal validation | Bazaar metadata validation | Bazaar deterministic tests | Implemented/tested |
| `EXTENSION-RESPONSES` | Bazaar result relayed on direct `/settle` and seller middleware response | Fresh `upto`-enabled conformance 36/36 | Testnet proven |
| MCP discovery | Stdio `discover_resources` tool | Attached Docker MCP protocol run | Testnet proven |
| MCP payment | Stdio `pay_resource` performs 402/sign/retry | Attached Docker MCP payment and Horizon settlement | Testnet proven |
| MCP SSRF protection | Local/private/metadata targets blocked by default; local opt-in | MCP tests and attached local session with explicit opt-in | Implemented/tested |
| Exact buyer SDK | `createVeridexClient` public export | Packed tarball external consumer made real payment | Publishable; npm publication pending |
| Seller DX | Official `@x402/hono` + `@x402/stellar` path | Demo seller and seller guide | Testnet proven |
| Discovery buyer DX | Search -> select URL -> buyer fetch | Clean-stack discovery-driven payment | Testnet proven |
| `upto` contract | Boot-gated deployed testnet Soroban contract | Partial, zero, replay, unused authorization checks | Testnet proven; unaudited |
| `upto` direct settlement path | Facilitator routes `upto`; direct conformance settlement | Fresh conformance group 8: partial, zero, replay, unused authorization all pass | Testnet proven; experimental |
| HTTP `upto` seller/client wire path | Custom `UptoStellarServerScheme`, response usage override, signed result digest, explicit `@veridex/stellar` `scheme: "upto"` buyer selection, and pre-verification replay check | Latest clean-room 402 -> payer auth -> provider usage -> facilitator auth -> Soroban settlement returned HTTP 200; transaction `dfd596e8f790f6df3587e66b72fe22d4f4dc5d773922b58318a221348af19169` succeeded at ledger `4518157`; replay `/verify` returned `invalid_upto_stellar_authorization_already_settled` | Testnet proven; experimental and unaudited |
| Upstream stock `@x402/stellar` `upto` interoperability | Upstream `@x402/stellar@2.21.0` exposes exact only; Veridex supplies the custom scheme adapter | Package inspection and explicit custom-client test | Deferred upstream convergence |
| Provider outcomes | Signed response digest/payTo/resource-bound outcome extension | Live observations and deterministic extension tests | Implemented/tested; quality service remains early |
| Provider policy | Attribution-aware settle/skip policy in extension | Deterministic provider-quality tests | Implemented/tested; not a mature public reputation service |
| Provider policy modes | Seller policy engine is local and does not synchronously depend on the external indexer | Provider-quality policy tests | Implemented/tested; broader live mode matrix deferred |
| Federation | Signed GossipSub catalog deltas, replay/order/conflict rules | Two-node relay and deterministic delta tests | Prototype; three-node deployment not proven |
| Health/readiness | `/health`, `/ready`, Bazaar DB/P2P readiness | Clean Docker boot and restart checks | Testnet proven |
| Migrations | Automatic Bazaar migration runner | Empty database applied four migrations; restart preserved state | Testnet proven |
| Receipts | Signed `x402job/1`, RFC8785 claims/digests | Independent conformance verification | Testnet proven |
| Observability | Structured request outcomes, transaction IDs, settlement counters | Live logs and `/stats` | Implemented/tested; persistent metrics/alerts not included |
| TLS, backups, edge caller auth | Deployment/edge concerns are not part of local Compose | Deployment documentation; no local TLS terminator or restore drill | Deferred to deployment |
| TLS and backups | Deployment guidance exists; no local TLS terminator or restore drill is part of Compose | Documentation only | Deployment responsibility/deferred |
| Security boundary | SSRF, auth, rate limit, body limit, replay and binding controls | Focused tests and live unauthorized probes | Implemented/tested; no external security audit claimed |
| Pubnet/mainnet | Existing network-switch interfaces only | Not executed by design | Approval-gated/deferred |
| CI | Workflow exists, but GitHub Actions failed before runner steps during audit | Local tests green; hosted runs were infrastructure failures | CI infrastructure gap |

## Classification

The canonical testnet paths are reproducible and suitable for controlled design-partner use. `federation` remains a prototype, `upto` remains experimental and unaudited, upstream stock `upto` interoperability is not claimed, and the TypeScript SDK must be published before public npm onboarding can be advertised.

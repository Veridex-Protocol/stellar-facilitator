# Veridex Threat Model

Status: pre-audit, testnet-only. This document describes implemented controls
and their evidence. It is not an audit report or a production-security claim.

## Scope and security properties

The protected assets are payer funds and authorization, facilitator signer
keys, seller proceeds, catalog integrity, provider-quality evidence, durable
settlement/catalog state, and operator credentials. The required properties
are:

1. Payment terms are bound to the intended network, asset, recipient, and
   amount before submission.
2. Ambiguous RPC outcomes never cause an automatic second submission.
3. Catalog entries are settlement-backed, seller-authorized, live, and
   deterministically convergent.
4. Discovery and provider-quality failures do not alter payment validity.
5. Provider-quality trust derives from authenticated identities, not caller
   labels, and duplicate reports do not inflate policy evidence.
6. Secrets and untrusted seller content do not cross their intended boundary.

## Trust boundaries

| Boundary | Untrusted input | Trusted decision point |
|---|---|---|
| Buyer to resource server | Request, payment headers | x402 resource middleware |
| Resource server to facilitator | Payment payload and requirements | Exact or `upto` verifier/simulator |
| Facilitator to Stellar RPC | JSON-RPC responses and transport outcomes | Ordered RPC coordinator and reconciliation |
| Facilitator to Bazaar | Catalog handoff and provider observation | Authenticated endpoint plus independent validation |
| Seller/peer to catalog | Signed delta, live 402 terms, settlement proof | Catalog ingestion worker |
| Observer to provider-quality store | Signed outcome facts | Separate observer credential and signer allowlist |
| Bazaar peer to Bazaar peer | GossipSub messages | Schema, signature, freshness, authority, revision/digest ordering |
| MCP to seller endpoint | Seller descriptions and paid response bodies | Structured `untrusted_seller_data` envelope |

## Threat-control-evidence matrix

| Threat | Security property | Implemented control | Exact automated evidence | Residual risk |
|---|---|---|---|---|
| Network, asset, recipient, or amount substitution | Only accepted payment terms settle | x402 v2 requirement validation; simulation/event checks; `upto` ceiling | Facilitator validation suites; Rust contract tests; `npm run conformance` | Exact depends on upstream x402 code; `upto` is unaudited |
| Replay or expired authorization | A payment authorization cannot be reused outside its validity | Stellar authorization nonce/ledger bounds; `upto` settled-state guard | Conformance replay vectors; Rust contract tests | Chain/runtime assumptions require external review |
| Concurrent use of one channel signer | One in-flight sequence mutation per signer | Async-local signer lease and per-signer quarantine | `facilitator-service/src/__tests__/settle-scheduler.test.ts` | Lease/quarantine state is process-local; multi-instance partitioning is operational |
| RPC outage before submission | Healthy provider selected without duplicate send | Ordered health/read failover, including retryable JSON-RPC server errors | `rpc-coordinator.test.ts`: primary outage and JSON-RPC failover cases | Provider endpoints may share infrastructure or failure domains |
| Timeout after submission | Never resubmit an ambiguous envelope | One submission; derive local hash; query all providers by hash | `rpc-coordinator.test.ts`: ambiguous hash reconciliation and not-found preservation | Live ambiguous testnet drill is pending |
| RPC final-state disagreement | Do not choose an unsafe result | Conflicting final states fail closed and increment reconciliation metrics | `rpc-coordinator.test.ts`: provider disagreement case | Independent-operator quorum is not demonstrated |
| Catalog spoofing or payment reuse | Every listing is seller-authorized and settlement-backed | Signature/authority checks, Horizon/Soroban proof, live 402 term match, unique settlement constraint | `catalog-delta.test.ts`; settlement/live-term tests | Public endpoint ownership and DNS lifecycle remain operator concerns |
| Temporary resource outage | Do not turn reachability failure into integrity quarantine | Retryable failures retain pending state; terminal mismatches quarantine | `catalog-revalidation.test.ts`: timeout retention/recovery and permanent failure | Repeated outage can leave stale pending evidence until policy expiry |
| P2P replay, stale delta, unauthorized signer | Reject invalid federation state | Signed canonical delta, expiry, seller/delegate authority, revision/digest ordering | `catalog-delta.test.ts`; `p2p-node.test.ts`; federation process artifact | Peer transport authorization and Sybil resistance are deployment-specific |
| Equal-revision equivocation | All honest nodes choose the same state | Canonical digest tie-break | `catalog-delta.test.ts`; `docs/rfp/federation-process-proof-2026-09-07.json` | Convergence does not identify a malicious seller or impose slashing |
| Node restart/data loss | Accepted catalog state survives one process restart | PostgreSQL state/tombstones; restart attaches without replaying schema | Federation process artifact: three processes/databases, restart, revoke, restore | Proof runs on one workstation, not independent operators |
| Provider source escalation | Caller cannot self-declare independent evidence | Source is derived from distinct bearer credentials; observer signer allowlist | `server-provider-quality.test.ts`: body-label rejection and observer allowlist cases | Bearer credential custody/rotation is an operator responsibility |
| Duplicate in-band and observer reports | One logical call contributes one aggregate sample | Prefer one independent row per signed `(callId, requestDigest)` occurrence | `provider-quality-store.test.ts`: aggregate deduplication case | Legacy observations without `callId` cannot be safely correlated |
| Observer/in-band disagreement suppression | Conflicting facts remain reviewable | Raw rows retained; cross-source factual differences stored separately | `provider-quality-store.test.ts`: disagreement persistence cases | No automated adjudication or observer reputation system |
| Provider-quality manipulation | Conservative policy uses authenticated aggregate evidence | Signed aggregates, Wilson upper bound, explicit evidence states, seller policy | Bazaar provider-quality tests; SDK provider-outcome tests | Diverse public observer corpus and collusion analysis are pending |
| Discovery outage after settlement | Payment success does not depend on catalog availability | Durable local, transaction-keyed outbox and asynchronous replay | `facilitator-service/src/__tests__/catalog-outbox.test.ts` | Queue is local to one host; no shared multi-instance outbox |
| SSRF through catalog or MCP URL | Private/metadata targets are not fetched by default | URL checks, explicit revalidation origin allowlist, no redirects | Live-payment-term and MCP URL tests | DNS rebinding and proxy behavior require deployment review |
| Prompt injection from seller content | Seller text remains data | MCP emits structured `untrusted_seller_data` instead of control text | MCP tool tests | Downstream model behavior cannot be guaranteed |
| Missing write credential | Public write endpoints fail closed | Required 24-character Bazaar token; optional observer path disabled when unset | Bazaar config/auth tests; Compose required-variable check | Token distribution and rotation are not automated |

## Evidence classification

The federation artifact proves three independent OS processes, transport
identities, and PostgreSQL databases on one workstation. It does not prove
independent operators, Internet reachability, Byzantine tolerance, or a
production service-level objective. Testnet conformance proves observed
behavior at the recorded transaction and ledger; it is not pubnet evidence.

## External review priorities

1. Custom `upto` contract authorization, rounding, replay, and upgrade model.
2. Exact integration assumptions across x402 and Stellar SDK boundaries.
3. Multi-instance signer lease, quarantine, and durable outbox ownership.
4. RPC endpoint independence, disagreement policy, and live ambiguity drills.
5. DNS rebinding, reverse-proxy, origin allowlist, and egress controls.
6. Observer credential lifecycle, collusion resistance, and aggregate policy.
7. Secret storage, rotation, incident response, and deployment hardening.
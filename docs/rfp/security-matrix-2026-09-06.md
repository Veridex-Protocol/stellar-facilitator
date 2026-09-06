# Security Hardening Matrix

Date: 2026-09-06. Scope: repository controls and deterministic tests. This is
not an external audit and does not claim the system is secure.

| Attack | Expected result | Actual result | Control | Test/evidence | Classification |
|---|---|---|---|---|---|
| Payment mutation | Reject before settlement | Exact and `upto` bind signed transaction/auth terms | Upstream exact verification; local `upto` term parser | Facilitator validation/upto suites; 36/36 prior testnet conformance | Protected; external audit required |
| Recipient substitution | Reject | Simulated transfer/payee and signed `upto` payee must match | Event validation and contract arguments | Facilitator/Rust negative vectors | Protected; external audit required |
| Asset substitution | Reject | Token contract must match accepted asset | Simulation event and contract term binding | Facilitator/Rust tests | Protected; external audit required |
| Amount substitution | Reject | Exact amount or `actual <= max` required | Exact verifier; `upto` ceiling | Facilitator/Rust tests | Protected; external audit required |
| Network substitution | Reject | CAIP-2 network must match payload/requirements | x402 network validation | Facilitator/conformance tests | Protected |
| Replay | Reject | Exact host auth nonce and `upto` settled-state guard reject reuse | Soroban authorization and contract state | Conformance replay and Rust tests | Protected; external audit required |
| Expired auth | Reject | Ledger-bounded authorization enforced | x402/contract validation | Facilitator/Rust tests | Protected |
| Catalog spoofing | Reject | Settlement is independently confirmed; owner/payee replacement blocked; live 402 terms must match | Horizon/Soroban proof, owner/delegate signature, live-term validator | Settlement proof, owner signature, live payment-term, catalog delta tests | Protected |
| Forged live payee/amount/network/asset | Reject and do not index | All advertised terms are compared exactly | Bounded official x402 challenge decoder | `live-payment-terms.test.ts` | Protected |
| Resource disappears | Quarantine | Periodic worker soft-drops stale row with a stable reason | `last_verified_at` and verification state | `catalog-revalidation.test.ts` | Protected |
| Route traversal | Reject metadata | Decoded `..` and scheme injection rejected | Bazaar metadata validation | Bazaar catalog tests | Protected |
| SSRF | Reject local/private/reserved targets | DNS and literal IP checks; no redirects; explicit origin allowlist only | Live validator and Playground allowlist | Live-payment-term and Playground smoke tests | Protected; DNS rebinding requires deployment review |
| MCP SSRF | Reject local/private/metadata URLs by default | URL validator blocks common private and metadata targets | MCP URL validation | MCP tests | Protected; DNS rebinding needs hardening |
| Malicious seller text | Treat as data | MCP wraps descriptions and paid bodies in `untrusted_seller_data` JSON objects | Deterministic structured tool output | MCP tool tests | Needs hardening; prompt injection is not solved |
| P2P replay/out-of-order | Ignore | Announcement sequence cache rejects replay; signed deltas use revision/digest ordering | Replay cache, freshness, deterministic arbitration | P2P and catalog-delta tests | Protected in process; durable announcement replay cache needs hardening |
| P2P equivocation/conflict | Converge deterministically | Equal revision uses canonical digest ordering | Signed full snapshots | Catalog-delta tests | Protected for convergence; operator policy remains local |
| Unauthorized federation signer | Reject | Owner signer or configured delegate required; transport identity is not authority | Stellar signature and authorization map | Three-node P2P test | Protected |
| Search manipulation | Bound quality influence | RRF and telemetry factors are bounded; feature-hash false positives now require lexical match | Candidate filtering and bounded modulation | Expanded search benchmark | Needs hardening against Sybil/collusion |
| Sequence collision | Serialize per signer | Scheduler leases one signer per in-flight settlement | Async-local signer lease | Scheduler/concurrency tests | Protected per process; multi-instance key partition is operational |
| RPC unavailable before submit | Fail over once | Health-check selects a healthy provider before one submission | RPC coordinator | RPC coordinator tests | Protected in multi-provider testnet mode |
| RPC timeout after submit | Do not resubmit; reconcile hash | Envelope submitted once; local hash queried across providers | RPC coordinator | Exactly-once ambiguous-timeout tests | Protected locally; live testnet drill pending |
| RPC disagreement | Fail safely and record | Conflicting final states return RPC error and increment metric | Reconciliation quorum check | RPC coordinator disagreement test | Protected locally; live independent-provider drill pending |
| Channel uncertainty | Quarantine signer | Transaction hash is preserved, but upstream scheme does not expose the leased signer after ambiguous submission | No complete control yet | Documented limitation | Needs hardening |

## External Audit Boundary

Contract authorization, exact integration, custom `upto`, fee sponsorship,
multi-provider deployment, DNS rebinding defenses, and cross-service abuse cases
still require independent review. Deterministic tests demonstrate intended
behavior; they do not substitute for an audit.
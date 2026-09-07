# Reuse and Original Architecture

Veridex keeps canonical exact-payment semantics upstream and adds discovery,
evidence, policy, and operator controls around them.

## Upstream

| Component | Reused for |
|---|---|
| `@x402/core` | x402 v2 wire types, HTTP challenge/response encoding, facilitator and client contracts |
| `@x402/stellar` | Canonical Stellar `exact` authorization validation, simulation, fee-bump construction, submission, and stock client interoperability |
| `@x402/extensions` | Bazaar discovery extension declaration and extraction |
| `@x402/hono` | Reference seller payment middleware |
| `@stellar/stellar-sdk` | Stellar XDR, signatures, Horizon, and Soroban RPC primitives |

Exact payment semantics are not forked. Veridex configures the official exact
facilitator with leased signer selection and, when enabled, routes its JSON-RPC
traffic through a bounded coordinator. The coordinator does not rebuild or
modify the signed transaction.

## Veridex

| Component | Original responsibility |
|---|---|
| Bazaar | PostgreSQL catalog, payment-bound provenance, live 402 revalidation, search, telemetry, and local ranking policy |
| Federated discovery | Signed owner/delegate catalog deltas, deterministic conflict ordering, revoke/restore, and GossipSub transport |
| `upto` | Experimental Stellar metered-payment specification, contract, server/client adapters, and facilitator scheme |
| Provider quality | Signed per-call outcomes, independent observations, Wilson-bound aggregate states, and seller policy |
| Agent policy | Spend ceilings, custom signer interfaces, and seller quality decisions without synchronous indexer dependence |
| MCP | Discovery/payment tools, SSRF controls, and explicit untrusted seller-data boundaries |
| Receipts | Recomputable signed `x402job/1` claims |
| SDK facade | Public buyer, Bazaar, facilitator, provider-quality, and experimental `upto` APIs |
| Operations | Channel signer leasing, bounded post-settlement catalog handoff, RPC coordination, Prometheus metrics, and evidence harnesses |

## Maturity Boundary

Canonical exact is upstream-aligned and testnet-proven. Veridex `upto` is
testnet-proven but experimental and unaudited. Federation has a local live
three-node transport proof, not a multi-operator production deployment. The
package is publishable from a tarball but remains unpublished until registry
evidence says otherwise.
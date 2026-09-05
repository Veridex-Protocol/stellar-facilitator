# Architecture Decision Records

Decisions behind the Veridex x402 facilitator and federated Bazaar on Stellar, recorded in the Veridex ADR format: what was true, what we decided, and what it costs including the costs we would rather not have.

Each ADR states its **Status** with the date and what it records, a **Context** that names the actual problem rather than a category, a **Decision** with the mechanism, and **Consequences** split into what we gained, what we accepted, and what we deliberately did not do.

## Index

| ADR | Decision | Records |
| --- | --- | --- |
| [001](./adr-001-discovery-federation.md) | Discovery Federation | Why the Bazaar is a gossip mesh of independent catalogs, and the trust boundary that forces |
| [002](./adr-002-ranking-and-embeddings.md) | Ranking and Embeddings | Telemetry as a first-class ranking signal; why the vector leg is lexical today and what turns on a learned model |
| [003](./adr-003-settlement-liveness.md) | Settlement Liveness | Why a settled payment outranks a heartbeat, after heartbeat-only pruning deleted every auto-catalogued resource from search |
| [004](./adr-004-catalog-integrity.md) | Catalog Integrity | Why a listing must name a settlement the catalog confirms on Horizon itself |
| [005](./adr-005-advertise-only-what-is-verified.md) | Verified Capabilities | Why the process refuses to start rather than advertise a scheme, a sponsorship, or a job it cannot honour |
| [006](./adr-006-recomputable-receipts.md) | Recomputable Receipts | RFC 8785, after the previous canonicalization left every settlement field unsigned |
| [007](./adr-007-settlement-throughput.md) | Settlement Throughput | Channel accounts plus a leasing scheduler, after a settlement took 307 seconds and returned a 502 on a payment that succeeded |
| [008](./adr-008-ledger-skew-retry.md) | Ledger-Skew Retry | One reason code, a delay longer than a ledger close, and never a retry on a transaction that reached the network |
| [009](./adr-009-discovery-wire-conformance.md) | Discovery Wire Conformance | The spec's six filters, opaque query-bound cursors, and telling the seller whether their listing landed |
| [010](./adr-010-conformance-as-acceptance.md) | Conformance as Acceptance | A stock client settling real money on every pull request, and figures derived from logs rather than counters |
| [011](./adr-011-upto-converge-upstream.md) | `upto` Contract | The constraints that shape the settlement contract, and the two properties our architecture requires |

## Reading order

**For the architecture**, read 001 → 004 → 003 → 002. That is the discovery story end to end: federate the catalog, which forces a trust boundary, which makes settlement the strongest liveness signal, which becomes a ranking input.

**For the payment path**, read 005 → 007 → 008 → 006. Advertise only what is verified, bound concurrency so sequence numbers never collide, survive upstream RPC skew, and issue a receipt a stranger can recompute.

**For how any of it is checked**, read 010, then 009.

**For the design rationale**, read 011, and the honest accounting in 002.

## What these records are honest about

The ADRs name three gaps rather than bury them, because a reviewer will find them anyway and finding them stated is a different experience from finding them hidden:

- **Retrieval quality** (002). Our vector leg is feature hashing, not a learned model, and we ship no evaluation methodology. This is the largest gap in this implementation, and it sits on the most valuable part of the scope.
- **Mainnet** (010). `stellar:pubnet` is wired end to end and has never been exercised. Both networks are committed deliverables.
- **`upto`** (011). Rebuilt on soroban-sdk 26.1.1 with term-bound authorization, contract-level replay, and on-ledger attribution of the charged amount. The custom facilitator HTTP path is proven on testnet; upstream convergence and an independent audit remain open.

Two smaller ones are recorded in their own ADRs and in [`testnet_docs.md`](../../testnet_docs.md): the ledger-skew retry has never been observed rescuing a live degraded window (008), and multi-page cursor traversal is unexercised end to end because the demo catalog holds one resource (009).

## Related documents

- [`docs/architecture.md`](../architecture.md) - system invariants, component breakdown, and trust boundaries.
- [`docs/deployment.md`](../deployment.md) - production environment setup and operational procedures.
- [`docs/specifications/spec-v2.md`](../specifications/spec-v2.md) - the originating proposal. ADR-003 corrects its liveness model, ADR-002 corrects its description of the vector leg as semantic, and ADR-011 supersedes its `upto` plan.
- [`testnet_docs.md`](../../testnet_docs.md) - the go-live runbook, the boot gates, and the known-limits list.
- [`README.md`](../../README.md) - what is implemented, what is not, and how to settle a payment yourself.

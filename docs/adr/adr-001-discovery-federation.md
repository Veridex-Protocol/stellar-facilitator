# ADR-001: Discovery Federation A Gossip Mesh, Because a Catalog With One Owner Is Not Discovery

### Status

Accepted (2026-08-23) records why the Bazaar is a federated mesh of independent catalogs rather than one index, what that costs, and the trust boundary it forces us to build that a single-process design never has to.

Implements the P2P mesh described in [spec-v2.md §3.1](../specifications/spec-v2.md).

## Context

The RFP is unusually direct about the failure mode it wants avoided:

> Several facilitators run their own Bazaar compatible catalogs, so today a Stellar denominated service is only as discoverable as whichever multi-chain facilitator happens to carry it.

and

> Interoperate with the wider x402 discovery ecosystem. Stellar listings should be representable consistently with how other facilitators represent theirs, so Stellar is not a walled garden.

That is a statement about market structure, not about software. A catalog is a two-sided market: sellers list where buyers look, buyers look where listings are. Whoever runs the index that reaches critical mass first owns Stellar's service discovery, and every later facilitator is a client of theirs. The RFP funds an *open* facilitator precisely so "the ecosystem must not depend on a single hosted operator" — but an Apache-2.0 licence on a single-index design does not deliver that. Anyone may fork the code; nobody can fork the network effect.

Every implementation we have examined, including our own v1, is a single catalog. A facilitator writes rows to its own Postgres, serves `/discovery/search` from it, and that is the extent of federation. Fork it and you get an empty database.

The monolithic alternative is architecturally cleaner than ours, and it is worth being precise about what it buys. Put the facilitator and the catalog behind one process and one database, and cataloging becomes an in-process call whose caller is trivially trustworthy — the catalog can record the settlement it just performed and be done. No authentication, no verification, no network. That is correct and simple **for a single operator**, and it is the right design if one operator is the goal.

It does not extend to a second operator. The moment a catalog accepts a listing from a facilitator it does not run, "we settled it, trust us" stops being an argument — and there is no incremental way to add a trust boundary to a design that never had one.

So the decision is not really "mesh or database". It is: **do we accept a trust boundary between facilitator and catalog now, or do we build something that structurally cannot have one?**

## Decision

**Every catalog is independent, listings gossip between them, and no catalog ever takes another node's word for a payment.**

### 1. Two ingestion paths, one trust rule

| Path    | Trigger                                                        | Who can invoke                           | Gate                                                     |
| ------- | -------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------- |
| Passive | A settled payment carrying the Bazaar extension                | The facilitator, over authenticated HTTP | Settlement confirmed on Horizon by the*catalog*        |
| Active  | A signed GossipSub announcement on`/x402/bazaar/v1/announce` | Any mesh peer                            | Ed25519 signature + freshness + the same settlement gate |

Both paths converge on [`CatalogIngestionWorker.ingest`](../../bazaar-service/src/catalog/ingestion.ts), and neither is privileged. The facilitator's own HTTP call is authenticated with `BAZAAR_INTERNAL_TOKEN` and is *still* subject to settlement confirmation. Authentication answers "may you write here"; it does not answer "is this true".

That distinction is the whole architecture. See [ADR-004](./adr-004-catalog-integrity.md) for the verification itself.

### 2. Gossip carries claims, not authority

A P2P announcement is signed, so it proves *who said it*. It does not prove anyone paid. Announcements therefore reach the catalog only when they name a settlement, and the receiving node confirms that settlement against Horizon itself:

```ts
// bazaar-service/src/server.ts — P2P message handler
// A signed gossip announcement proves who said it, not that anyone
// paid. Only announcements naming a settlement reach the catalog; the
// rest still count as liveness telemetry below.
if (message.description && message.payTo && message.network &&
    message.scheme && typeof message.settlementTx === "string") {
  await this.ingestionWorker.ingest({ /* ... */ settlementTx: message.settlementTx });
}
await this.telemetryTracker.processHeartbeat(message);
```

An unsigned or unbacked announcement is not an error and is not discarded — it still updates liveness telemetry. It simply cannot create a listing.

### 3. Replay is bounded per node, not globally

One settlement lists one resource, enforced by a `UNIQUE` constraint on `catalog_resources.settlement_tx`. A peer that re-gossips a valid settlement to claim a second resource trips the constraint on every node that receives it, independently, without any node needing to consult another.

This is deliberately a *local* invariant. Global deduplication across a mesh requires consensus, and consensus is not worth its cost for a discovery index. Every node reaching the same conclusion from the same public ledger is sufficient and needs no coordination.

### 4. The mesh is optional at every node

`P2P_BOOTSTRAP_PEERS` empty is a supported, tested configuration: the node runs as an isolated catalog with passive ingestion only. Federation is a capability, not a dependency. An operator who wants a private catalog for their own sellers gets one by leaving a variable unset.

## Why not a single index with read replicas

It is the obvious cheaper answer and we rejected it, so the reasoning should be on the record.

|                  | Single index                 | Federated mesh                              |
| ---------------- | ---------------------------- | ------------------------------------------- |
| Operational cost | One Postgres                 | One Postgres**per node**, plus libp2p |
| Consistency      | Strong                       | Eventual, per-node                          |
| Search ranking   | Global corpus, best possible | Per-node corpus, ranking varies by node     |
| Failure domain   | One                          | Per node                                    |
| Trust boundary   | None needed                  | Required, and load-bearing                  |
| Fork produces    | An empty database            | A participating peer                        |

The last row is the entire argument. Everything above it is a cost we are paying to buy it.

The consistency row deserves care rather than hand-waving: a federated catalog means two buyers querying two nodes can get different results, and neither is wrong. For a discovery index this is acceptable in a way it would not be for settlement — a slightly stale listing costs a wasted query, whereas a stale ledger costs money. We are explicit that discovery is eventually consistent and settlement is not, and we never blur the two.

## Consequences

**Good**

- Forking the repository yields a *participating peer*, not an empty database. This is the only structural answer to the walled-garden problem the RFP names, and licensing alone does not provide it.
- The trust boundary is forced into existence and therefore gets built and tested. A single-process design can defer it indefinitely, and then cannot add it without re-architecting.
- Node failure is contained. A catalog going down removes one view of the corpus, not the corpus.
- Sellers are not required to pick a facilitator to be discoverable through. Paying through any participating facilitator lists you across the mesh.

**Costs accepted**

- **Operating cost per node is materially higher.** Postgres 17 with pgvector, plus a libp2p node with its own listen addresses and bootstrap configuration. A single-index deployment runs one process and one database; we run one process, one database, and a mesh participant. For a solo operator this is the wrong trade, which is why §4 makes the mesh optional.
- **Ranking quality is bounded by local corpus size.** A node that has seen 40 resources ranks worse than one that has seen 4,000, and no amount of algorithm work fixes that. Federation makes the corpus grow through gossip, but a new node starts cold. See [ADR-002](./adr-002-ranking-and-embeddings.md) — this compounds with the embedding decision recorded there.
- **Eventual consistency is visible to users.** Two nodes can answer the same query differently. We surface `partialResults` where our own view is knowingly incomplete ([ADR-009](./adr-009-discovery-wire-conformance.md)), but we do not and cannot signal "another node knows something I do not".
- **The verification gate costs a Horizon round trip per ingest.** Roughly 200–400ms added to cataloging. Cataloging is off the payment path — it happens after settlement and never blocks the buyer's response — so this is latency nobody waits on.

**Deliberately not done**

- **No consensus, no shared state, no chain.** Nodes do not agree on a canonical catalog and are not meant to. The RFP explicitly warns against an on-chain registry: "it adds rent that must be extended or entries are evicted, and per payment anchoring adds a second transaction that roughly doubles settlement cost." We keep the index off-chain and the ledger as the *source of truth for payments only*.
- **No reputation or peer scoring.** A node that gossips junk is rate-limited by the settlement gate — junk without a confirmed settlement never lists. That is a sufficient defence for now, and a scoring system is a research project with its own attack surface.
- **No cross-node deduplication of the same resource.** Two nodes can each hold a listing for the same URL from two different settlements. Harmless for discovery, and resolving it needs coordination we deliberately do not have.

## References

- [`bazaar-service/src/p2p/`](../../bazaar-service/src/p2p/) — libp2p node, GossipSub announcer, signed message schema
- [`bazaar-service/src/server.ts`](../../bazaar-service/src/server.ts) — P2P handler, ingest route, the authentication/verification split
- [`bazaar-service/src/catalog/ingestion.ts`](../../bazaar-service/src/catalog/ingestion.ts) — the single convergence point for both ingestion paths
- [`bazaar-service/src/db/schema.sql`](../../bazaar-service/src/db/schema.sql) — `settlement_tx UNIQUE`, the per-node replay bound
- [ADR-004](./adr-004-catalog-integrity.md) — the settlement verification this design forces
- RFP §3.2 — interoperability mandate, and the warning against an on-chain registry

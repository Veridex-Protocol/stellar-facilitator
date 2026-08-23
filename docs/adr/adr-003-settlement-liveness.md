# ADR-003: Liveness — A Settled Payment Outranks a Heartbeat

## Status

Accepted (2026-08-23) — records why liveness derives from two signals rather than heartbeats alone, after heartbeat-only pruning was found silently deleting every automatically catalogued resource from search within minutes.

Corrects the circuit breaker in [spec-v2.md §3.3](../specifications/spec-v2.md), which specified heartbeats as the sole input.

## Context

spec-v2 specified a liveness circuit breaker driven by P2P heartbeats: `HEALTHY` inside one 30s interval, `DEGRADED` up to three missed, `OFFLINE` beyond. Reasonable, and it shipped that way.

It was wrong, and a full end-to-end conformance run is what caught it.

The failure sequence:

1. A buyer pays for a resource through the facilitator.
2. The facilitator confirms settlement and catalogs the resource. Automatic cataloging is working exactly as the RFP specifies — *"the facilitator catalogs the resource with no separate registration step"*.
3. The resource has no libp2p node, because its seller is a plain HTTP server that took a payment. It broadcasts no heartbeats and has no reason to.
4. `pruneOfflineNodes()` sees `last_heartbeat_at` ageing past `30s × 3`.
5. Within ~90 seconds the resource is `OFFLINE`. The search query filters `liveness_status <> 'OFFLINE'`.
6. **The resource someone just paid for is undiscoverable, and nothing is wrong with it.**

The conformance check `the paid resource is discoverable after settling` passed immediately after a settlement and failed on a later run against a stack that had been up longer. That intermittency is exactly what makes this class of bug survive review — it looks like flake.

The deeper error is a category mistake. Heartbeats measure *"is a process running and connected to our mesh"*. That is a proxy for the thing we care about, which is *"will an agent that pays this endpoint get served"*. A settlement is not a proxy for that. **A settlement is a direct observation of it**: someone paid, the transaction confirmed on the ledger, and the resource server returned the goods. It is the strongest liveness evidence a facilitator can possibly hold, and we were throwing it away in favour of a weaker signal that most sellers structurally cannot emit.

Requiring a seller to run a libp2p node to stay discoverable also quietly repeals automatic cataloging. The point of cataloging on settlement is that the seller does nothing. If they must then join a mesh to remain listed, they may as well have registered manually.

## Decision

**Liveness is the most recent of two independent signals, with windows sized to how often each is emitted.**

### 1. Two signals, either sufficient

| Signal | Column | Window to `HEALTHY` | Emitted by |
| --- | --- | --- | --- |
| P2P heartbeat | `last_heartbeat_at` | `HEARTBEAT_INTERVAL_MS` (30s) | Mesh participants |
| Confirmed settlement | `last_settlement_at` | `SETTLEMENT_LIVENESS_WINDOW_MS` (24h) | Any resource that takes a payment |

```sql
CASE
  WHEN last_heartbeat_at  >= now() - interval '30 seconds'  THEN 'HEALTHY'
  WHEN last_settlement_at >= now() - interval '24 hours'    THEN 'HEALTHY'
  WHEN last_heartbeat_at  >= now() - interval '90 seconds'  THEN 'DEGRADED'
  WHEN last_settlement_at >= now() - interval '7 days'      THEN 'DEGRADED'
  ELSE 'OFFLINE'
END
```

### 2. The windows differ by three orders of magnitude, deliberately

Heartbeats are *scheduled*, so absence is informative: a node that promised one every 30s and went quiet has told you something. Settlements are *demand-driven*, so absence is not informative — a perfectly healthy endpoint can go hours between payments simply because nobody needed it. Applying a heartbeat-shaped window to a settlement-shaped signal is precisely the original bug in a new costume.

24 hours to stay `HEALTHY`; 7 days before `OFFLINE`.

### 3. Ingest restores liveness

Cataloging a confirmed settlement stamps the timestamp and resets status in the same statement:

```sql
INSERT INTO resource_telemetry (resource_id, settlement_count, last_settlement_at, liveness_status)
VALUES ($1, 1, now(), 'HEALTHY')
ON CONFLICT (resource_id) DO UPDATE SET
  settlement_count   = resource_telemetry.settlement_count + 1,
  last_settlement_at = now(),
  liveness_status    = 'HEALTHY',
  updated_at         = now()
```

A payment does not merely record a fact; it re-establishes the resource as live. A resource that was pruned to `OFFLINE` during a quiet week is restored by its next payment, with no operator action.

### 4. Migration seeds existing rows

`002_settlement_liveness.sql` adds the column and backfills `last_settlement_at` from `catalog_resources.updated_at` for every row that already carries a `settlement_tx`. Without the backfill, the first prune after deploying would take every existing listing offline — the original bug, triggered by its own fix.

## Consequences

**Good**

- Automatic cataloging actually works. A seller exposes a paid endpoint, someone pays, and it stays discoverable. No mesh participation required, which is what §3.2 intends.
- Liveness now rests on the strongest available evidence. A settlement proves reachability, correct payment handling, and that the resource served a caller — all three at once.
- The signal is free. It is a byproduct of being the facilitator, needing no probe traffic, no scheduled job, and no cooperation from the seller.
- Self-healing without operator involvement: a payment restores a stale listing.

**Costs accepted**

- **A resource that stops working keeps its `HEALTHY` status for up to 24 hours** after its last settlement. This is a real staleness window and it is the direct price of not punishing sellers for low traffic. A mesh participant is corrected within 90 seconds; a non-participant is not.
- **Two timestamps to reason about.** The `CASE` is longer, the interaction between windows needs thought when tuning, and it is duplicated across the `SET` and `WHERE` halves of the prune statement — a maintenance hazard flagged here so it is not discovered later.
- **`SETTLEMENT_LIVENESS_WINDOW_MS` is a guess.** 24 hours is a judgement about typical inter-payment gaps for a low-traffic API, informed by nothing but reasoning. It is env-configurable precisely because we expect to be wrong.
- **A settlement proves the resource served *someone*, once.** It does not prove it is serving *now*, nor that it serves everyone. It is strong evidence, not a guarantee.

**Deliberately not done**

- **No active probing.** Having the catalog HTTP-poll every listed resource would give a fresh, direct signal — and turns the Bazaar into an unsolicited traffic generator against endpoints that never asked to be probed, with the SSRF surface that implies. The settlement signal is nearly free and carries none of that.
- **No `failed_settlement_count` demotion yet.** The column exists and is incremented, but a failed settlement is more often the payer's fault than the resource's. Treating it as a health signal without separating those causes would penalise resources for their buyers' mistakes.
- **No per-caller liveness.** "Works for me, not for you" — geo-blocking, rate limiting — is real and out of scope for a single global status.

## References

- [`bazaar-service/src/telemetry/tracker.ts`](../../bazaar-service/src/telemetry/tracker.ts) — `pruneOfflineNodes`, the two-signal `CASE`
- [`bazaar-service/src/telemetry/circuit-breaker.ts`](../../bazaar-service/src/telemetry/circuit-breaker.ts) — `SETTLEMENT_LIVENESS_WINDOW_MS`
- [`bazaar-service/src/catalog/ingestion.ts`](../../bazaar-service/src/catalog/ingestion.ts) — the liveness-restoring upsert
- [`bazaar-service/src/db/migrations/002_settlement_liveness.sql`](../../bazaar-service/src/db/migrations/002_settlement_liveness.sql) — column plus the backfill that prevents the fix from firing the bug
- [ADR-002](./adr-002-ranking-and-embeddings.md) — how the resulting status weights ranking
- [ADR-010](./adr-010-conformance-as-acceptance.md) — the conformance check that caught this

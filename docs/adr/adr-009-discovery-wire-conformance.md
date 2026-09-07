# ADR-009: Discovery Wire Conformance - Filters, Opaque Cursors, and Telling the Seller What Happened

## Status

Accepted (2026-08-23) - records the discovery filters, cursor pagination bound
to the query that issued it, and server-internal `EXTENSION-RESPONSES` outcome
handling.

Reconciled 2026-09-06: direct Bazaar ingestion still reports final
`success`/`rejected`, but facilitator settlement now returns a truthful Veridex
`queued` outcome before asynchronous outbox delivery. The upstream sidechannel
is server-internal and is not buyer payment proof.

## Context

The project brief grades wire-level behaviour, not intent:

> Conformance is a hard acceptance criterion. Correct settlement plus a non conformant wire format produces an unusable service, so acceptance is tested at the wire level. Reviewers will point stock SDK code at the deliverable rather than read a conformance claim.

Three parts of our discovery surface did not conform.

**Filters were partly wired.** The spec names `type`, `payTo`, `network`, `extensions`, `limit`, `offset`. Our search engine's `list()` supported `resourceType`, `network`, `scheme`, `tags`, `limit`, `offset` - but the *route* passed only `network`, `limit`, `offset`. `type` existed in the engine and was unreachable from HTTP; `payTo` and `extensions` did not exist at all. A client filtering by `payTo` got an unfiltered list and no error - the worst kind of non-conformance, because it looks like it works.

**Pagination was offset-only.** The spec names cursor pagination. We accepted `offset`, and `partialResults` was hardcoded `false` in both response paths - schema-conformant and semantically empty.

**The seller was never told whether their listing landed.** `EXTENSION-RESPONSES` is how the spec reports cataloging outcomes: *"so a seller can tell whether a listing landed, and why not."* Our ingestion built the base64 payload correctly and returned it **in the JSON body**, and the facilitator - which is what the seller actually talks to - read the catalog's response and discarded it. A seller whose listing was rejected for a bad `routeTemplate` had no way to learn that, ever. The loop the spec describes was open at both ends.

## Decision

**Implement the surface as specified, and make each element mean something.**

### 1. All six filters, on both endpoints

| Parameter | Semantics |
| --- | --- |
| `type` | `http` or `mcp` |
| `payTo` | Stellar address receiving payment |
| `network` | CAIP-2, e.g. `stellar:testnet` |
| `extensions` | Comma-separated; matches resources declaring **all** of them |
| `limit` / `offset` | Page size and start; `limit` clamped to 100 |
| `cursor` | Opaque continuation; supersedes `offset` |

`extensions` uses the JSONB has-all-keys operator:

```sql
r.extensions ?& $n::text[]
```

`?&` is unambiguous here because node-postgres uses `$n` placeholders, so a literal `?` in SQL is never a parameter marker.

`scheme` and `tags` are supported as extras beyond the spec.

Verified narrowing rather than merely returning 200 - `type=mcp` returns 0 against an HTTP-only catalog, and a `payTo` that paid for nothing returns 0.

### 2. Cursors are opaque and bound to their query

[`cursor.ts`](../../bazaar-service/src/search/cursor.ts) issues base64url tokens carrying position, page size, and a **fingerprint of the query and filters** that produced them.

Opacity is the point: the pagination strategy can change without breaking callers, and a client cannot invent an offset into a ranking it never requested.

Presenting a cursor against a different query is refused:

```
400 {"error":"invalid_cursor","message":"cursor belongs to a different query or
filter set; a cursor may only be used to continue the search that produced it"}
```

Silently answering would return the wrong page while looking correct - **the same offset under different terms is a different set of rows.** A version field is included so a future encoding change fails cleanly rather than being misread.

### 3. `partialResults` is computed

Each retrieval leg contributes at most 50 candidates before fusion. A saturated pool means ranking never saw some matches, so the page is not a complete answer. `partialReason` states it in words. Listing (`/discovery/resources`) applies no candidate truncation, so it reports `false` honestly rather than by default.

### 4. A truthful immediate catalog status reaches the seller

The direct Bazaar endpoint returns final success/rejection. The facilitator path
has a different timing contract:

1. Successful settlement writes a durable transaction-keyed outbox event.
2. The facilitator returns `EXTENSION-RESPONSES` with `bazaar.status: "queued"` and the transaction.
3. Bazaar later validates live terms, settlement, and metadata and returns final `success` or `rejected` on the internal ingestion call.

Cataloging failure never changes a successful settlement. Immediate queued status
must not be documented as final catalog acceptance.

Direct ingestion rejection remains actionable:

```json
{"bazaar":{"status":"rejected","rejectedReason":"settlementTx is required: a catalog
entry must name the settlement that backs it, which this service confirms on Horizon."}}
```

### 5. `routeTemplate` decoding order is preserved

Percent-decode **before** traversal and scheme-injection checks, because `%2e%2e%2f` defeats a naive `..` check. This was already correct and is recorded here so a future refactor does not reorder it.

## Consequences

**Good**

- A stock client's filters do what they say. The silent-no-op class of bug is gone from this surface.
- Cursors are safe to hand out: opaque, query-bound, versioned, and rejected rather than misinterpreted when misused.
- `partialResults` distinguishes "all the matches" from "the first 50 we ranked", which is exactly what an agent deciding whether to broaden a query needs.
- Sellers get truthful immediate queue status; operators can inspect eventual Bazaar rejection reasons and outbox metrics.
- All eight discovery checks pass in the conformance harness against a live stack.

**Costs accepted**

- **Cursor fingerprints make cursors brittle by design.** Adding a filter mid-pagination invalidates the cursor. Correct - the result set changed - and it will look like a bug to a client that does it. The error message says exactly what happened.
- **The fingerprint is a 16-char SHA-256 prefix**, so collisions are possible in principle. A collision would allow a cursor from a *different* query to be accepted; the consequence is a wrong page, not a security breach, and the probability is negligible at catalog scale.
- **Multi-page traversal is unexercised end to end.** The demo catalog holds one resource, so no conformance run has walked to a second page. Ten unit tests cover the logic and forged cursors are rejected at the wire, but that is not the same thing, and `testnet_docs.md` records it.
- **Immediate status is not eventual admission.** The durable outbox preserves work during Bazaar outage, but the seller-facing settle response does not synchronously contain the later rejection reason.
- **`extensions` matches keys, not values.** `extensions=bazaar` finds resources declaring the bazaar extension; it cannot filter on anything inside it.

**Deliberately not done**

- **No stable snapshot behind a cursor.** Paging a live catalog can miss or repeat a row that changed between pages. A snapshot would need a transaction or a versioned view; `partialResults` signals incompleteness instead.
- **No cursor signing.** Tampering yields a wrong page, not privilege. HMAC would add key management for no security gain.
- **No `maxPrice` or `asset` filters.** Both are reasonable extensions an agent would use, and neither is in the spec's named set; adding them is cheap once the named set is solid.

## References

- [`bazaar-service/src/search/cursor.ts`](../../bazaar-service/src/search/cursor.ts) - encoding, fingerprinting, refusal
- [`bazaar-service/src/search/engine.ts`](../../bazaar-service/src/search/engine.ts) - filters, `?&`, cursor resolution, `partialResults`
- [`bazaar-service/src/server.ts`](../../bazaar-service/src/server.ts) - parameter parsing, `EXTENSION-RESPONSES` on both outcomes
- [`facilitator-service/src/server.ts`](../../facilitator-service/src/server.ts) - header propagation to the seller, `exposeHeaders`
- [`bazaar-service/src/__tests__/cursor.test.ts`](../../bazaar-service/src/__tests__/cursor.test.ts) - opacity, cross-query refusal, version rejection
- [`conformance/src/harness.mjs`](../../conformance/src/harness.mjs) - the eight discovery checks

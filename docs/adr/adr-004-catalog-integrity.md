# ADR-004: Catalog Integrity — The Catalog Confirms the Payment Itself

## Status

Accepted (2026-08-23) — records why a listing must name a settlement the catalog verifies against Horizon independently, replacing a caller-supplied boolean guarded by an authentication check that was skipped whenever its environment variable was unset.

## Context

The RFP names the facilitator a trust boundary and says why:

> Enforce catalog integrity. The facilitator is a trust boundary: clients echo the resource block into the payment payload, so a hostile client can attempt to poison the catalog with forged service metadata or a crafted routeTemplate.

Our v1 ingestion did not enforce a boundary. It accepted:

```ts
settlementSucceeded?: boolean;   // caller says a payment happened
payTo: string;                   // caller says who was paid
```

guarded by:

```ts
const internalToken = process.env.BAZAAR_INTERNAL_TOKEN;
if (internalToken && c.req.header("Authorization") !== `Bearer ${internalToken}`) {
  return c.json({ error: "Unauthorized" }, 401);
}
```

Two defects, and the second is worse than the first.

**The boolean proves nothing.** `settlementSucceeded: true` is an assertion by whoever sent the request. The catalog performed no independent check that any payment occurred, or that the named `payTo` received anything.

**The authentication was conditional on its own configuration.** `if (internalToken && ...)` means that when `BAZAAR_INTERNAL_TOKEN` is unset, the comparison is skipped entirely and every request is accepted. The failure mode of a missing secret was *no authentication*, silently, with a healthy-looking service. A deployment that forgot the variable — or a `docker compose up` with an incomplete `.env` — exposed an unauthenticated write endpoint on a public catalog and gave no indication.

This matters more for us than for a single-process design. When facilitator and catalog share a process and a database, cataloging is a function call and the caller is trivially trustworthy. Our catalog is a separate service that accepts writes over HTTP from facilitators and, under [ADR-001](./adr-001-discovery-federation.md), gossip from peers it does not run. "The caller said so" is not available to us as an answer.

## Decision

**A listing must name a settlement transaction. The catalog looks it up on Horizon itself, and lists nothing it cannot confirm.**

### 1. `settlementTx` is required, and is a hash, not a claim

```ts
/**
 * Hash of the settlement that backs this entry. Required: the catalog
 * confirms it on Horizon rather than trusting the caller that a payment
 * happened.
 */
settlementTx: string;
```

### 2. Four checks, in order, before anything is written

[`verifySettlement`](../../bazaar-service/src/catalog/settlement-proof.ts) runs inside the ingest transaction, before any row is touched:

| # | Check | Rejects |
| --- | --- | --- |
| 1 | 64 hex characters | Malformed input, cheaply |
| 2 | Exists on the configured network's Horizon | Invented hashes, wrong-network hashes |
| 3 | `successful === true` | A transaction that was submitted and rejected |
| 4 | An effect credits `payTo` | A real payment to someone else, reused to list your own resource |

Check 4 is the one that makes the others worth having. Without it, any confirmed transaction on the network — anyone's — backs any listing.

### 3. Authentication is mandatory and fails at boot

```ts
function requireInternalToken(): string {
  const token = process.env.BAZAAR_INTERNAL_TOKEN?.trim();
  if (!token || token.length < 24) {
    throw new Error("BAZAAR_INTERNAL_TOKEN is required and must be at least 24 characters. ...");
  }
  return token;
}
```

The process refuses to start. A misconfiguration is now a failed boot with an actionable message instead of a running service that authenticates nothing. The comparison is unconditional.

Authentication and verification answer different questions and are both required: *may you write here* and *is this true*.

### 4. Failure is closed

An unreachable Horizon means `valid: false` with a reason. An outage must not become an open catalog. This is a deliberate availability-for-integrity trade: during a Horizon outage we stop listing rather than start trusting.

### 5. One settlement lists one resource

`catalog_resources.settlement_tx` is `UNIQUE`. Re-ingesting the same resource with a fresh settlement updates in place; reusing a settlement for a *different* resource trips the constraint, which is caught and converted into a reason rather than a 500:

```ts
if (error?.code === "23505" && String(error?.constraint).includes("settlement_tx")) {
  const reason = "settlementTx has already been used to list a different resource";
```

### 6. Structural validation still applies

Settlement verification is orthogonal to content validation. `routeTemplate` is percent-decoded *before* traversal and scheme-injection checks — the ordering the spec requires, since `%2e%2e%2f` defeats a naive `..` check — and `serviceName`, `tags`, and `iconUrl` keep their soft-drop rules. A verified payer can still submit hostile metadata.

## What this does not prove

Stated plainly, because overclaiming here would be the same error the boolean made.

The ledger records **value moving to an account**. It does not record which URL was served. So a seller holding one genuine settlement can attach a description of their choosing to it. What the gate actually establishes is: *someone paid this `payTo`, recently, and that payment is on the public ledger and used nowhere else in this catalog*. That converts catalog spam from free into something that costs a real payment per listing, and it makes every listing auditable by a third party from the transaction hash alone.

Binding the *URL* cryptographically requires the resource server to sign the pairing of settlement and resource. That is a protocol change, it is not in the discovery spec today, and it is recorded in [`testnet_docs.md`](../../testnet_docs.md) as a known limit rather than papered over.

## Consequences

**Good**

- The catalog is auditable end to end. Every listing names a transaction hash any third party can independently check on Horizon, without our cooperation.
- Spam has a floor price: one real settlement per listing, and each settlement is spendable once.
- Misconfiguration cannot silently disable the guard. Both the token and the verification are non-optional and fail loudly.
- The trust model survives federation. A peer's gossip is subject to the identical gate, so accepting listings from facilitators we do not run is safe by construction.

**Costs accepted**

- **A Horizon round trip per ingest**, roughly 200–400ms. Cataloging happens after settlement and never blocks the buyer, so nobody waits on it.
- **Horizon is now a dependency of listing.** Failing closed means a Horizon outage halts cataloging. Correct for integrity, and a real availability cost.
- **A 24-hour freshness window** on settlements. A legitimate but delayed catalog submission is rejected and must re-settle.
- **Effect-based `payTo` matching is Horizon-shaped.** We match `account_credited` and `contract_credited` effects. A future settlement pattern that credits through a path Horizon reports differently would need this updated — a coupling to Horizon's effect vocabulary that a Soroban event decoder would not have.
- **Migration `001` soft-drops every pre-existing listing.** Those were created on the old boolean and have no confirmed settlement, so they are marked `soft_dropped` rather than deleted, for operator review. Correct, and it means an upgrading operator sees their catalog empty until entries re-settle.

**Deliberately not done**

- **No Soroban event decoding.** Reading the `transfer` event from the transaction's Soroban events would confirm asset and amount as well as recipient, and is strictly better than effect matching. It needs RPC access and XDR decoding in the Bazaar; the effect check was the higher-value first increment.
- **No amount verification.** We confirm `payTo` was credited, not that they were credited the advertised price. Adding it needs the event decoder above.
- **No proof-of-control over `payTo`.** Anyone able to point a settlement at an address can list against it. The `UNIQUE` constraint bounds the damage to one listing per payment.

## References

- [`bazaar-service/src/catalog/settlement-proof.ts`](../../bazaar-service/src/catalog/settlement-proof.ts) — the four checks and the fail-closed behaviour
- [`bazaar-service/src/catalog/ingestion.ts`](../../bazaar-service/src/catalog/ingestion.ts) — the gate's position ahead of every write, and the replay rejection
- [`bazaar-service/src/server.ts`](../../bazaar-service/src/server.ts) — `requireInternalToken`, the unconditional comparison
- [`bazaar-service/src/__tests__/settlement-proof.test.ts`](../../bazaar-service/src/__tests__/settlement-proof.test.ts) — nine cases including the all-zeros hash, a payment to a different account, and an unreachable Horizon
- [`bazaar-service/src/db/migrations/001_settlement_binding.sql`](../../bazaar-service/src/db/migrations/001_settlement_binding.sql) — column, uniqueness, and the soft-drop of unbacked history
- RFP §3.2 — "the facilitator is a trust boundary"

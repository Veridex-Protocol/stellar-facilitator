# ADR-005: The Service Refuses to Start Rather Than Advertise Something Untrue of It

## Status

Accepted (2026-08-23) — records why every capability on `/supported` and `/.well-known/x402` is confirmed against the network before the HTTP server binds, after the facilitator was found advertising an `upto` scheme with no contract, fee sponsorship from an account nobody had checked, and a capability descriptor of invented jobs.

## Context

`/supported` is a promise to a client that has never met us. A facilitator that advertises `areFeesSponsored: true` is telling a buyer *you need no XLM*; a buyer that believes it builds a payment that fails. A facilitator advertising `scheme: "upto"` is telling a client *this settles*; there is nothing for that client to do but discover otherwise at settlement time.

We were making three untrue promises, all discoverable with `curl`.

**`upto` was advertised against a placeholder.** `/supported` unconditionally returned an `upto` kind with `contractId: process.env.UPTO_ESCROW_CONTRACT_ID || "upto_escrow_v1"`. The default is not a contract address; it is a string. No contract was deployed on any network. Our own go-live document stated *"`upto` is not advertised by `/supported`"* while the code advertised it on every request.

**Fee sponsorship was inferred from key possession.** `feeBumpSignerSecret: process.env.FEE_BUMP_SIGNER_SECRET || config.stellar.facilitatorSecretKey` — always truthy, because `FACILITATOR_SECRET_KEY` is required to boot. So `areFeesSponsored` was structurally always `true`. Holding a secret key says nothing about whether the account behind it exists or holds XLM. An unfunded facilitator advertised sponsorship it could not perform.

**The capability descriptor was fiction.** `/.well-known/x402` returned two hardcoded jobs — `oracle/read` and `compute/session` — priced against `payTo: <facilitator key>` at `https://facilitator.veridex.io`. Every deployment of this software advertised two endpoints it did not serve, at a hostname it was not reachable at, and `compute/session` was priced in the `upto` scheme that had no contract.

The common shape: **capabilities were asserted from configuration rather than established against reality.** Configuration says what an operator intended. Only the network says what is true.

This is not a hypothetical concern for us. We serve `stellar:testnet` and have never exercised `stellar:pubnet`; we hold an `upto` contract that is written but unaudited. Both are things a deployment could be configured to advertise today, and neither is ready. The discipline has to be enforced by the code, because documentation stating a restraint the binary does not implement is worth nothing — and `/supported` is checkable with one `curl`, long before anyone reads our documentation.

## Decision

**Boot-time checks establish every advertised capability against the network. A capability that cannot be confirmed is omitted, and a contradiction aborts the process.**

### 1. Nothing is claimed before it is checked

The constructor initialises to a state that claims nothing:

```ts
this.capabilities = { feesAreSponsored: false, jobs: [], checked: false, notes: [] };
```

`/health` exposes `startupChecksPassed`, so an operator can tell a booted service from a verified one.

### 2. Fee sponsorship is a balance, so ask Horizon

`checkSponsorFunding` loads the account and requires `MIN_SPONSOR_BALANCE_XLM` (5 XLM). Three distinguishable outcomes, each with a specific reason: the account does not exist, the balance is below the floor, or Horizon was unreachable.

Intending to sponsor and being unable to is a **boot failure**, not a downgrade:

```
This deployment is configured to sponsor network fees, but its account G... does not exist
on this network. Fund it, or set SPONSOR_FEES=false to advertise areFeesSponsored=false
instead. Refusing to start rather than advertise sponsorship it cannot honour.
```

Silently downgrading would be friendlier and worse — an operator who asked for sponsorship would get a service quietly not providing it.

### 3. `upto` requires a contract that exists on this network

`resolveUptoGate` reads a **network-specific** variable first (`UPTO_ESCROW_CONTRACT_ID_TESTNET` / `_PUBNET`), validates it with `StrKey.isValidContract`, then confirms the instance exists via `getContractData(..., scvLedgerKeyContractInstance(), Durability.Persistent)`.

Anything short of all three and the scheme is **absent from `/supported` entirely** — not present-but-disabled, not advertised with a note. Absent.

The per-network variable is a deliberate guard: a testnet contract id must never be inherited onto pubnet by an operator who set the generic variable and changed `STELLAR_NETWORK`.

### 4. Descriptor jobs are configuration, validated against reality

`X402_JOBS_FILE` is optional and **defaults to no jobs**, which is the correct descriptor for a facilitator that sells nothing itself. Loaded jobs are validated: the price must be a SEP-41 contract address, the network must be the one served, and the scheme must be one this deployment actually advertises. A job priced in `upto` when no `upto` contract was confirmed **aborts the boot**.

### 5. A final gate compares what we would serve against what we confirmed

`assertSupportedIsTruthful` receives the actual `/supported` body and the verified facts, and throws on any disagreement: sponsorship mismatch, an `upto` kind without a confirmed contract, a contract id that differs, a missing `exact` kind, or a signer that is not listed.

This is belt-and-braces on purpose. Checks 2–4 establish truth; check 5 verifies the *serialisation* of that truth did not drift.

### 6. Honesty rules that are not configurable

`runtime.attested` is hardcoded `false` in the descriptor. Proposal #3117's honesty rule requires it be false absent a verifiable TEE claim, and we produce none. It is not an environment variable, because no operator should be able to turn it on by editing config.

## Consequences

**Good**

- Every advertised capability is checked against the network on every boot. `areFeesSponsored: true` means Horizon confirmed the balance minutes ago.
- Misconfiguration surfaces at deploy time with an actionable message, not at a buyer's failed payment.
- The `upto` gate cannot be defeated by setting a string. A reviewer curling `/supported` sees only `exact`, matching every document we ship.
- Verified live: boot log reads `fee sponsorship confirmed: 9999.9958692 XLM available` / `upto not advertised: no upto contract configured for testnet`, and `/supported` carries exactly one kind.

**Costs accepted**

- **Boot is slower and depends on the network.** Horizon and Soroban RPC calls before binding, so start-up is seconds not milliseconds, and a Horizon outage prevents a *restart* even though a running instance would be unaffected. Accepted: a facilitator that cannot reach Horizon cannot settle anyway.
- **`BASE_URL` is now required.** The descriptor publishes where clients reach the service, which cannot be inferred from a `0.0.0.0` bind address. Existing deployments must set it or fail to start — a deliberate breaking change, since the alternative was the hardcoded hostname.
- **Capabilities are fixed at boot.** Funding the account or deploying the contract while running has no effect until restart. Re-checking periodically would mean `/supported` changing under a client mid-session, which is worse.
- **Five XLM is arbitrary.** Enough for many Soroban settlements at current fees, not derived from a model, and not adaptive to pubnet fee conditions.

**Deliberately not done**

- **No degraded mode.** No "advertise `upto` as coming soon". A scheme is served or absent.
- **No runtime re-verification.** See above.
- **No health-check-driven capability changes.** `/health` reports; it does not modify what `/supported` says.

## References

- [`facilitator-service/src/startup.ts`](../../facilitator-service/src/startup.ts) — funding check, `upto` gate, truthfulness assertion
- [`facilitator-service/src/capability-descriptor.ts`](../../facilitator-service/src/capability-descriptor.ts) — job loading and validation, the hardcoded honesty rule
- [`facilitator-service/src/server.ts`](../../facilitator-service/src/server.ts) — `runStartupChecks`, ordered before `serve()`
- [`facilitator-service/src/__tests__/startup.test.ts`](../../facilitator-service/src/__tests__/startup.test.ts) — including the literal `upto_escrow_v1` rejection and testnet-id-on-pubnet
- [`jobs.example.json`](../../jobs.example.json) — the descriptor job format
- [ADR-010](./adr-010-conformance-as-acceptance.md) — the harness check that fails if any scheme lacks a deployed contract

# ADR-011: `upto` - A Settlement Contract Shaped by the Scheme, the Platform, and Our Own Architecture

## Status

Accepted (2026-08-23) - records the design of our Soroban `upto` settlement contract: the constraints that shape it, the two properties our architecture requires, and what we do not yet claim.

Supersedes the `upto_escrow.rs` design in [spec-v2.md §4](../specifications/spec-v2.md).

## Context

The RFP asks respondents to author `scheme_upto_stellar.md` and implement it. Several teams doing that in parallel is not a failure of the process - it is the process. A standards body given competing drafts picks or synthesizes; a standards body given one draft rubber-stamps. We are bidding, and the `upto` scheme is one of the deliverables we are bidding on.

Our starting position was weak, and pretending otherwise would have produced a worse contract. The previous implementation was 398 lines with 5 tests and these defects:

| Defect                                        | Consequence                                                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `buyer.require_auth()`                      | Authorized*the invocation*, not the terms. A facilitator could redirect the recipient or raise the ceiling |
| `initialize` + admin storage                | A privileged party per deployment, for no purpose                                                            |
| No facilitator authorization                  | The party choosing the amount signed nothing                                                                 |
| No balance invariants                         | A fee-taking or rebasing token would silently shortchange the recipient                                      |
| Direct`token.transfer` of the actual amount | No allowance lifecycle, so nothing proved the authorization was fully consumed                               |
| soroban-sdk 22.0.0                            | Four majors behind the ecosystem                                                                             |

We rebuilt it from the two things that actually constrain the design: what the `upto` scheme requires, and what the Soroban authorization model provides.

**The platform shapes most of the answer.** Soroban exposes `require_auth_for_args` precisely so an authorization can be bound to argument values rather than to the fact of a call - which is the mechanism the scheme's recipient-binding requirement calls for, and the reason a bare `require_auth()` cannot satisfy it. SEP-41's `approve` / `transfer_from` / `allowance` triple is what makes a capped pull provable: request the ceiling, spend from it, and assert the allowance is zero afterwards. Statelessness follows from the RFP's own instruction that no deployment should have a privileged operator. Balance invariants are ordinary defensive practice against tokens that do not behave as their interface claims.

These are convergent answers, not novel ones. Any competent implementation of a capped Soroban settlement arrives at roughly this shape because the SDK's API and the scheme's requirements leave little room - which is a good sign for the scheme, and the reason we expect independent implementations to interoperate.

As due diligence we also surveyed existing Stellar x402 work before committing to a design, which is what any team should do before writing a contract that moves money. That survey informed our confidence that these patterns are where the ecosystem is converging, and it sharpened our view of where the remaining open questions are. The two sections below are those open questions, and they are the parts of this design that come from our own architecture rather than from the platform.

## Decision

**Implement what the platform and the scheme require, then add the two properties our federated architecture depends on.**

### 1. What the platform and the scheme require

- **`require_auth_for_args` over all eight terms** - recipient, token, ceiling, `valid_after`, `deadline`, facilitator, settlement id, request digest. A signed authorization does not cover any variant of itself.
- **Stateless except the replay guard.** No `initialize`, no admin, no upgrade path, no configuration. Every operator deploys their own instance and no instance has a privileged party.
- **Atomic pull, pay, refund.** The contract approves the full ceiling to itself, pulls it, pays `actual`, refunds the remainder, then asserts the allowance is zero and balances moved by exactly `actual` and nothing else.
- **soroban-sdk 26.1.1**, with a pinned `rust-toolchain.toml` so the wasm hash is reproducible.

### 2. Property one - replay is enforced in the contract, for every payer

`(payer, settlement_id)` is recorded in contract storage before any value moves.

Soroban's auth-entry nonce prevents replay for a payer using a classic keypair. It does not extend the same guarantee to a payer authenticating through a custom `__check_auth`, whose deduplication behaviour is that account's own business - and smart accounts are exactly the payer this scheme is designed for. Placing the guarantee anywhere outside the settlement contract makes it conditional on the payer's account implementation.

Putting the guard in the settlement contract makes the property hold for every payer regardless of how they authenticate. The entry's TTL is bounded by `deadline`, so it costs no rent beyond the window it protects.

### 3. Property two - the ledger records what was charged, and for what

The payer signs before the work happens, so it cannot commit to a result it has not seen. It commits to the **request digest** - which job it is paying for. The facilitator then signs the half the payer could not:

```rust
terms.facilitator.require_auth_for_args(
    (terms.settlement_id.clone(), attestation.actual, attestation.result_digest.clone())
        .into_val(&env),
);
```

Both digests and the actual amount land in the settlement event. The consequence is that **the amount charged and the work it was charged for are on the ledger, signed by the party that chose them** - not in a facilitator's own log.

This is the property `upto` needs most and `exact` does not need at all. In `exact` the amount is fixed by the payment requirements; in `upto` the facilitator picks it. Everything else in this contract bounds *how much* it can pick. This makes the pick itself attributable and permanently checkable, and it makes an [`x402job/1` receipt](./adr-006-recomputable-receipts.md) covering the same digests verifiable against the chain by anyone.

It also serves [ADR-001](./adr-001-discovery-federation.md) directly: a federated catalog confirming an `upto` settlement reads amount, recipient, and job identity from the event without trusting the facilitator that submitted it. A design where the catalog and the facilitator share a trust domain has no need for this. Ours does, because they do not.

### 4. What the tests establish

27 tests. The ones that matter are not the movement tests:

- `the_payer_authorization_covers_every_term` asserts the recorded authorization args equal all eight terms, and that the token approval is **nested** under it, so the signature cannot authorize a standalone allowance.
- `an_authorization_for_one_recipient_cannot_pay_another`, `..._cannot_settle_a_larger_one`, `..._cannot_settle_another` grant authorization for exact terms via `mock_auths` and then present different terms. All fail.
- `the_facilitator_cannot_charge_more_than_it_attested` does the same for the facilitator's half.
- `a_granted_authorization_settles` is the control: the same grant, used as issued, succeeds. Without it the four negatives could be passing because the grant is malformed rather than because the binding works.

The rest of the suite runs under `mock_all_auths`, which approves everything and therefore proves nothing about authorization - stated in a comment in the file so no one later mistakes coverage for assurance.

### 5. What we do not claim

- **Not audited.** [ADR-005](./adr-005-advertise-only-what-is-verified.md)'s gate keeps `upto` off `/supported` on every network until a contract is confirmed on-chain, so this needs no additional safeguard to be safe.
- **No wasm artifact yet.** It compiles and tests natively; the `wasm32v1-none` build needs the pinned rustup toolchain, which this workstation does not have. No hash is published until it builds reproducibly.
- **Not deployed, not integrated end to end.**

### 6. Upstream posture

We contribute `scheme_upto_stellar.md` and this implementation to the x402 Technical Steering Committee, and we expect other Stellar implementations to be contributed alongside it. That is how a scheme with no network specification should get one.

The two properties above are what we argue for on their merits, whichever base design the committee converges on: they are useful to any facilitator, not only ours. Where a converged design emerges, we implement it. Contributing a draft is not the same as insisting on it.

## Consequences

**Good**

- We own the §3.4 deliverable rather than ceding it, which is the point of bidding.
- Two properties that are genuinely ours: contract-level replay covering smart-account payers, and on-ledger attribution of the discretionary amount to the facilitator that chose it.
- The design is coherent with the rest of our architecture rather than borrowed into it. The federated catalog can verify `upto` settlements because the event was designed for that.
- Studying prior art before building produced a materially better contract than our own previous attempt: term binding, statelessness, allowance lifecycle, and balance invariants all came from that reading.
- 27 tests including five that specifically establish the binding, with a control that keeps them honest.

**Costs accepted**

- **More than one Stellar `upto` draft will reach the committee.** That means more review work upstream, and possibly more than one audit before the ecosystem converges. It is the normal cost of a competitive round and we are choosing to pay it.
- **This is an early-stage contract.** No deployment, no published wasm hash, no threat model document, and no independent audit. Other work in this space is further along on all four, and will remain so until we deploy and get reviewed.
- **The facilitator attestation adds a signature to every settlement.** Slightly more work for the facilitator and a slightly larger auth tree, in exchange for the attribution property.
- **The replay guard is the only state**, so a settlement writes a ledger entry and pays rent for it. Bounded by the deadline, and it is the price of the guarantee holding for smart-account payers.
- **The committee may converge on a different base design**, and we would then implement that, having spent the effort on ours.

**Deliberately not done**

- **No settlement hooks.** A hook is a call into untrusted code from inside a settlement, and it is the largest attack surface such a contract can have. We have no use case that needs one. If one arrives, it ships with invariants re-verified after the hook returns, not before.
- **No contract-free `upto`.** SEP-41 allowances alone cannot enforce recipient binding or single settlement.
- **No admin, no upgradeability.** A settlement contract that can be upgraded is a settlement contract whose terms can be changed after you sign them.
- **No `batch-settlement` or `auth-capture`.** The RFP defers both.

## References

- [`contracts/upto-settlement/src/lib.rs`](../../contracts/upto-settlement/src/lib.rs) - the contract
- [`contracts/upto-settlement/src/test.rs`](../../contracts/upto-settlement/src/test.rs) - 27 tests, and the comment on what `mock_all_auths` does not prove
- [`docs/specifications/scheme_upto_stellar.md`](../specifications/scheme_upto_stellar.md) - the wire specification to contribute
- [Soroban `require_auth_for_args`](https://developers.stellar.org/docs/build/guides/auth) - the platform mechanism §1 relies on
- [SEP-41](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0041.md) - the token interface the allowance lifecycle is built on
- [ADR-005](./adr-005-advertise-only-what-is-verified.md) - why an unaudited scheme cannot be advertised
- [ADR-006](./adr-006-recomputable-receipts.md) - the receipt the digest binding makes chain-verifiable
- [ADR-001](./adr-001-discovery-federation.md) - the federated catalog the settlement event is shaped for
- RFP §3.4 - the `upto` deliverable and the contract-free warning

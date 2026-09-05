# Stellar `upto` payment scheme for x402 v2

**Status:** Draft for the x402 Technical Steering Committee
**Networks:** `stellar:testnet`, `stellar:pubnet`
**Scheme identifier:** `upto`
**Reference implementation:** [`contracts/upto-settlement`](../../contracts/upto-settlement)
**Reference deployment:** [`CAHV6TIAOVSICUJHI6OBZSW2N5ZKRPGKHE2SH6OAEJHPHCLF5DXWAGG2`](https://stellar.expert/explorer/testnet/contract/CAHV6TIAOVSICUJHI6OBZSW2N5ZKRPGKHE2SH6OAEJHPHCLF5DXWAGG2) on `stellar:testnet`, wasm SHA-256 `c157c24c6d8e90267230932a6d1f88e04e0343e6e8d3df6836ad60c8c9972959`

## Purpose

The `exact` scheme settles a price fixed before the work happens. Metered
services cannot use it, because the cost of a request is not known until the
request has been served. Token billing, compute time and per-row query pricing
all have this shape.

`upto` lets a payer authorize a ceiling and lets the facilitator settle the
amount actually used, with the remainder returned in the same transaction.

The discretion over the final amount sits with the facilitator. Every property
in this document exists to bound that discretion or to make its exercise
publicly attributable.

## Why this needs a contract

SEP-41 allowances alone are insufficient, and a contract-free design must
explicitly declare that limitation.

An `approve` grants a spender an amount. It does not bind that spender to a
particular recipient, so a facilitator holding an allowance may transfer to
anyone. It does not bind the authorization to a single settlement, so an
allowance that is not fully consumed remains spendable afterwards. It carries no
notion of a refund, so the unused remainder is not returned atomically.

The recipient binding and single-settlement guarantees the scheme requires are
therefore enforced by a settlement contract.

## Requirements

A conforming implementation MUST satisfy the following.

1. **Ceiling.** The settled amount MUST be at most the authorized `max_amount`.
   Zero is a valid settled amount and is terminal.
2. **Recipient binding.** The payer's authorization MUST cover the recipient. A
   facilitator MUST NOT be able to redirect the payment.
3. **Single settlement.** An authorization MUST settle at most once, for every
   payer, regardless of how that payer authenticates.
4. **Atomic refund.** `max_amount - actual` MUST return to the payer in the same
   transaction that pays the recipient.
5. **Bounded validity.** The authorization MUST be valid only within a ledger
   range.
6. **Attributable amount.** The facilitator MUST authorize the amount it charges,
   so the choice is recorded on-ledger rather than only in the facilitator's own
   logs.
7. **No privileged party.** The settlement contract MUST NOT have an
   administrator, an upgrade path, or any configuration that a deployer controls
   after deployment.

## Authorization and invocation shape

### Contract interface

```
settle(payer: Address, terms: PayerTerms, attestation: FacilitatorAttestation) -> Settlement
is_settled(payer: Address, settlement_id: BytesN<32>) -> bool
```

`settle` is the only state-changing entry point. There is no `initialize`.

### What the payer authorizes

```
PayerTerms {
    pay_to:         Address       // the recipient
    token:          Address       // SEP-41 token contract
    max_amount:     i128          // the ceiling, strictly positive
    valid_after:    u32           // first ledger at which this may settle
    deadline:       u32           // last ledger at which this may settle
    facilitator:    Address       // the only party that may settle it
    settlement_id:  BytesN<32>    // unique per authorization, per payer
    request_digest: BytesN<32>    // digest of the request being paid for
}
```

The payer's authorization is taken with `require_auth_for_args` over all eight
fields:

```
payer.require_auth_for_args(
    (pay_to, token, max_amount, valid_after, deadline,
     facilitator, settlement_id, request_digest)
)
```

This is the mechanism that satisfies requirement 2. A bare `require_auth()`
authorizes the invocation rather than the terms, and a facilitator holding such
an authorization could vary the recipient or the ceiling. Implementations MUST
bind the arguments.

`request_digest` binds an authorization to one job. It prevents a facilitator
reusing a signed authorization for different work, and it is the payer's half of
requirement 6.

### What the facilitator attests

```
FacilitatorAttestation {
    settlement_id:  BytesN<32>    // MUST equal terms.settlement_id
    actual:         i128          // the amount charged, 0 <= actual <= max_amount
    result_digest:  BytesN<32>    // digest of the result delivered
}
```

```
facilitator.require_auth_for_args((settlement_id, actual, result_digest))
```

The payer signs before the work exists and therefore cannot commit to a result
it has not seen. The facilitator signs the half the payer cannot: what it
delivered, and what it is charging for it. Together these satisfy requirement 6,
and they are why `actual` is deliberately absent from the payer's signed
argument list.

### Auth tree

The payer's authorization has exactly one sub-invocation, the token `approve`:

```
payer → settle(pay_to, token, max_amount, valid_after, deadline,
               facilitator, settlement_id, request_digest)
        └── token.approve(payer, settlementContract, max_amount, deadline)

facilitator → settle(settlement_id, actual, result_digest)
```

Nesting the approval under the payer's authorization means that signature cannot
authorize a standalone allowance.

## Contract invariants

A conforming contract MUST enforce all of the following, and MUST fail the whole
invocation atomically if any does not hold.

1. `max_amount > 0`, `actual >= 0`, `actual <= max_amount`.
2. `attestation.settlement_id == terms.settlement_id`.
3. `valid_after <= deadline`, and the current ledger is within `[valid_after, deadline]` inclusive.
4. The payer is neither the facilitator nor the settlement contract; the
   recipient and the token are not the settlement contract.
5. `(payer, settlement_id)` has not settled before. It is recorded in contract
   storage before any value moves.
6. The allowance the contract requested is exactly `max_amount`, and is exactly
   zero after the pull.
7. Balances move by exactly `actual` and nothing else. The payer's balance
   decreases by `actual`, the recipient's increases by `actual`, and the
   contract's is unchanged. Where payer and recipient are the same account, that
   account's balance is unchanged.

### On replay protection

Soroban's auth-entry nonce prevents replay for a payer using a classic keypair.
It does not extend that guarantee to a payer authenticating through a custom
`__check_auth`, whose deduplication behaviour is that account's own business.

Smart accounts are the payer this scheme is designed for, so requirement 3 cannot
rest on the host nonce alone. Implementations MUST record `(payer, settlement_id)`
in contract storage. The entry's time to live SHOULD be bounded by `deadline`,
so the guard costs no rent beyond the window it protects.

`is_settled(payer, settlement_id)` exposes the guard for clients that want to
check before signing.

## Settlement flow

The contract pulls the full ceiling and pays out of it, rather than transferring
`actual` directly. This is what makes the allowance provably consumed:

1. Record `(payer, settlement_id)` as settled.
2. Capture the payer, recipient and contract balances.
3. `approve(payer, contract, max_amount, deadline)`, then assert the allowance equals `max_amount`.
4. `transfer_from(contract, payer, contract, max_amount)`.
5. If `actual > 0`, `transfer(contract, pay_to, actual)`.
6. If `max_amount - actual > 0`, `transfer(contract, payer, max_amount - actual)`.
7. Assert the allowance is zero, and assert the balance invariants in §7 above.

Step 7 is what defends against a token that does not behave as its interface
claims. A fee-taking or rebasing token breaks the equalities rather than quietly
shortchanging the recipient.

## The settlement event

```
Settled {
    payer:          Address     // topic
    pay_to:         Address     // topic
    settlement_id:  BytesN<32>  // topic
    token:          Address
    facilitator:    Address
    max_amount:     i128
    actual:         i128
    refunded:       i128
    request_digest: BytesN<32>
    result_digest:  BytesN<32>
}
```

The event carries every field an independent verifier needs to confirm what
happened without trusting the facilitator that submitted it. This matters for a
federated catalog, which must be able to confirm an `upto` settlement it did not
perform. Topics allow an indexer to subscribe by payer, recipient or settlement.

Implementations SHOULD emit an event of this shape. A verifier that can read
only the amounts, and not the digests, cannot tie a settlement to the work it
paid for.

## Facilitator behaviour

On `/verify`, a facilitator MUST confirm that the terms are internally
consistent, that the current ledger is within the validity window, that the
payer's authorization covers all eight terms, and that
`is_settled(payer, settlement_id)` is false.

On `/settle`, the facilitator supplies `actual` and `result_digest`, signs the
attestation, and submits. It MUST NOT substitute `max_amount` for `actual`, and
it MUST NOT settle an authorization whose `request_digest` does not correspond to
the work it performed.

A facilitator advertising this scheme on `/supported` MUST carry the deployed
contract address:

```json
{
  "x402Version": 2,
  "scheme": "upto",
  "network": "stellar:testnet",
  "extra": { "contractId": "C..." }
}
```

Clients MUST read `extra.contractId` rather than assuming one. Each operator
deploys their own instance, and because the contract is stateless with no
privileged party, instances of the same wasm are behaviourally identical.

A facilitator SHOULD confirm the contract exists on-chain at the configured
address before advertising the scheme, and SHOULD additionally verify that the
deployed wasm hash matches the audited artifact. Confirming an address exists
proves something is deployed; it does not prove what.

## Rejection reasons

Every rejection MUST carry a non-null machine-readable reason. The reference
implementation returns these contract errors:

| Error | Meaning |
| --- | --- |
| `InvalidMaximum` | `max_amount` is not strictly positive |
| `NegativeActual` | `actual` is negative |
| `ActualExceedsMaximum` | `actual` exceeds the authorized ceiling |
| `InvalidTimeWindow` | `valid_after` is after `deadline` |
| `NotYetValid` | The current ledger precedes `valid_after` |
| `Expired` | The current ledger is past `deadline` |
| `InvalidPayer` | The payer is the facilitator or the contract |
| `InvalidRecipient` | The recipient is the contract |
| `InvalidToken` | The token is the contract |
| `AlreadySettled` | This `(payer, settlement_id)` has settled, or the attestation names a different settlement |
| `UnexpectedAllowance` | The token did not grant the requested allowance |
| `AllowanceNotConsumed` | The allowance was not fully consumed |
| `BalanceInvariantViolated` | Balances did not move by exactly the settled amounts |
| `ArithmeticOverflow` | An arithmetic operation overflowed |

## Conformance vectors

An implementation claiming conformance SHOULD demonstrate all of these, and the
reference implementation covers each in
[`test.rs`](../../contracts/upto-settlement/src/test.rs).

| Vector | Expectation |
| --- | --- |
| Partial settlement | `actual < max_amount`; recipient credited `actual`, payer refunded the remainder, contract balance zero |
| Full settlement | `actual == max_amount`; no refund |
| Zero settlement | `actual == 0`; nothing paid, everything refunded, authorization consumed |
| Every amount in range | Invariants hold for each `actual` from 0 to `max_amount` |
| Payer equals recipient | The account's balance is unchanged |
| Replay | A second settlement of the same `(payer, settlement_id)` fails |
| Redirected recipient | An authorization for one `pay_to` cannot settle to another |
| Inflated ceiling | An authorization for one `max_amount` cannot settle a larger one |
| Different request | An authorization for one `request_digest` cannot settle another |
| Inflated charge | A facilitator cannot charge more than it attested |
| Window boundaries | `valid_after` and `deadline` are inclusive |
| Underfunded payer | Fails atomically, and the authorization remains usable |

## Composition with smart account policies

Because the payer's authorization is taken over explicit argument values, a
Stellar smart account implementing `__check_auth` can apply a policy to those
arguments directly: a per-recipient ceiling, a rolling budget, an allowlist of
tokens, or a cap on `max_amount` per settlement.

The account sees the terms it is being asked to authorize, not merely that a call
is being made. This is the composition that makes bounded pull payments possible on Soroban, and it is a further
reason the argument binding in §"What the payer authorizes" is required rather
than recommended.

Note that a policy which reserves `max_amount` at authorization time should
reconcile against `actual` when the settlement event is observed, since the
difference is refunded.

## Deployment gate

This scheme is a draft. Until the Technical Steering Committee accepts an ABI
and a security review is complete, an implementation SHOULD advertise `upto` on
testnet only, and SHOULD refuse to advertise it at all when no contract is
confirmed on-chain for the network being served.

Network-specific configuration is recommended, so that a testnet contract address
cannot be inherited by a mainnet deployment.

## Open questions for the committee

1. **Event shape.** Should the settlement event be normative rather than
   recommended? A federated catalog cannot verify a settlement it did not perform
   without one.
2. **Digest algorithm.** This document does not mandate how `request_digest` and
   `result_digest` are computed. The reference implementation uses SHA-256 over
   RFC 8785 canonical JSON, matching the `x402job/1` receipt format, so a receipt
   and a settlement can be checked against each other.
3. **Refund destination.** The remainder returns to the payer. Whether a distinct
   refund address is ever useful is unresolved.
4. **Multiple settlements against one authorization.** Deliberately forbidden
   here. A streaming variant would need a different scheme rather than a relaxed
   `upto`.

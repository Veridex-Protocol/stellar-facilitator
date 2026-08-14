# Stellar `upto` payment scheme for x402 v2

**Status:** draft — not advertised or deployed until the release gates below pass

**Network family:** `stellar:*`

**Scheme identifier:** `upto`
**Authoritative architecture:** [architecture.md](../architecture.md#7-upto-metered-settlement-with-one-payer-signature)

## Purpose

`upto` lets a payer authorize one resource payment with a maximum amount while
the resource server settles the measured amount. The payer signs the maximum,
not the final amount. Settlement transfers only the measured integer amount,
bounded by that maximum, directly from payer to recipient.

This is intentionally not an escrow protocol. The settlement contract never
holds funds, has no admin or withdrawal path, and does not maintain a persistent
nonce table. Replay protection comes from the Soroban host's consumed
authorization-entry nonce.

## Requirements

An `upto` requirement uses the standard x402 v2 fields:

```json
{
  "scheme": "upto",
  "network": "stellar:testnet",
  "asset": "C...",
  "amount": "1000000",
  "payTo": "G...",
  "maxTimeoutSeconds": 60,
  "extra": {
    "contractId": "C...",
    "deadlineLedger": 123456,
    "areFeesSponsored": true
  }
}
```

`amount` is the maximum amount in atomic units. `asset` and `extra.contractId`
are valid Stellar contract addresses. `deadlineLedger` is bounded by the
facilitator's configured maximum authorization lifetime.

## Authorization and invocation shape

The payment transaction contains exactly one `invokeHostFunction` operation
targeting the advertised `upto` contract and calling:

```text
settle(payer, token, payTo, maxAmount, actualAmount, liveUntilLedger)
```

The payer's signed authorization tree has one root and one allowed subcall:

```text
root: settle(token, payTo, maxAmount) on UptoSettlement
  └─ sub: approve(payer, UptoSettlement, maxAmount, liveUntilLedger) on token
```

The root is created with `require_auth_for_args((token, payTo, maxAmount))`.
`actualAmount` is deliberately not in the signed argument list. It is supplied
at settlement and the contract rejects it unless `0 <= actualAmount <=
maxAmount`. `liveUntilLedger` is authorized through the `approve` subcall, and
the facilitator requires it to be no later than the auth-entry expiration.

The resulting allowance is usable only by the settlement contract, which still
requires a fresh payer authorization to establish it. The residual allowance
therefore expires unused and is not a reusable seller allowance.

## Contract invariants

The deployed contract must enforce all of the following:

1. `payTo`, `token`, and `maxAmount` are covered by the payer's root signature.
2. `actualAmount` is an integer with `0 <= actualAmount <= maxAmount`.
3. The direct payout is `transfer_from(settlementContract, payer, payTo, actualAmount)`;
   the contract never receives or stores a token balance.
4. The allowance is exactly `maxAmount`, names the settlement contract as the
   spender, and expires no later than the authorization entry.
5. The auth entry's host-managed nonce is consumed exactly once, making a signed
   authorization non-replayable without a contract nonce table.
6. A zero settlement is not submitted by a sponsoring facilitator. The unsigned
   no-op expires without consuming sponsor fees.

## Facilitator verification

The facilitator rejects a payload unless all of these hold:

1. x402 version, scheme, and CAIP-2 network match the requirement.
2. There is exactly one contract invocation and it targets the configured
   advertised `upto` contract; routers and additional operations are rejected.
3. Root token, recipient, and maximum equal `asset`, `payTo`, and `amount` in
   the payment requirement.
4. `actualAmount` is within the signed maximum. The verifier never substitutes
   `actualAmount` for the signed maximum while verifying the auth signature.
5. The auth tree contains exactly the root and `approve` subcall shown above;
   no extra sub-invocations or pending signatures are permitted.
6. The allowance spender is the configured settlement contract, its amount
   matches the root maximum, and `liveUntilLedger <= signatureExpirationLedger`.
7. The signature is valid, the auth-entry expiry is within policy, and enforcing
   simulation succeeds within configured resource and sponsor-fee ceilings.
8. Simulated effects show only the approved payer-to-`payTo` token transfer and
   expected contract events.

`/settle` independently repeats signature/tree, bound, expiry, and simulation
validation against fresh ledger state.

## Responses and conformance vectors

Successful settlement uses the standard x402 v2 response and includes the
actual atomic amount settled. Failures use stable reasons such as
`authorization_expired`, `amount_exceeds_max`, `invalid_authorization_tree`,
`unexpected_contract_target`, `allowance_expiry_invalid`, and
`simulation_failed`.

Conformance coverage must include partial, full-cap, and zero settlement;
over-cap amount; altered recipient/token/max; root containing actual amount;
unexpected operation/subcall; stale/replayed auth; allowance expiry beyond auth
expiry; failed simulation; timeout/retry idempotency; and a transaction effect
assertion that the contract never receives a token balance.

## Deployment gate

The prototype in `contracts/upto-settlement` is not this design: it signs the
actual amount with `require_auth()` and keeps persistent nonce/admin state. It
must be replaced, property-tested, independently reviewed, reproducibly built,
and demonstrated with public testnet artifacts before `upto` is added to
`/supported` or deployed on pubnet.

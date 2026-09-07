# Veridex Soroban `upto` Settlement Contract

Soroban smart contract implementing the `upto` metered payment scheme on Stellar.

---

## Overview

The `upto` scheme allows a buyer to authorize a payment up to a designated spending ceiling (`max_amount`) for a resource session. After the resource server fulfills the request, the facilitator settles the actual metered amount used (`actual <= max_amount`) on-chain.

### Contract Guarantees & Invariants

1. **Ceiling Binding**: A payer authorization for a ceiling cannot settle for a higher amount.
2. **Single-Settlement Invariant**: Each `settlement_id` can be settled exactly once.
3. **Facilitator Binding**: Settlement requires an explicit `FacilitatorAttestation` from the authorized facilitator address.
4. **Validity Window**: Settlements are strictly constrained within `[valid_after, deadline]` ledger sequences.
5. **Exact Balance Movement**: The exact `actual` amount is transferred to `pay_to`, and any unused remainder from the authorized ceiling is returned to the payer.

---

## Contract Methods

### `settle(payer, terms, attestation)`

Settles a metered session. Transfers `attestation.actual` tokens from `terms.payer` to `terms.pay_to` and emits a structured indexable event.

- **`payer`**: Address of the paying client.
- **`terms`** (`PayerTerms`):
  - `pay_to`: Recipient address.
  - `token`: SEP-41 token contract address (e.g. USDC).
  - `max_amount`: Maximum authorized spending ceiling in atomic units.
  - `valid_after`: First valid ledger sequence.
  - `deadline`: Expiration ledger sequence.
  - `facilitator`: Authorized facilitator address.
  - `settlement_id`: Unique 32-byte identifier.
  - `request_digest`: Hash of the buyer's request payload.
- **`attestation`** (`FacilitatorAttestation`):
  - `settlement_id`: Matches `terms.settlement_id`.
  - `actual`: Exact amount billed (`actual <= terms.max_amount`).
  - `result_digest`: Hash of the server's output response.

### `is_settled(payer, settlement_id)`

Returns `bool` indicating whether the payer/settlement-id pair has already been
consumed. Replay state is persistent with TTL bounded by the signed deadline.

---

## Testnet Deployment

- **Contract ID**: `CAHV6TIAOVSICUJHI6OBZSW2N5ZKRPGKHE2SH6OAEJHPHCLF5DXWAGG2`
- **Explorer Link**: [Stellar Expert Testnet Contract](https://stellar.expert/explorer/testnet/contract/CAHV6TIAOVSICUJHI6OBZSW2N5ZKRPGKHE2SH6OAEJHPHCLF5DXWAGG2)

---

## Development & Testing

### Run Rust Invariant Tests
```bash
cargo test --locked
```
All 27 invariant and edge-case unit tests will execute against the Soroban Rust test environment.

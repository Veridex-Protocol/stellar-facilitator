# `upto` settlement contract: testnet deployment

Everything here is checkable without our cooperation. The contract id and the wasm hash are on the public ledger; the hash is reproducible from this source tree with the pinned toolchain.

## Frozen artifact

| Item | Value |
| --- | --- |
| Network | `stellar:testnet` |
| Contract ID | `CAHV6TIAOVSICUJHI6OBZSW2N5ZKRPGKHE2SH6OAEJHPHCLF5DXWAGG2` |
| WASM SHA-256 | `c157c24c6d8e90267230932a6d1f88e04e0343e6e8d3df6836ad60c8c9972959` |
| WASM size | 17,144 bytes |
| Upload transaction | `7def6c0f327e280591b0baa21278218cc4d7d715dbe13f38a61b130557c91a39` |
| Deploy transaction | `5f4dd6c625b31aa3f0b7d0c2943db23c4a14746d2abaaae9b938e3e4b345dc24` |
| Rust toolchain | 1.96.1, target `wasm32v1-none` |
| soroban-sdk | 26.1.1 (pinned exact) |
| Explorer | [stellar.expert](https://stellar.expert/explorer/testnet/contract/CAHV6TIAOVSICUJHI6OBZSW2N5ZKRPGKHE2SH6OAEJHPHCLF5DXWAGG2) |

The contract has no admin, no `initialize`, and no upgrade path. Its only state
is the `(payer, settlement_id)` replay guard, whose TTL is bounded by each
authorization's own deadline.

## Reproduce the artifact

```bash
cd contracts/upto-settlement
rustup toolchain install 1.96.1 --profile minimal
rustup target add wasm32v1-none --toolchain 1.96.1
cargo +1.96.1 build --release --target wasm32v1-none
shasum -a 256 target/wasm32v1-none/release/upto_settlement.wasm
```

The digest must equal the hash above. It is byte-identical across rebuilds on the pinned toolchain verified before deployment, and the reason the toolchain is pinned at all.

## Confirm what is actually deployed

```bash
stellar contract info interface \
  --id CAHV6TIAOVSICUJHI6OBZSW2N5ZKRPGKHE2SH6OAEJHPHCLF5DXWAGG2 \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015"
```

The facilitator performs the equivalent check at boot: `resolveUptoGate` confirms a contract instance exists at the configured id on the configured network before the `upto` scheme appears on `/supported` at all. With no contract configured, the boot log reads:

```
upto not advertised: no upto contract configured for testnet
```

and with this one configured:

```
upto contract confirmed at CAHV6TIAOVSICUJHI6OBZSW2N5ZKRPGKHE2SH6OAEJHPHCLF5DXWAGG2
facilitator ready ... schemes: ["exact","upto"]
```

## Deploy your own instance

Nothing requires you to use ours, and no contract id ships as a default. The
contract has no privileged party or mutable configuration; its only state is the
bounded replay guard described above. An operator can deploy the same frozen
WASM independently:

```bash
npm run upto:build      # reproducible wasm
npm run upto:deploy     # upload + instantiate on your account
```

Then set `UPTO_ESCROW_CONTRACT_ID_TESTNET` to the id printed, and restart. The facilitator will confirm it on-chain before advertising it.

`UPTO_ESCROW_CONTRACT_ID_PUBNET` is read separately and is never inherited from the testnet variable, so a mainnet deployment cannot silently advertise a testnet contract.

## Status

Deployed and boot-gated. **Not audited**, and no production use is intended until it is. The scheme is advertised on testnet only.

# Upstream Stellar `upto` Contribution Packet

Status: **not submitted** as of 2026-09-05.

This packet separates the local Veridex implementation from upstream stock `@x402/stellar` interoperability.

## Verified upstream boundary

The installed `@x402/stellar@2.21.0` package exports:

- `@x402/stellar/exact/client`
- `@x402/stellar/exact/server`
- `@x402/stellar/exact/facilitator`

It does not export a Stellar `upto` client, server, or facilitator scheme. The current Veridex implementation therefore uses isolated local adapters:

- buyer: [`sdk-typescript/src/upto-client.ts`](../../../sdk-typescript/src/upto-client.ts)
- seller: [`demo-server/src/upto-server.ts`](../../../demo-server/src/upto-server.ts)
- facilitator: [`facilitator-service/src/stellar/upto-scheme.ts`](../../../facilitator-service/src/stellar/upto-scheme.ts)

The adapter uses the existing x402 v2 `SchemeNetworkClient` and `SchemeNetworkServer` extension points. It does not fork or replace exact primitives.

## Proposed upstream contribution

1. Add a shared `UptoStellarScheme` client/server/facilitator implementation to the appropriate upstream Stellar package.
2. Add a stable Stellar `upto` wire specification covering the contract ABI, payer auth, facilitator attestation, request/result digests, usage override, replay, and failure semantics.
3. Add conformance fixtures for:
   - facilitator-sourced transaction;
   - payer-only auth in the HTTP payment payload;
   - response-dependent facilitator auth;
   - partial, zero, maximum, over-cap, replay, wrong recipient, wrong request digest, and expiry cases;
   - result digest and signed usage binding.
4. Add package exports and README examples without changing the exact scheme API.

## Wire fixture

The local fixture below is intentionally descriptive rather than a reusable secret-bearing payment. It records the expected v2 semantics:

```json
{
  "x402Version": 2,
  "accepted": {
    "scheme": "upto",
    "network": "stellar:testnet",
    "asset": "<SEP-41 contract C...>",
    "amount": "100000",
    "payTo": "<G...>",
    "maxTimeoutSeconds": 120,
    "extra": {
      "contractId": "<C...>",
      "facilitator": "<G...>",
      "areFeesSponsored": true,
      "requestDigest": "sha256:<64 hex>"
    }
  },
  "payload": {
    "transaction": "<facilitator-sourced transaction XDR with payer auth>"
  }
}
```

After the seller responds, the resource server applies:

```json
{
  "Settlement-Overrides": "{\"amount\":\"25000\"}"
}
```

The scheme enrichment adds `resultDigest: "sha256:<64 hex>"` to the facilitator settle payload. The facilitator rebuilds the invocation with the actual amount, signs its attestation, assembles the signed-auth footprint, and submits the transaction.

## Local evidence

- Clean-room exact/direct `upto` conformance: `36/36`.
- Custom HTTP `upto`: transaction `371ca4d796e3c961257e1ec0c759cc60159900e50c5b33b3b986f67446f30be0`, successful at testnet ledger `4515766`.
- Upstream package surface inspection: `@x402/stellar@2.21.0`, exact exports only.

No upstream issue or pull request has been opened yet. This packet must not be read as upstream acceptance.

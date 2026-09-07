# Gateway testnet proof - 2026-09-07

**Scope:** Clean local Compose stack, controlled existing API, Veridex Gateway,
existing facilitator, Bazaar, provider outcome, and browser Playground on
`stellar:testnet`.

## Result

```text
GET existing /demo-api/hello
-> GET gateway /hello
-> HTTP 402 PAYMENT-REQUIRED
-> browser-local Ed25519 authorization
-> facilitator verify
-> facilitator settle
-> confirmed Stellar transaction
-> gateway forwards GET /demo-api/hello
-> original API JSON
-> signed provider outcome
-> durable payment/provider events
-> Bazaar resource admission and revalidation
```

| Field | Evidence |
|---|---|
| Gateway URL | `http://localhost:3205` |
| Resource | `http://localhost:3205/hello` |
| Upstream | `http://demo-server:3003/demo-api/hello` |
| Scheme | `exact` |
| Network | `stellar:testnet` |
| Asset | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |
| Authorized/settled amount | `100000` atomic units (`0.01 XLM`) |
| Payer | `GDBH75ZCO3NCHWDAX7EH4WRNDJMM4WGSLC5KJBVHZWRKXXBXQX25C4HB` |
| PayTo | `GAECPJ5QZEUX7PN3MQA5WEHTTYD6ZSC3UHADG6LEHWW3X3D4FXUAAAR5` |
| Transaction | `56fe0647aa9f6211f1e1720873e9f5e54d46ffff638b195175912f67f7574c05` |
| Ledger | `4554582` |
| Horizon success | `true` |
| Horizon fee charged | `20644` stroops |
| End-to-end Playground time | `36.4s` including funding/RPC/Horizon/Bazaar waits |

Horizon independently returned the same transaction hash, ledger, success
state, and fee. Bazaar returned one HTTP catalog row with service name
`Gateway Hello API`, `GET` method, exact network/payee identity, and the declared
output example. Facilitator outbox metrics returned pending `0` after delivery.

The provider outcome was signed by the seller/payee, bound to the gateway
resource and response digest, and reported `usable: true`,
`providerAtFault: false`, `reasonCode: "ok"`. Bazaar stored it as `in_band`
evidence and attached the same settlement transaction hash.

## Limits

This proves one exact testnet path. It does not prove pubnet, production TLS,
managed developer authentication, multi-instance idempotency, arbitrary
upstreams, credential injection, generic `upto`, refunds, or external security
review.
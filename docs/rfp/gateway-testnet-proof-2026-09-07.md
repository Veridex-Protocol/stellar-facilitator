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
| Payer | `GCKNH2XOVQ3T6IHJRPFN4M6JSNIOMRXZZD2TAMIOOWQL6MYAW52D6QRJ` |
| PayTo | `GAECPJ5QZEUX7PN3MQA5WEHTTYD6ZSC3UHADG6LEHWW3X3D4FXUAAAR5` |
| Transaction | `060730898ee9a579d3a22ebbbbe59a3320f315828bf017b2522eec3cb9900e51` |
| Ledger | `4553830` |
| Horizon success | `true` |
| Horizon fee charged | `20644` stroops |
| End-to-end Playground time | `30.9s` including funding/RPC/Horizon/Bazaar waits |

Horizon independently returned the same transaction hash, ledger, success
state, and fee. Bazaar returned one HTTP catalog row with service name
`Gateway Hello API`, `GET` method, exact network/payee identity, and the declared
output example. Facilitator outbox metrics returned pending `0` after delivery.

The provider outcome was signed by the seller/payee, bound to the gateway
resource and response digest, and reported `usable: true`,
`providerAtFault: false`, `reasonCode: "ok"`.

## Limits

This proves one exact testnet path. It does not prove pubnet, production TLS,
managed developer authentication, multi-instance idempotency, arbitrary
upstreams, credential injection, generic `upto`, refunds, or external security
review.
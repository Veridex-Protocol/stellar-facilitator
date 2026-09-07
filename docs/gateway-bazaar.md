# Gateway and Bazaar

Gateway routes use the existing x402 Bazaar declaration. There is no
gateway-specific catalog.

```text
gateway route configuration
-> PaymentRequired.extensions.bazaar
-> buyer echoes declaration in PaymentPayload
-> confirmed facilitator settlement
-> durable facilitator catalog outbox
-> Bazaar admission
-> live 402 revalidation
```

Payment does not depend on Bazaar availability. Immediate settlement may report
queued catalog work; search visibility is asynchronous.

The resource identity uses public gateway base URL, route/template, `exact`,
and `stellar:testnet`. Query values are excluded. Bazaar independently checks
the settlement, payee, asset, amount, scheme, network, and live gateway 402.
Unexpected term changes cause ordinary catalog quarantine/soft removal during
asynchronous revalidation.

The local Compose map routes public `http://localhost:3005` identities to the
internal `http://gateway:3005` transport only for development revalidation.
Production operators must explicitly allow the public gateway origin.
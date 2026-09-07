# Gateway Playground

The Playground **API Gateway** workspace drives a real testnet path:

```text
controlled existing API
-> gateway health and 402
-> browser-local ephemeral Stellar signer
-> facilitator verify and settle
-> gateway forwards original request
-> original API response
-> Horizon transaction confirmation
-> Bazaar lookup
-> signed provider outcome when configured
```

The public form is intentionally read-only. Its upstream is the repository's
`/demo-api/hello` route and the gateway endpoint is `/hello`. Arbitrary internet
targets and public gateway creation are not available.

The result view shows scheme, network, asset, authorized/settled amount, payer,
`payTo`, transaction hash, ledger, upstream response, Bazaar status, provider
outcome, and an external Stellar explorer link. Missing Bazaar visibility is
shown as queued, never faked as indexed.

`exact` is active. Generic `upto`, managed gateway creation, MCP-triggered
gateway payment, and passkey-backed Stellar signing are not claimed by this
workspace. The existing ephemeral testnet signer remains client-side; no
private key reaches the Playground server.
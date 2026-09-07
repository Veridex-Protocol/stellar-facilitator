# Payment response and proof

A successful HTTP response can carry several distinct evidence objects. Do not
merge their meanings.

## x402 `PAYMENT-RESPONSE`

The HTTP header is base64 JSON containing a `SettleResponse`:

```json
{
  "success": true,
  "transaction": "<Stellar transaction hash>",
  "network": "stellar:testnet",
  "payer": "<payer address>",
  "amount": "<actual atomic amount when supplied>"
}
```

This is the x402 transport settlement result. It proves what the resource server
reports the facilitator returned; independently verify the transaction before
using it as final ledger evidence.

## Veridex `x402job/1` receipt

Veridex may add a custom `receipt` object to the facilitator JSON response after
a successful settlement. It is not the upstream offer-receipt extension and is
not the `PAYMENT-RESPONSE` type itself.

The signed claims include:

- receipt version and service/job identifier;
- canonical request and result SHA-256 digests;
- settlement transaction, payer, asset, amount, and network;
- receipt signer and issuance time.

Claims are signed with Ed25519 over RFC 8785 canonical JSON. Verification
recomputes request/result digests from the exact values exchanged and verifies
the signer. A receipt is omitted when the facilitator cannot truthfully name the
payer.

## Independent Stellar verification

For the testnet transaction in a response:

```bash
TX="<64-character transaction hash>"
curl -fsS "https://horizon-testnet.stellar.org/transactions/$TX" \
  | jq '{successful, ledger, created_at, hash}'
```

For `exact`, inspect the operation/effects or Soroban transaction result and
confirm payer, recipient, asset, and amount match the signed requirements. For
custom `upto`, also confirm the active contract event binds payer, recipient,
token, maximum, actual, refund, facilitator, settlement ID, and request/result
digests.

The [conformance report](rfp/testnet-conformance-report.md) records the current
testnet proof procedure without secrets.

## What each object means

| Object | Meaning | Not proof of |
|---|---|---|
| `PaymentRequired` | Resource server's offered payment terms | Settlement |
| Signed `PaymentPayload` | Buyer authorization for selected terms | Successful execution |
| `SettleResponse` | Facilitator settlement outcome | Provider response quality |
| `x402job/1` receipt | Signed Veridex binding of request/result digests to settlement facts | Independent ledger finality without verification |
| Provider outcome | Signed per-call usability/fault evidence | Payment settlement |
| Provider aggregate | Statistical policy signal over observations | The actual failure probability or payment authority |

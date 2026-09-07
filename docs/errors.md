# Public error reference

Agents and applications must branch on machine-readable codes, not parse prose.
Veridex exposes two related layers.

## x402 protocol reasons

Facilitator `/verify` uses `isValid`, `invalidReason`, `invalidMessage`, and
optional `payer`/extensions. `/settle` uses `success`, `errorReason`,
`errorMessage`, `transaction`, `network`, optional `payer`, optional actual
`amount`, and extensions.

Stellar exact reasons are specific, for example:

| Code | Meaning | Retry? | Action |
|---|---|---:|---|
| `invalid_exact_stellar_payload_wrong_amount` | Signed amount differs from requirements | No | Re-read the 402 and sign those exact terms |
| `invalid_exact_stellar_payload_wrong_asset` | Signed token differs | No | Use the advertised SEP-41 contract |
| `invalid_exact_stellar_payload_wrong_recipient` | Signed recipient differs | No | Use the advertised `payTo` |
| `invalid_exact_stellar_payload_simulation_failed` | Transfer would not execute | Usually no | Check balance, trustline, and current ledger state |
| `invalid_exact_stellar_signature_expiration_too_far` | RPC ledger views disagree on allowed expiry | Yes, with fresh terms | Re-read the 402/ledger and re-sign |
| `settlement_capacity_exceeded` | All settlement signers remained busy; nothing submitted | Yes | Respect `Retry-After` and retry |
| `invalid_upto_stellar_authorization_already_settled` | Payer/settlement ID replay guard is consumed | No | Sign a new `upto` authorization |

The exhaustive installed-package mapping is maintained in
`facilitator-service/src/reasons.ts` and checked by tests.

## Veridex wrapper errors

Service/SDK/MCP adapters use:

```json
{
  "code": "payment_rejected",
  "reason": "The payment authorization or settlement was rejected.",
  "retryable": false,
  "category": "payment",
  "details": {}
}
```

| Code | Meaning | Retryable | Common cause | Recommended action |
|---|---|---:|---|---|
| `invalid_request` | Invalid/missing input | No | Wrong JSON/tool arguments | Validate against current schema |
| `not_found` | Resource/endpoint absent | No | Wrong URL or signer | Refresh discovery/configuration |
| `unauthorized` | Operator/service auth required | No | Missing bearer token | Supply the configured internal token |
| `rate_limited` | Request rate exceeded | Yes | Burst exceeded policy | Back off; respect response guidance |
| `internal_error` | Unexpected service failure | Yes | Server-side fault | Retry cautiously and inspect logs |
| `resource_unavailable` | Seller/resource unavailable | Yes | Endpoint outage | Retry or select another resource |
| `facilitator_unavailable` | Facilitator unavailable | Yes | Network/service outage | Retry after health recovers |
| `payment_rejected` | Authorization/settlement rejected | No | Invalid terms or signature | Inspect nested x402 reason and create fresh payment |
| `payment_timeout` | Payment exceeded deadline | Yes | Slow network/expired auth | Fetch fresh terms and retry |
| `unsupported_payment_scheme` | Scheme is unavailable | No | Requested unadvertised scheme | Read `/supported`; select another option |
| `catalog_ingestion_failed` | Bazaar could not ingest declaration | Yes | Bazaar/storage outage | Payment remains separate; await outbox retry |
| `invalid_catalog_delta` | Federation delta invalid/unauthorized | No | Signature, authority, freshness, or shape | Correct and re-sign the full delta |
| `provider_quality_unavailable` | Quality evidence unavailable | Yes | Observatory outage | Apply configured stale/unavailable policy |
| `invalid_provider_observation` | Observation invalid/unauthorized | No | Bad signature/binding/schema | Correct source and signed fields |
| `invalid_provider_aggregate` | Aggregate invalid/unauthorized | No | Bad signature/binding/counts | Reject it and use authorized fresh evidence |
| `mcp_signing_required` | Client wallet must sign challenge | No | First `pay_resource` phase | Sign locally and submit `paymentPayload` |
| `mcp_tool_failed` | MCP operation failed | No | Resource, policy, or tool error | Inspect `reason`; do not assume payment settled |
| `rpc_unavailable` | No RPC completed the operation | Yes | Provider outage | Retry only after checking transaction hash/state |
| `rpc_disagreement` | Configured RPCs disagree on final status | No | Inconsistent provider result | Stop and reconcile; never blindly resubmit |

Canonical definitions live in `error-registry.json`; package snapshots are
checked with `npm run errors:check`.

## Safe retry rule

`retryable: true` means retry may be appropriate, not that the same signed
authorization is always reusable. If a response includes a transaction hash or
submission may have occurred, reconcile ledger state first. Capacity rejection
explicitly occurs before submission and is safe to retry with fresh validity.

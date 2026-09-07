# Standards alignment

Reviewed against current upstream sources and installed package APIs on
2026-09-06. This date matters: x402 is evolving, so this page records a review,
not a permanent “latest” claim.

## Sources reviewed

- [x402 protocol v2 specification](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md)
- [x402 Bazaar extension](https://github.com/x402-foundation/x402/blob/main/specs/extensions/bazaar.md)
- [x402 scheme specifications](https://github.com/x402-foundation/x402/tree/main/specs/schemes)
- [x402 MCP package](https://github.com/x402-foundation/x402/tree/main/typescript/packages/mcp)
- Installed `@x402/core`, `@x402/stellar`, `@x402/extensions`, `@x402/fetch`, and `@x402/hono` declarations
- Veridex conformance, package tests, and [Architecture 3.2](architecture.md)

The repository's proven package baseline is `@x402/*@2.21.0`. Foundation `main`
has moved ahead of those installed declarations, including named payment-flow
phases and reserved `extra.assetTransferMethod`/`extra.paymentFlow` fields. A
source change is not adopted until dependency review and conformance pass.

## Compatibility table

| Capability | Current standard/source | Veridex status |
|---|---|---|
| x402 v2 core | `PaymentRequired`, `PaymentRequirements`, `PaymentPayload`, `VerifyResponse`, `SettleResponse` | Implemented; exact path testnet proven |
| HTTP transport | 402 plus base64 `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE` | Implemented/testnet proven |
| HTTPS API gateway | Uses canonical v2 challenge, verify, settle, and HTTP header encoders; proxy/event APIs are Veridex implementation concerns | Exact gateway locally tested; no new payment format |
| Stellar exact | Installed `@x402/stellar@2.21.0` exact client/server/facilitator exports; Foundation `main` now declares `authorization` and `upfront` flows | Installed authorization behavior is stock-client testnet proven; newer flow support is not adopted/proven here |
| Stellar `upto` | Upstream has a scheme family, but installed Stellar package exposes no `upto` exports | Veridex custom implementation is testnet proven, experimental, unaudited, not upstream-interoperable |
| Bazaar declaration | x402 v2 `extensions.bazaar` with `info` and JSON Schema | Declared through `@x402/extensions`; ingestion adds Veridex settlement/live-term gates |
| Bazaar retrieval | Upstream discovery concepts; storage/index APIs are implementation choices | Veridex `/discovery/resources` and `/discovery/search` use a custom response shape documented by local OpenAPI |
| Dynamic routes | `routeTemplate` uses `:param`; concrete values are in `info.input.pathParams`; schemas come from declaration helpers | Validation implemented; seller examples use `pathParamsSchema` |
| MCP transport | Upstream `@x402/mcp` uses `PaymentRequired` and `_meta["x402/payment"]`/`_meta["x402/payment-response"]` | Veridex currently uses a custom keyless stdio two-phase service, not that transport package |
| CAIP-2 | `{namespace}:{reference}` | Active examples use `stellar:testnet`; `stellar:pubnet` is approval-gated |
| Other schemes | Upstream currently contains `exact`, `upto`, `batch-settlement`, and `auth-capture` specifications; support is network/package-specific | Veridex advertises only confirmed Stellar `exact` and custom testnet `upto`; no batch/auth-capture claim |
| Payment flow metadata | Foundation `main` reserves `extra.assetTransferMethod` and `extra.paymentFlow`, with named `authorization`, `upfront`, and `escrow` flow phases | Installed 2.21.0 Stellar/runtime does not expose or emit these newer fields; Veridex docs do not fabricate them |

## Canonical x402 v2 terms

```ts
type PaymentRequirements = {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
};

type PaymentRequired = {
  x402Version: number;
  resource: { url: string; description?: string; mimeType?: string };
  accepts: PaymentRequirements[];
  extensions?: Record<string, unknown>;
};

type PaymentPayload = {
  x402Version: number;
  resource?: { url: string; description?: string; mimeType?: string };
  accepted: PaymentRequirements;
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
};
```

The facilitator request body is:

```json
{
  "x402Version": 2,
  "paymentPayload": {},
  "paymentRequirements": {}
}
```

Veridex accepts the canonical body without the top-level `x402Version` for the
installed client path, while the nested payload remains v2. Active examples
should use the complete standard request shape where constructing requests
manually.

The current settlement type is named `SettleResponse`, not
`SettlementResponse`. A successful response has `success`, `transaction`,
`network`, optional `payer`, optional actual `amount`, and optional extensions.

Foundation `main` treats `extra.assetTransferMethod` and `extra.paymentFlow` as
protocol-reserved. Extensions must not add or rewrite them during enrichment.
When Veridex upgrades beyond the pinned 2.21.0 baseline, scheme registration,
wire extras, and before/after-handler settlement phases require a fresh review.

## HTTP representation

| Direction | Header | Value |
|---|---|---|
| Resource -> buyer on 402 | `PAYMENT-REQUIRED` | Base64 JSON `PaymentRequired` |
| Buyer -> resource retry | `PAYMENT-SIGNATURE` | Base64 JSON `PaymentPayload` |
| Resource -> buyer after settlement | `PAYMENT-RESPONSE` | Base64 JSON `SettleResponse` |

`X-PAYMENT`, `X-PAYMENT-RESPONSE`, flattened v1 payloads, and
`maxAmountRequired` are compatibility terminology. They must not appear in new
active examples.

## Core versus Veridex behavior

| Standard x402 behavior | Veridex behavior |
|---|---|
| Core types and HTTP transport | Stellar exact registration and facilitator operation |
| Scheme-specific authorization/verification | Custom Stellar `upto` contract and adapters |
| Bazaar declaration extension | Settlement-backed PostgreSQL catalog, search, outbox, live revalidation, and federation prototype |
| `SettleResponse` in `PAYMENT-RESPONSE` | Additional custom `x402job/1` receipt in facilitator JSON response |
| Upstream MCP `_meta` transport | Custom `discover_resources`/two-phase `pay_resource` stdio service |
| Protocol reason fields | Canonical Veridex wrapper registry and `extra.veridexError` metadata |

## Standards drift policy

For every x402 dependency or specification update:

1. Review upstream core, affected scheme, HTTP/MCP transport, and Bazaar changes.
2. Compare installed declarations and lockfile versions; never document source
   `main` behavior as shipped until dependencies adopt it.
3. Update the documentation truth matrix in this page and the drift-check rules
   when terminology changes.
4. Run `npm run docs:check`, package tests, typecheck, and build.
5. Run a fresh stock-client Stellar testnet conformance payment for wire,
   payment-flow, reserved-extra, or scheme changes.
   scheme changes.
6. Update Architecture 3.2, OpenAPI, quickstart, role guides, and RFP evidence in
   the same change.
7. Preserve historical specs/ADRs as dated records; mark them superseded rather
   than silently treating them as current APIs.

No pubnet rollout follows automatically from a dependency update. Pubnet remains
approval-gated and requires its own evidence and security review.

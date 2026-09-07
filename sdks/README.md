# Multi-language seller helper prototypes

The `sdks/` directory contains local TypeScript, Python, and Go helpers for
building and validating seller metadata. They are examples/prototypes, not the
canonical buyer SDK and not asserted as published registry packages.

For new TypeScript seller integrations, prefer the official
`declareDiscoveryExtension()` helper shown in the
[seller guide](../docs/guide/seller.md). Current x402 v2 Bazaar declarations
live in `PaymentRequired.extensions.bazaar` and contain `info` plus JSON Schema.

## Directory roles

| Directory | Scope | Publication claim |
|---|---|---|
| `typescript/` | Local seller metadata construction/validation | None |
| `python/` | Local seller metadata construction/validation | None |
| `go/` | Local seller metadata construction/validation and Go tests | Use its declared module locally; remote availability is not asserted |

The three implementations have similar goals but are not proven wire-equivalent
to each other or to the current upstream extension. Run each package's tests and
inspect emitted JSON before using it in a production integration.

## Current dynamic-route convention

- Route templates use `:param` externally, for example
  `/weather/:country/:city`.
- Concrete parameter values belong in `info.input.pathParams`.
- TypeScript server declaration helpers accept `pathParamsSchema` and derive the
  extension schema.
- Templates are percent-decoded before traversal (`..`) and scheme-injection
  (`://`) checks.

Do not copy older flattened helper output into active x402 v2 examples without
converting it to the current extension structure.

## Package selection

- Buyer: focused local `@veridex/stellar` package in `sdk-typescript/` or official
  x402 client packages.
- Seller: official x402 middleware and Bazaar declaration helper.
- Agent: sibling `@veridex/agentic-payments` for policy/orchestration layered
  above the buyer path.
- Facilitator: services in this repository.

See [package selection](../docs/package-selection.md) and
[standards alignment](../docs/standards-alignment.md).

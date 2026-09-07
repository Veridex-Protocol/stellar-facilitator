# Stellar x402 developer guide

Pick the path that matches your role. The first exact payment does not require
knowledge of federation, provider quality, or Soroban contract internals.

| I am building | Start here | You will end with |
|---|---|---|
| A buyer | [Buyer](./buyer.md) | A client that handles x402 v2 402/sign/retry |
| A paid HTTP resource | [Seller](./seller.md) | An exact-protected endpoint with optional discovery |
| An autonomous workflow | [Agent](./agent.md) | Search -> local policy -> wallet signing -> proof inspection |
| A facilitator/Bazaar deployment | [Operator](./operator.md) | A testnet stack with explicit production gaps |

All active examples default to `stellar:testnet`. Pubnet is approval-gated and
has not been validated by this evidence set.

## Before any path

Start with the [canonical testnet quickstart](../quickstart.md):

```bash
git clone https://github.com/Veridex-Protocol/stellar-facilitator.git
cd stellar-facilitator
npm run demo
```

`npm run demo` creates Friendbot-funded testnet accounts, starts the stack, and
runs the conformance harness. The harness is a stock x402 client installed from
public npm, paying for a real resource on Stellar testnet, and the settlement is
re-read from Horizon afterwards. It takes about a minute after the first image
build and it needs no secrets from anyone.

If that works, everything in these guides will work.

For package ownership, see [package selection](../package-selection.md).

## What x402 is, in one pass

A client requests a resource. The server answers with HTTP 402 and a
`PAYMENT-REQUIRED` header containing x402 v2 `PaymentRequired`. The client signs
a `PaymentPayload` and retries with `PAYMENT-SIGNATURE`. The resource server uses
the facilitator for `/verify` and `/settle`, then returns the paid body with
`PAYMENT-RESPONSE`.

```
  Buyer                    Seller                   Facilitator            Stellar
    │                        │                           │                    │
    ├── GET /resource ──────►│                           │                    │
    │◄── 402 + PAYMENT-REQUIRED ─────────────────────────┤                    │
    │                        │                           │                    │
    ├── GET + PAYMENT-SIGNATURE ────────────────────────►│                    │
    │                        ├── POST /verify ──────────►│                    │
    │                        │◄── isValid ───────────────┤                    │
    │                        ├── POST /settle ──────────►│                    │
    │                        │                           ├── submit ─────────►│
    │                        │◄── tx hash + receipt ─────┤◄── confirmed ──────┤
    │◄── 200 + resource + PAYMENT-RESPONSE ─────────────┤                    │
```

The protocol types are independent of the HTTP transport and of Stellar scheme
logic. Veridex-specific cataloging, receipts, and provider evidence extend this
flow but do not redefine payment authority.

## Two things specific to Stellar

The first is that payments use authorization entries rather than signed
transactions. The buyer signs a Soroban authorization entry permitting one
specific contract call, and the facilitator builds the transaction, submits it,
and pays the network fee. A wallet used with x402 on Stellar therefore has to
support authorization entry signing.

The second is that validity is bounded by ledger sequence rather than by wall
clock. An authorization expires at a ledger number derived from
`maxTimeoutSeconds`, which is roughly 60 seconds by default. That window is
deliberately short, and it is the reason the retry behaviour described in the
[operator path](./operator.md#soroban-rpc-ledger-skew) exists at all.

## Assets

Payments settle through SEP-41 token contracts, which are identified by contract
address starting with `C`, not by classic asset codes. The string `native` is not
a valid x402 v2 asset identifier and is rejected with an explanation saying so.

Testnet native XLM has a Stellar Asset Contract at
`CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`. It needs no trustline,
which is why the examples throughout this guide use it. To be paid in USDC or any
other SEP-41 asset, the receiving account needs a trustline to that asset first,
which is covered in the [seller path](./seller.md#getting-paid-in-usdc).

## Reference

- [`docs/architecture.md`](../architecture.md) describes the target system architecture, invariants, and trust boundaries.
- [`docs/deployment.md`](../deployment.md) covers production infrastructure requirements and deployment procedures.
- [`docs/openapi/`](../openapi/) contains the facilitator and discovery API definitions ([`x402.yaml`](../openapi/x402.yaml) and [`bazaar.yaml`](../openapi/bazaar.yaml)).
- [`docs/adr/`](../adr/) records why the system works the way it does.
- [`testnet_docs.md`](../../testnet_docs.md) is the go-live runbook and the list of known limits.
- [Standards alignment](../standards-alignment.md) records the upstream sources and review date.

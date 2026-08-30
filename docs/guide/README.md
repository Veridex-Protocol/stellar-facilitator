# Stellar x402 developer guide

There are three paths through this guide. Pick the one that matches what you are
building, because you do not need the other two.

| I am building | Start here | You will end with |
| --- | --- | --- |
| An API or MCP tool I want paid for | **[Seller path](./seller.md)** | A paid endpoint that appears in the Bazaar on its first settlement |
| A client or agent that pays for things | **[Buyer and agent path](./buyer.md)** | Code that discovers a service and pays for it without a prior integration |
| A facilitator others rely on | **[Operator path](./operator.md)** | A running facilitator and catalog, with the checks that keep them honest |

Every command in these guides runs against `stellar:testnet` and works from a
clean clone. Where a page shows output, that output came from an actual run.

## Before any path

```bash
git clone https://github.com/Veridex-Protocol/stellar.git && cd stellar
npm run demo
```

`npm run demo` creates Friendbot-funded testnet accounts, starts the stack, and
runs the conformance harness. The harness is a stock x402 client installed from
public npm, paying for a real resource on Stellar testnet, and the settlement is
re-read from Horizon afterwards. It takes about a minute after the first image
build and it needs no secrets from anyone.

If that works, everything in these guides will work.

## What x402 is, in one pass

A client requests a resource. The server answers with HTTP 402 and a set of
payment terms. The client signs an authorization and retries with it. A
facilitator verifies the authorization and settles it on Stellar, and only then
does the server return the resource.

```
  Buyer                    Seller                   Facilitator            Stellar
    │                        │                           │                    │
    ├── GET /resource ──────►│                           │                    │
    │◄── 402 + terms ────────┤                           │                    │
    │                        │                           │                    │
    ├── GET + payment ──────►│                           │                    │
    │                        ├── POST /verify ──────────►│                    │
    │                        │◄── isValid ───────────────┤                    │
    │                        ├── POST /settle ──────────►│                    │
    │                        │                           ├── submit ─────────►│
    │                        │◄── tx hash + receipt ─────┤◄── confirmed ──────┤
    │◄── 200 + resource ─────┤                           │                    │
```

The buyer is usually software rather than a person. It has no account with the
seller, no API key, and no prior relationship of any kind. It discovers the
endpoint, reads the terms, and pays.

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

## Live testnet references

| Thing | Where |
| --- | --- |
| Facilitator | `http://localhost:3002` after `npm run demo` |
| `upto` contract | [`CAHV6TIAOVSICUJHI6OBZSW2N5ZKRPGKHE2SH6OAEJHPHCLF5DXWAGG2`](https://stellar.expert/explorer/testnet/contract/CAHV6TIAOVSICUJHI6OBZSW2N5ZKRPGKHE2SH6OAEJHPHCLF5DXWAGG2) |
| A settled payment | [`40de5e21…`](https://stellar.expert/explorer/testnet/tx/40de5e21674215b1b3a93182e1eb1ba46afea1c571724fd7f3f020c6f22e5f40) |

## Reference

- [`docs/architecture.md`](../architecture.md) describes the target system architecture, invariants, and trust boundaries.
- [`docs/deployment.md`](../deployment.md) covers production infrastructure requirements and deployment procedures.
- [`docs/openapi/`](../openapi/) contains the facilitator and discovery API definitions ([`x402.yaml`](../openapi/x402.yaml) and [`bazaar.yaml`](../openapi/bazaar.yaml)).
- [`docs/adr/`](../adr/) records why the system works the way it does.
- [`testnet_docs.md`](../../testnet_docs.md) is the go-live runbook and the list of known limits.
- The [x402 protocol repository](https://github.com/x402-foundation/x402) holds the specification itself.

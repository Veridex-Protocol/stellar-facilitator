# Veridex x402 Playground

A hosted sandbox that makes **real payments on Stellar testnet** and then hands
you everything you need to check them without trusting this page.

Open it, click once, and about twenty seconds later you have a funded testnet
account, a settled payment, and a transaction hash on a public block explorer.
Then you can take it apart: read every message that went over the wire, verify
the facilitator's signed receipt in your own browser, and try to get a bad
payment through.

## Why this exists, and what makes it different

A playground can only really do one of two things. It can *persuade* — look,
it works — or it can *hand over evidence*. Persuasion is the easier build and
the weaker artifact, because the visitor still has to take the page's word for
everything it claims.

So the organising idea here is: **every panel ends in something you can check
somewhere else.** A transaction you can open on stellar.expert. A signature you
can recompute. A reason code that is stable and documented. If this playground
were lying, each panel gives you the means to catch it.

## The panels

| Panel | What it does |
| --- | --- |
| **Flow** | Generates a keypair, funds it from Friendbot, and buys a resource for real. Every step is a message that actually went out. |
| **Wire** | The whole exchange, decoded — including the signed Stellar envelope broken down to its authorization entries, which is where the security of `exact` on Stellar actually lives. |
| **Receipt** | Verifies the facilitator's `x402job/1` receipt in your browser, with this page's own RFC 8785 implementation. Then invites you to forge one. |
| **Refusals** | Nine ways to send a dishonest payment, plus a raw editor. Everything goes to `/verify`, which settles nothing, so probing is free. |
| **Evidence** | The repository's CI conformance report, served verbatim, with every transaction linked. |
| **Bazaar Discovery** | Queries the live catalog and exposes payment identity separately from seller-controlled metadata. |
| **API Gateway** | Activates the allowlisted demo gateway, signs a real testnet payment, receives the original API response, and displays Stellar/Bazaar/provider proof. |
| **Agent Policy** | Demonstrates local atomic-unit policy before signing; it is not a deployed smart-account proof. |

## Where the keys are

**Your keypair is generated in your browser and never transmitted.** It lives in
that tab's `sessionStorage` and dies when you close it.

The playground server holds no keys, custodies no funds, and never touches a
payment. It does three things: serve static files, hand the browser a public
configuration blob, and relay requests to the seller. Compromising it leaks the
contents of `.env.example`.

This is not incidental. "Your first payment funds a wallet for you" usually
means a server holds that wallet. Here nothing does, which is both safer and
the same non-custodial property the facilitator itself is built around.

### Why there is a proxy at all

The browser talks to the **facilitator** directly — it sends permissive CORS and
exposes `EXTENSION-RESPONSES`, so no relay is needed. It talks to **Friendbot,
Horizon and Soroban RPC** directly too.

The **seller** is different. An x402 resource server has no reason to send CORS
headers for a playground's origin, so a browser cannot read a `402` challenge
from one: the response is opaque, `PAYMENT-REQUIRED` included. That exchange has
to be relayed.

Relaying a URL the caller chooses is server-side request forgery, so
`POST /api/resource` is **allowlisted at boot** to the demo seller plus anything
an operator names in `PLAYGROUND_ALLOWED_ORIGINS`. It relays `GET`, `HEAD` and
`POST`, forwards only protocol headers, and refuses everything else. The smoke
test asserts this against cloud-metadata, loopback, `file://` and external
hosts.

This matters because an internal audit of this repository flagged exactly the
opposite pattern elsewhere — a client-facing tool that fetches any URL it is
handed. Building the same hole here, in the thing we invite people to attack,
would have been a poor choice.

## Running it

Needs a facilitator and a seller already running. From the repository root:

```bash
npm run setup                 # create and fund testnet accounts (once)
npm run dev:facilitator       # port 3002
npm run dev:demo-server       # port 3003
```

Then:

```bash
cd playground
npm install
cp .env.example .env
npm run build
npm start                     # http://localhost:3004
```

For development, `npm run dev` rebuilds the bundle and restarts the server on
change.

### Smoke test

```bash
npm run smoke                 # against http://localhost:3004
npm run smoke -- https://playground.example.com
```

It drives every path the browser drives — the allowlist, a full payment from a
brand-new Friendbot wallet, receipt verification, and all nine refusals — and
exits non-zero if anything regresses. It spends real testnet XLM.

It deliberately reimplements the flow rather than importing from `web/lib`, for
the same reason the repository's conformance harness imports nothing from the
facilitator: a check that shares code with the thing it checks mostly proves the
code agrees with itself.

## Configuration

See `.env.example`. Everything in it is public and is handed to the browser at
`/api/config`.

The server **refuses to start unless `STELLAR_NETWORK=testnet`**. It creates a
funded account for every visitor, and that is only ever appropriate on a test
network.

## Not built

Stated here rather than implied by omission:

- **The metered `upto` flow in this playground.** The facilitator and custom
  HTTP seller/client path are proven on testnet, but this browser playground
  still exposes the exact flow only. The `upto` contract and adapter remain
  experimental and unaudited.
- **Mainnet.** Nothing here has run against `stellar:pubnet`, and the server
  refuses to try.
- **Smart-account budget enforcement.** The policy panel is local browser logic,
  not an on-chain `$10/$2/$12` stablecoin authorization fixture.

## Deploying

`Dockerfile` builds a two-stage image. The runtime stage carries no source, no
build tooling, and no Stellar SDK — the SDK is bundled into `public/bundle.js`
and runs in the visitor's browser, never in the server process.

Before exposing this publicly, note that it points at a **live facilitator that
sponsors network fees from its own account**. Give it a dedicated instance with
its own keys and a capped balance, keep `MAX_TRANSACTION_FEE_STROOPS` at the
spec default of 50,000, and make sure that facilitator's rate limiter is not
keyed on an unvalidated `X-Forwarded-For`. A public playground is a public
faucet for whatever the facilitator will spend.

## Licence

Apache-2.0.

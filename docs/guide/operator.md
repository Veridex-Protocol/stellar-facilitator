# Operator path: run a facilitator others rely on

You want to run the facilitator and the catalog yourself, either for your own services or as a public endpoint. This page concentrates on the parts that are easy to get wrong and expensive to get wrong.

What you end up with is a running facilitator and catalog, together with the checks that stop either of them advertising something untrue.

## 1. Run it

```bash
git clone https://github.com/Veridex-Protocol/stellar.git && cd stellar
npm run setup                    # Friendbot accounts, channel accounts, .env
docker compose up --build -d postgres bazaar facilitator demo-server
npm run conformance              # exact-payment checks against your own stack
```

Nothing here depends on us. There is no hosted service, no API key, and no shipped contract id. Every dependency is permissively licensed, which we verified across all six package trees with no AGPL, GPL, SSPL or BUSL anywhere in a runtime path.

## 2. What the process refuses to do

Most operator mistakes are configuration mistakes, and the ones that matter turn a facilitator into a liar. These are enforced at boot rather than documented as things to remember:

| Check | Failure mode |
| --- | --- |
| `FACILITATOR_SECRET_KEY` derives `FACILITATOR_PUBLIC_KEY` | Boot aborts |
| Fee sponsorship claimed only from a funded account of at least 5 XLM, confirmed on Horizon | Boot aborts |
| `upto` advertised only when a contract is confirmed on-chain, on this network | Scheme omitted from `/supported` |
| Descriptor jobs priced in an advertised scheme, on this network, in a SEP-41 contract | Boot aborts |
| `BASE_URL` is set | Boot aborts |
| `BAZAAR_INTERNAL_TOKEN` is set and at least 24 characters | Boot aborts |

A healthy boot log tells you exactly what was confirmed:

```
fee sponsorship confirmed: 9998.7175927 XLM available
upto contract confirmed at CAHV6TIAOVSICUJHI6OBZSW2N5ZKRPGKHE2SH6OAEJHPHCLF5DXWAGG2
0 job(s) advertised in /.well-known/x402
facilitator ready ... areFeesSponsored: true, schemes: ["exact","upto"]
```

If you intend to sponsor fees and the account is not funded, the process will not start and it says why. Silently serving `areFeesSponsored: false` instead would be friendlier and would break every buyer relying on the advertised value.

## 3. Settlement throughput

This is the setting most likely to hurt you in production.

A Stellar account has exactly one sequence number, so settlements from the same account cannot overlap. Setting `CHANNEL_POOL_SIZE=0` uses the facilitator's own signer and serializes everything, which is fine for a smoke test and wrong for agent traffic, since agent traffic is bursty by nature.

Each funded channel account adds one unit of settlement concurrency:

```bash
CHANNEL_POOL_SIZE=3
CHANNEL_SECRET_KEYS=SA...,SB...,SC...
SETTLE_QUEUE_TIMEOUT_MS=30000
```

Running `npm run setup` provisions three by default. Measure before sizing:

```bash
npm run probe -- --n 6
```

```
succeeded           6/6
confirmed on ledger 6/6
latency             min 6509ms  p50 11884ms  max 11991ms
source accounts     3 distinct
scheduler           3 queued, 0 refused, longest wait 7658ms
```

Overflow queues in order, and past `SETTLE_QUEUE_TIMEOUT_MS` it is refused with `settlement_capacity_exceeded`, HTTP 503 and a `Retry-After` header. That is an explicit statement that nothing was submitted and no funds moved, which is a far better answer to an agent than a request that hangs until something upstream times out ambiguously.

Watch `settlementConcurrency` on `/stats`. Any value in `totalRejected`, or a `maxObservedWaitMs` approaching your timeout, means the pool is too small.

Multi-instance deployments must partition `CHANNEL_SECRET_KEYS` disjointly. The scheduler is per-process, so two instances sharing a channel account will collide exactly as if the scheduler were not there at all.

## 4. Soroban RPC ledger skew

The public testnet RPC endpoint is load-balanced across nodes at different ledger heights. A client reads a height from one node and signs an authorization expiring a fixed distance ahead of it, while the facilitator reads a height from another node and checks that distance. When the client's node is ahead, a perfectly valid payment is rejected as expiring too far in the future. This is tracked upstream at [x402#3168](https://github.com/x402-foundation/x402/issues/3168).

The facilitator retries only that one rejection, with a delay longer than a ledger close:

```bash
LEDGER_SKEW_RETRIES=2
LEDGER_SKEW_RETRY_DELAY_MS=6000     # must exceed ~5s, or every attempt sees the same skew
```

It never retries a failure carrying a transaction hash, because that transaction reached the network and retrying it risks settling twice.

For independent-provider failover on testnet, configure an ordered list:

```bash
SOROBAN_RPC_URLS=https://rpc-primary.example,https://rpc-secondary.example
RPC_REQUEST_TIMEOUT_MS=5000
```

Read calls fail over after a bounded transport failure. Before submission, the
coordinator health-checks providers and chooses one healthy target. It submits a
signed envelope to exactly one provider. If that call times out, it computes the
same envelope hash locally and reconciles `getTransaction` across every provider;
it never sends the envelope a second time. Conflicting final `SUCCESS`/`FAILED`
states fail safely and increment `veridex_rpc_disagreements_total`.

Provider health is visible under `rpcProviders` on `/stats`. The local coordinator
is testnet-only in this release because the pinned Stellar scheme permits its
loopback HTTP transport only on testnet; pubnet remains approval-gated.

This resolves RPC submission ambiguity, not channel-state recovery. The upstream
scheme scheduler still does not expose which signer submitted an ambiguous
transaction, so automatic uncertain-channel quarantine remains a release gap.

Do not attempt to fix this by widening the expiration tolerance. That check bounds how long a signed authorization stays live, so it is a security property rather than the bug.

## 5. Catalog integrity

The Bazaar accepts a listing only when it can confirm the settlement behind it on Horizon, itself, rather than taking the caller's word for it. There are four checks. The `settlementTx` field must be a 64-character hex transaction hash, it must exist on the configured network, it must have succeeded, and an effect on it must credit the entry's `payTo` address. On top of that, a unique constraint on `settlement_tx` means one settlement lists one resource.

Two configuration consequences follow. `BAZAAR_INTERNAL_TOKEN` is mandatory and must be at least 24 characters, because it guards a write endpoint on a public catalog, and the process will not start without it. `HORIZON_URL` must be reachable, because verification fails closed: during a Horizon outage the catalog stops listing rather than starts trusting.

Confirm both halves work:

```bash
curl -s -X POST http://localhost:3001/catalog/ingest \
  -H "authorization: Bearer $BAZAAR_INTERNAL_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"resourceUrl":"https://x.test/y","resourceType":"http"}' -D- -o/dev/null \
  | grep -i extension-responses
```

The rejection comes back in `EXTENSION-RESPONSES` as base64 JSON, decoding to this:

```json
{"bazaar":{"status":"rejected","rejectedReason":"settlementTx is required: a catalog
entry must name the settlement that backs it, which this service confirms on Horizon."}}
```

## 6. Deploying upto

The scheme stays absent from `/supported` until a contract is confirmed on-chain. Deploy your own instance, since no contract id ships as a default:

```bash
npm run upto:build      # reproducible wasm, pinned toolchain
npm run upto:deploy     # upload and instantiate on your account
```

Set `UPTO_ESCROW_CONTRACT_ID_TESTNET` to the id printed and restart. The facilitator confirms the contract exists on-chain before advertising it.

`UPTO_ESCROW_CONTRACT_ID_PUBNET` is read separately and is never inherited from the testnet variable, so a mainnet deployment cannot silently advertise a testnet contract.

The contract is stateless and has no admin, so every instance of the same wasm behaves identically. Details and the current testnet artifact are recorded in [`contracts/upto-settlement/deployment.md`](../../contracts/upto-settlement/deployment.md).

The contract is not audited, so advertise it on testnet only.

## 7. Reliability figures

The counters on `/stats` live in process memory and reset on restart. They can back a dashboard, but they cannot back a published claim.

Anything you state publicly should come from the structured `request_outcome` log lines instead, which carry outcome, reason, latency and retry count for every request:

```bash
docker compose logs --no-log-prefix facilitator | npm run outcomes
```

```
/settle
──────
  requests   248
  outcomes   settled=247  failed=1
  latency    p50 3900ms   p90 8100ms   p99 12400ms
  failures   1 of 248 attempted (0.40%)
```

Every figure there recomputes from the same log with that script. That is the standard worth holding yourself to, because a number nobody else can reproduce is a claim rather than evidence.

## 8. Before going public

Fund the sponsor account well above the 5 XLM floor and alert on its balance. Put a real rate limiter at the edge, since the built-in 120 per minute is a per-instance backstop rather than an edge policy. Set `CORS_ORIGINS` if this is not a public facilitator. Run the idempotent migration runner with `npm --prefix bazaar-service run db:migrate` (or apply the files in `bazaar-service/src/db/migrations/` in order). Configure at least two Bazaar peers and verify that signed announcements propagate between them.

Alert on settlement failure rate, on `settlementConcurrency.totalRejected`, on skew retry volume, on channel account balances, on Horizon and RPC errors, and on database health.

Finally, run the harness against the deployed stack rather than against localhost:

```bash
FACILITATOR_URL=https://… DEMO_SERVER_URL=https://… npm run conformance
```

The full checklist, including what is deliberately still open, is in
[`testnet_docs.md`](../../testnet_docs.md).

## Known limits

These are stated because you will hit them. Pubnet is wired end to end and has never been exercised, so this is testnet only for now. The `upto` contract is deployed but unaudited. The ledger-skew retry is tested but not field-proven, because no real degraded RPC window has occurred while we were watching.
Retrieval is lexical rather than semantic, since the vector leg is feature hashing rather than a learned model, so a query matches on shared tokens rather than on meaning.

## Next

The [seller path](./seller.md) shows what your users will be doing, and the [buyer and agent path](./buyer.md) shows what will be calling you. The [decision records](../adr/) explain why each of the above works the way it does.

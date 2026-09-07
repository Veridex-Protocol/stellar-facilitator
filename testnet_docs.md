# Testnet go-live

This is the runbook for putting the facilitator and Bazaar on Stellar testnet
and being able to defend every number that comes out of it.

The previous version of this file listed operator chores and asserted that
"code-level release blockers are fixed". They were not: the service advertised
an `upto` scheme with no contract behind it, claimed fee sponsorship without
checking the account was funded, served a capability descriptor of invented
jobs, and signed receipts whose signature covered none of their settlement
fields. Those are fixed, and the fixes are enforced at boot rather than
documented here as things to remember.

## What the code now refuses to do

You do not need to check these. The process fails to start instead.

| Check | Where | Failure mode |
| --- | --- | --- |
| `FACILITATOR_SECRET_KEY` derives `FACILITATOR_PUBLIC_KEY` | `startup.ts` | boot aborts |
| Fee sponsorship claimed only from a funded account (≥5 XLM, confirmed on Horizon) | `startup.ts` | boot aborts |
| `upto` advertised only when a contract is confirmed deployed at the configured id, on this network | `startup.ts` | scheme omitted from `/supported` |
| Descriptor jobs priced in an advertised scheme, on this network, in a SEP-41 contract | `capability-descriptor.ts` | boot aborts |
| `/supported` matches what was actually confirmed | `startup.ts` | boot aborts |
| `BASE_URL` set | `server.ts` | boot aborts |
| `BAZAAR_INTERNAL_TOKEN` set and ≥24 chars | `bazaar-service/server.ts` | boot aborts |
| Catalog entries backed by a settlement confirmed on Horizon | `catalog/settlement-proof.ts` | entry rejected |
| No two settlements share a signer's sequence number | `settle-scheduler.ts` | overflow queues, then refuses |
| A cursor is only used to continue the query that issued it | `search/cursor.ts` | `400 invalid_cursor` |

## The one-command path

From a clean clone, no secrets, about a minute:

```bash
git clone https://github.com/Veridex-Protocol/stellar-facilitator.git
cd stellar-facilitator
npm run demo
```

That creates Friendbot-funded testnet accounts, starts postgres + bazaar +
facilitator + demo resource server, and runs the conformance harness: a stock
x402 client from public npm paying for a real resource on testnet, with the
settlement re-read from Horizon afterwards. The run writes
`conformance-report.json`, which names the settled transaction hash.

The repository defines the same Friendbot-funded conformance job in CI. Recorded
hosted runs previously failed before runner execution, so current acceptance
evidence comes from the reproducible local run artifacts rather than a hosted-CI
success claim.

## Deploying it somewhere real

Everything above runs locally. To put it on a host:

### 1. Accounts and secrets

- [ ] Create a dedicated testnet facilitator account and fund it well above the
      5 XLM sponsorship floor. It pays the Soroban resource fee for every
      settlement; when it runs dry the service stops claiming sponsorship, and
      on restart it refuses to boot.
- [ ] Put `FACILITATOR_SECRET_KEY` in a secret manager, not in the image.
- [ ] Generate `BAZAAR_INTERNAL_TOKEN`:
      `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`
- [ ] Set unique database credentials.
- [ ] Document key rotation and the incident rollback path.

### 2. Facilitator configuration

- [ ] `BASE_URL` - the public HTTPS origin. It is published in
      `/.well-known/x402` as where clients reach you.
- [ ] `STELLAR_NETWORK=testnet`, `HORIZON_URL`, `SOROBAN_RPC_URL`.
- [ ] Provision funded channel accounts and list their secrets in
      `CHANNEL_SECRET_KEYS`. **Settlement concurrency equals the number of these
      accounts**, because a Stellar account has one sequence number and the
      scheduler will not run two settlements from the same one.
      `CHANNEL_POOL_SIZE=0` is a single-signer smoke-test configuration and
      serializes everything: correct for a first check, wrong for agent traffic.
      Do not enable `CHANNEL_AUTO_CREATE` outside disposable testing.
- [ ] Size the pool against measured load: `npm run probe -- --n <concurrency>`.
      Any `totalRejected`, or a `maxObservedWaitMs` approaching
      `SETTLE_QUEUE_TIMEOUT_MS`, means the pool is too small.
- [ ] `RATE_LIMIT_MAX` - the default of 120/min is a backstop, not an edge
      policy. Settlement spends real XLM; put a real limiter in front in
      production.
- [ ] `X402_JOBS_FILE` - only if this deployment actually sells jobs. Leave
      unset and the descriptor advertises none, which is correct for a bare
      facilitator. See `jobs.example.json`.

### 3. Bazaar configuration

- [ ] Deploy PostgreSQL 16 with pgvector; apply
      `bazaar-service/src/db/schema.sql` to a fresh database.
- [ ] Apply all six ordered files in `bazaar-service/src/db/migrations/` through
      the idempotent migration runner. `001` adds settlement binding, `002`
      settlement liveness, `003` provider quality, `004` catalog delta state,
      `005` live revalidation, and `006` observation source/disagreement state.
      The original destructive clean-room artifact covered `001`-`004`; capture
      a fresh migration/revalidation drill for `005`/`006`.
- [ ] `HORIZON_URL` - the Bazaar confirms settlements itself and will list
      nothing if it cannot reach Horizon.
- [ ] `BAZAAR_BASE_URL` for its capability descriptor.
- [ ] Configure P2P bootstrap multiaddresses and at least two peers.

### 4. Network and TLS

- [ ] Public HTTPS origins, TLS termination, firewall rules.
- [ ] `CORS_ORIGINS` - the default is `*`, which is right for a public
      facilitator and wrong for an internal one.

### 5. Prove it, then publish

- [ ] Point the harness at the deployment and run it:
      `FACILITATOR_URL=https://... DEMO_SERVER_URL=https://... npm run conformance`
- [ ] Confirm `/supported` advertises `x402Version: 2`, `exact`,
      `stellar:testnet`, the signer address, and `areFeesSponsored: true`  - 
      and that it advertises `upto` **only** if you deployed the contract.
- [ ] Confirm `/.well-known/x402` names your real origin and only jobs you
      actually serve.
- [ ] Verify Bazaar ingestion: a settled payment appears in
      `/discovery/search`, and a forged `settlementTx` is rejected.
- [ ] Verify P2P: signed announcement propagation, replay rejection, heartbeat
      degradation, offline filtering.
- [ ] Derive published figures from the structured log, never from `/stats`:
      `docker compose logs --no-log-prefix facilitator | npm run outcomes`
- [ ] Alert on: settlement failure rate, ledger-skew retry volume, RPC/Horizon
      errors, sponsor account balance, `settlementConcurrency.totalRejected` and
      `queued` from `/stats`, channel account balances, database health,
      heartbeat loss, P2P peer count.
- [ ] Back up the database and secrets.

## `upto`

The contract in `contracts/upto-settlement` has tests and a recorded testnet
deployment in [`contracts/upto-settlement/deployment.md`](contracts/upto-settlement/deployment.md).
The scheme is absent from `/supported` until `resolveUptoGate()` confirms a
contract instance exists on the configured network.

Testnet first, then mainnet, with separate ids for each:

- [ ] Build optimized WASM with the Stellar CLI; record the WASM hash.
- [ ] Deploy from a funded testnet identity; record the contract id.
- [ ] Set `UPTO_ESCROW_CONTRACT_ID_TESTNET`. Restart; confirm `/supported` now
      carries the `upto` kind with that id, and that the boot log says
      `upto contract confirmed at C...`.
- [x] Execute cap, zero, partial-use, replay, and response-digest transactions
      through the facilitator/custom HTTP path on testnet.
- [x] Complete Veridex facilitator, buyer, and reference seller integration.
- [ ] Complete an independent security review.
- [ ] Only after explicit approval deploy to pubnet and set
      `UPTO_ESCROW_CONTRACT_ID_PUBNET`.
      A testnet id is never inherited onto pubnet - the gate reads a
      network-specific variable first, precisely so a mainnet deployment cannot
      quietly advertise a testnet contract.

## Known limits, stated plainly

- **Catalog binding is to a payment, not to a URL.** The Bazaar confirms that
  the named settlement succeeded and credited the entry's `payTo`, and that one
  settlement lists one resource. The ledger records value moving to an account,
  not which URL was served, so a seller with one genuine payment can still
  choose the description attached to it. Binding the URL needs the resource
  server to sign the pairing. Not built.
- **The vector leg of Bazaar ranking is feature hashing, not a learned model.**
      It behaves as a second lexical signal fused with PostgreSQL `ts_rank_cd`.
      Nothing here is semantic retrieval.
- **Multi-page cursor traversal is unexercised end to end.** The cursor logic
  has unit coverage and a forged cursor is rejected at the wire, but the demo
  catalog holds one resource, so no conformance run has actually walked a
  second page.
- **The ledger-skew retry has been tested, not observed recovering a live
  event.** `retry.test.ts` simulates it deterministically. Whether it recovers a
  real degraded RPC window is unproven until one occurs while a probe is
  running.
- **Settlement throughput is bounded by the channel pool, by design.** Past that
  the facilitator refuses with `settlement_capacity_exceeded` rather than
  queueing without limit. An explicit "no funds moved" is more useful to an
  agent than a request that hangs, but it does mean sizing the pool is an
  operator responsibility the service cannot paper over.
- **Active service/SDK packages use Stellar SDK 16.2.0.** The root bootstrap
      package still has its own dependency manifest; use package-local lockfiles as
      the runtime authority.

## Launch gate

For a hosted testnet deployment, require green CI/conformance, clean dependency
audits, a ledger-confirmed payment, visible asynchronous catalog ingestion, and
forged-settlement rejection. Pubnet/production additionally require independent
security review, HA/restore evidence, external monitoring/alerts, and explicit
approval; none is claimed by this runbook.

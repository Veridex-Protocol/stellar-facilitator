# ADR-010: Conformance Is the Acceptance Artifact - A Stock Client, Real Money, Every Pull Request

## Status

Accepted (2026-08-23) - records why acceptance is a harness that imports nothing from this repository and settles a real testnet payment on every CI run, and why published reliability figures are derived from durable logs rather than from `/stats`.

## Context

The RFP does not ask for a conformance claim. It says what reviewers will do:

> Reviewers will point stock SDK code at the deliverable rather than read a conformance claim.

and names the failure mode it is screening for:

> Conformance discipline and upkeep. Evidence the team treats wire level conformance as first class, plus a plan to stay current as the discovery conventions evolve. **Drift, not inability, is the failure mode this screens for.**

Drift is the operative word. Discovery conventions are moving under the x402 Foundation and will move again during the grant. A repository that conformed on the award date and was never re-checked is the predictable outcome, and it is indistinguishable from a repository that never conformed - until a reviewer runs a client against it.

Our own CI, before this change, ran typecheck, build, unit tests, and a docker build. All 17 unit tests passed and every one of them was mocked. **Nothing in CI had ever settled a payment.** We could have shipped a facilitator that returned a plausible transaction hash without touching Stellar and CI would have been green.

So the question we had to answer was not "does our facilitator work" but "what would let a reviewer establish that without taking our word for it". Anything we host, we control; anything we report, we could be reporting selectively. The only artifact that survives that objection is one the reviewer runs themselves, against code they cloned, with no input from us.

**A number nobody else can reproduce is a claim, not evidence.** That applies to our numbers first, and it is why the rest of this ADR is about making ours reproducible rather than about making them impressive.

## Decision

**Acceptance is a harness that imports nothing from this repository, pays with a stock client, and re-reads the result from Horizon. It runs on every pull request with accounts created during the run.**

### 1. The harness is adversarial toward us by construction

[`conformance/`](../../conformance/) is a separate package whose only dependencies are public npm: `@x402/fetch`, `@x402/core`, `@x402/stellar`, `@stellar/stellar-sdk`, at pinned versions. It imports **nothing** from our source.

Four properties make it hard to fake:

1. **Stock client.** Payment goes through `wrapFetchWithPayment` - the library's own drop-in wrapper - driving an `x402Client`. No custom protocol code, no patches.
2. **Independent ledger read.** The settled transaction is re-fetched from Horizon. A facilitator returning a plausible hash without settling fails here.
3. **Independent canonicalization.** RFC 8785 is reimplemented inside the harness to verify receipts, because verifying with the code that produced them proves only self-consistency ([ADR-006](./adr-006-recomputable-receipts.md)).
4. **Recorded provenance.** The report records the installed versions of the client packages that actually ran.

### 2. Rejections must explain themselves, and that is asserted

```js
function assertUsableReason(reason, message, label) {
  assert(reason !== null && reason !== undefined, ...);
  assert(typeof reason === "string" && reason.trim().length > 0, ...);
  assert(!["error", "unknown", "failed", "invalid"].includes(reason.trim().toLowerCase()),
    `${label}: reason '${reason}' is generic and tells an integrator nothing`);
  assert(typeof message === "string" && message.trim().length > 10, ...);
}
```

The RFP requires "a non null reason on every rejection". A non-null reason of `"error"` satisfies that literally and helps nobody, so the harness rejects generic codes too.

### 3. CI settles real money with no secrets

The conformance job creates Friendbot-funded accounts **during the run**, brings the stack up with compose, and pays on `stellar:testnet`. No stored credentials, which is the point: **anyone can fork this repository and get the same green run.** A conformance property that depends on our secrets is not a property a reviewer can check.

### 4. One command from a clean clone

`npm run demo` - bootstrap, stack, harness - in roughly 60-90 seconds after the first image build. The reviewer's path and CI's path are the same path.

### 5. Published figures come from logs, not counters

`/stats` counters are in-process and reset on restart, so they can back a dashboard and never a claim. The service emits one structured `request_outcome` line per request with latency, reason, and retry count, and [`summarize-outcomes.mjs`](../../scripts/summarize-outcomes.mjs) derives p50/p90/p99, settlement failure rate, and skew recovery from them. `/stats` says so in its own response:

```json
"note": "In-process counters since boot. They reset on restart; derive published figures from the request_outcome log lines."
```

### 6. Coverage is the whole surface, not just the happy path

32 checks across seven groups: `/supported` truthfulness, capability descriptor honesty, stock-client payment, ledger confirmation, receipt recomputation **including per-field forgery**, five rejection paths, and eight discovery behaviours including a forged settlement the catalog must refuse.

## Consequences

**Good**

- Drift is caught on the pull request that causes it, which is the thing the RFP is actually screening for.
- Every published number is reproducible by a stranger from a clean clone, with no cooperation from us.
- The harness has already earned its keep. It caught the liveness pruning defect ([ADR-003](./adr-003-settlement-liveness.md)) that unit tests could not, because that bug only appears when a real stack has been running long enough for a background sweep to fire.
- It also caught two bugs in *itself* - a wrong `wrapFetchWithPayment` signature and a settle payload with no discovery extension - which is the harness working: it tests the contract, not our assumptions.
- Evidence is concrete: settled transactions `3ef04dd9…`, `40de5e21…`, `3599b260…`, Horizon-confirmed at ledger 4276297 and after.

**Costs accepted**

- **CI spends real testnet XLM and depends on Friendbot and public Soroban RPC.** A testnet reset or a Friendbot outage turns CI red for reasons unrelated to the change under review. Accepted deliberately: the alternative is a green CI that proves nothing.
- **The conformance job takes ~10-20 minutes** against seconds for unit tests, and cannot be meaningfully parallelised - it is a real payment against a real network.
- **Flakiness is real and load-dependent.** Soroban RPC skew ([ADR-008](./adr-008-ledger-skew-retry.md)) can fail a run. Mitigated by the retry, not eliminated, and a failure hint in `demo.sh` names the two likely causes so a red run is not misread as a code defect.
- **The harness must be maintained against a moving spec.** It is a second implementation of parts of the wire format and will need updating as conventions evolve. That maintenance *is* the upkeep the RFP asks for, so the cost is the deliverable.

**Deliberately not done**

- **No mainnet conformance.** `stellar:pubnet` is wired throughout but has never been exercised. The RFP calls both networks committed deliverables and this remains our largest outstanding gap, recorded in `testnet_docs.md`.
- **No load or soak testing in CI.** [`concurrency-probe.mjs`](../../scripts/concurrency-probe.mjs) is run on demand ([ADR-007](./adr-007-settlement-throughput.md)); running it per-PR would spend meaningfully more testnet XLM for a property that changes rarely.
- **No scheduled flakiness probe.** Sampling RPC skew frequency on a spread cron, from neutral infrastructure, would turn [ADR-008](./adr-008-ledger-skew-retry.md)'s untested mitigation into a measured one. Worth doing; not done.
- **No published historical figures yet.** We have single-run evidence, not a corpus. Claiming a median across thousands of settlements requires having run thousands.

## References

- [`conformance/src/harness.mjs`](../../conformance/src/harness.mjs) - 32 checks, independent JCS, Horizon re-read
- [`scripts/bootstrap-testnet.mjs`](../../scripts/bootstrap-testnet.mjs) - Friendbot accounts and channel provisioning, no stored secrets
- [`demo.sh`](../../demo.sh) - the one-command path, with preflight checks for failures people actually hit
- [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) - the conformance job
- [`scripts/summarize-outcomes.mjs`](../../scripts/summarize-outcomes.mjs) - figures derived from durable logs
- [`facilitator-service/src/logger.ts`](../../facilitator-service/src/logger.ts) - the `request_outcome` line those figures come from
- RFP §3.6 - "conformance is a hard acceptance criterion"

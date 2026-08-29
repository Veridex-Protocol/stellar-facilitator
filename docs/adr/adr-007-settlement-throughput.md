# ADR-007: Settlement Throughput - Channel Accounts Are Necessary, a Leasing Scheduler Makes Them Sufficient

## Status

Accepted (2026-08-23) - records why settlement concurrency is bounded by a lease over channel accounts rather than left to round-robin, after a measured settlement took 307 seconds and returned a 502 to a buyer whose payment had already succeeded.

Refines the channel account pool in [spec-v2.md §7](../specifications/spec-v2.md), which specified round-robin leasing without the exclusion invariant.

## Context

The project brief asks for this explicitly:

> Throughput. Agent traffic is bursty. Describe how sequence number bottlenecks are avoided under load, for example channel accounts.

A Stellar account has exactly one sequence number. Two transactions submitted concurrently from the same account race: one lands, the other returns `tx_bad_seq` and is retried until it happens to win.

We ran the conformance harness with `CHANNEL_POOL_SIZE=0` - a single signer - and two settlements overlapped. The structured log:

```
/settle settled  transaction 3ef04dd9…  latencyMs 4738
/settle settled  transaction 703d2149…  latencyMs 307614
```

**307,614ms.** Five minutes and seven seconds. The resource server's HTTP client had timed out long before and returned **502 to the buyer - whose payment then settled successfully.** The buyer paid and got an error.

That is the worst failure class a payments system has: money moved, the payer was told it did not.

The instructive part is what happens with channel accounts but without exclusion. `@x402/stellar` selects signers **round-robin** by default. Round-robin makes a collision *less likely* - it does not prevent one. With N signers, the N+1th concurrent request lands on an account already in flight, and the same race occurs. Round-robin is a load spreader, not a mutual exclusion primitive, and treating it as one leaves a rare, load-dependent, extremely expensive bug.

So channel accounts are necessary and not sufficient. The missing piece is: **no account may have two settlements in flight, ever.**

## Decision

**Lease a signer before `settle()` is called, pin the package's selection to it, and queue - then refuse - rather than let two settlements share a sequence number.**

### 1. The pool is the concurrency control

[`SettleScheduler`](../../facilitator-service/src/settle-scheduler.ts) holds idle and busy sets. `withSigner()` acquires a lease, runs the settlement, and releases in a `finally`. A released signer is handed **directly to the next waiter** rather than returned to the idle list, so a later arrival cannot jump the FIFO queue.

Settlement concurrency is therefore exactly the pool size, and the honest way to raise it is to fund more channel accounts.

### 2. `AsyncLocalStorage` bridges to a synchronous hook

The package's hook is `selectSigner?: (addresses: readonly string[]) => string` - **synchronous**, so it cannot await a lease. The choice is made before `settle()` is entered and carried in on the async context:

```ts
async withSigner<T>(operation: (address: string) => Promise<T>): Promise<T> {
  const lease = await this.acquire();
  try {
    return await settleContext.run({ address: lease.address }, () => operation(lease.address));
  } finally {
    lease.release();
  }
}

selectSigner = (addresses: readonly string[]): string => {
  const pinned = settleContext.getStore()?.address;
  if (pinned && addresses.includes(pinned)) return pinned;
  return addresses[0];   // a caller that bypassed withSigner still works
};
```

### 3. Saturation is a fast, explicit refusal

Past `SETTLE_QUEUE_TIMEOUT_MS` (30s), the request is refused with `settlement_capacity_exceeded`, HTTP **503**, a `Retry-After`, and a message that states *nothing was submitted and no funds moved* and names the remedy.

A prompt "busy, nothing moved" is a far better answer to an agent than a request that hangs until something upstream times out ambiguously. The ambiguous case is the 502-after-payment above.

### 4. Bootstrap provisions a real pool

`npm run setup` Friendbot-funds three channel accounts by default (`CHANNEL_COUNT`) and writes `CHANNEL_SECRET_KEYS`, so the out-of-the-box configuration has genuine concurrency instead of the serialising single-signer default.

### 5. It is measurable, and measured

[`concurrency-probe.mjs`](../../scripts/concurrency-probe.mjs) fires N settlements simultaneously, re-reads each from Horizon, and reports distinct source accounts and scheduler counters. Six concurrent settlements against four signers:

```
succeeded           6/6
confirmed on ledger 6/6
latency             min 6509ms  p50 11884ms  max 11991ms
source accounts     3 distinct
scheduler           3 queued, 0 refused, longest wait 7658ms
```

Tail latency **11,991ms against 307,614ms** - and the three that queued were served in order rather than racing. `/stats` exposes the same counters under `settlementConcurrency`.

## Consequences

**Good**

- Two settlements can never share a sequence number, by construction rather than by probability.
- The pathological tail is gone: ~26× improvement on the measured worst case, and no ambiguous timeout.
- Saturation has a defined, documented behaviour a client can act on, with a machine-readable reason and a `Retry-After`.
- Capacity is observable. A rising `queued` or any `totalRejected` means the pool is undersized, visible in `/stats` before it becomes a user-facing failure.
- 12 scheduler tests assert the invariants directly, including that a lease is released when the settlement throws - a leak would deadlock every later settlement.

**Costs accepted**

- **Throughput is hard-capped at the pool size.** Deliberate, and it means sizing the pool is an operator responsibility the service cannot paper over. Under-provision and users get 503s that a naive implementation would have served slowly.
- **In-process only.** The scheduler is per-instance memory. Two facilitator instances sharing one channel account would collide exactly as before. Multi-instance deployments must partition `CHANNEL_SECRET_KEYS` disjointly - an operational constraint that is documented and not enforced by code.
- **`AsyncLocalStorage` is subtle.** The pinning is invisible at the call site and depends on context propagation through the package's internals. The fallback to `addresses[0]` prevents a hard failure if context is lost, which also means a lost context degrades silently to the old behaviour. Mitigated by asserting the pinning in test.
- **Queue waits add latency to legitimate bursts.** A settlement can wait up to 30s before it starts. Correct - that is the queue working - but p99 under burst is worse than an unbounded implementation that occasionally gets lucky.
- **Channel accounts must stay funded.** Each pays Soroban resource fees; an exhausted channel becomes a failing signer. Balance monitoring is in the go-live checklist, not in code.

**Deliberately not done**

- **No dynamic pool sizing.** Auto-creating channel accounts under load would mint keys and spend XLM in response to traffic - including hostile traffic. `CHANNEL_AUTO_CREATE` exists for disposable testing and is documented as unsafe elsewhere.
- **No cross-instance coordination.** A distributed lease needs Redis or Postgres advisory locks and a whole failure model. The per-instance backstop plus disjoint partitioning is the smaller correct answer for now.
- **No priority queueing.** FIFO only. Fair, and it means a large buyer cannot jump the queue.
- **No speculative pre-signing.** Preparing transactions before a lease is available would reintroduce the possibility of two prepared transactions for one account.

## References

- [`facilitator-service/src/settle-scheduler.ts`](../../facilitator-service/src/settle-scheduler.ts) - leasing, FIFO hand-off, the timeout refusal
- [`facilitator-service/src/stellar/x402-facilitator.ts`](../../facilitator-service/src/stellar/x402-facilitator.ts) - `selectSigner` wired to the scheduler
- [`facilitator-service/src/channel/pool.ts`](../../facilitator-service/src/channel/pool.ts) - channel key management, cooldown, sequence resync
- [`facilitator-service/src/__tests__/settle-scheduler.test.ts`](../../facilitator-service/src/__tests__/settle-scheduler.test.ts) - exclusion, FIFO, release-on-throw, refusal
- [`scripts/concurrency-probe.mjs`](../../scripts/concurrency-probe.mjs) - the measurement above
- Project brief §3.5 - the throughput requirement this answers

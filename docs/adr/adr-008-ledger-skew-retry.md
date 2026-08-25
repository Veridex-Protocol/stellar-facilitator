# ADR-008: Ledger-Skew Retry - Narrow, Slow, and Never on a Transaction That Reached the Network

## Status

Accepted (2026-08-23) - records why exactly one rejection code is retried, why the delay must outlast a ledger close, and why a failure carrying a transaction hash is never retried regardless of reason.

The underlying defect is tracked upstream at [x402-foundation/x402#3168](https://github.com/x402-foundation/x402/issues/3168), which we credit for the diagnosis.

## Context

Soroban's public testnet RPC endpoint is load-balanced across nodes at different ledger heights. Both parties read a height and independently compute how far ahead an authorization may expire:

- the **client** reads a height from one node and signs an authorization expiring a fixed distance ahead of it;
- the **facilitator** reads a height from another node and checks that distance.

When the client's node is ahead of the facilitator's, a perfectly valid payment is rejected as expiring too far in the future - `invalid_exact_stellar_signature_expiration_too_far`. Measured divergence reaches 3 ledgers while `@x402/stellar` tolerates 2.

This is an upstream defect, not ours, and it is not ours to fix in the package. It is ours to survive: a facilitator that intermittently rejects good payments is unusable regardless of whose bug it is.

The naive response - widen the tolerance - is wrong. The expiration check is a security property: it bounds how long a signed authorization stays live. Relaxing it to paper over infrastructure jitter trades a real guarantee for a convenience.

The subtler trap is retry timing, and the instinct to retry fast is exactly wrong here. Any schedule whose attempts all land inside a single ledger close observes the identical divergence every time: the lagging node has not advanced between them, so nothing has changed to re-sample. **Re-sampling only helps if it reaches a different node *or* the laggard catches up**, and only the second is guaranteed: after a ledger closes, roughly every 5 seconds. Retries bunched inside one close window are the same failure repeated, wearing a retry's clothing.

## Decision

**Retry exactly one reason code, wait longer than a ledger close, and never retry a result that carries a transaction hash.**

### 1. One code, by name

```ts
export const LEDGER_SKEW_REASON = "invalid_exact_stellar_signature_expiration_too_far";
```

Everything else is final. A wrong amount, a wrong recipient, a malformed envelope, an insufficient balance - none become correct on a second attempt, and retrying them wastes the caller's time and our RPC budget.

The retry relaxes nothing. The full check still runs, in the package, on every attempt. All that changes is that the ledger height is re-sampled - exactly what a client's own retry would do.

### 2. The delay outlasts a ledger close

`LEDGER_SKEW_RETRY_DELAY_MS` defaults to **6000ms**, comfortably past the ~5s close. Two retries by default, so a genuine rejection of this type takes ~12s to return.

That cost is the intended trade: **a slow "no" beats losing a valid payment.** A test asserts the shipped default exceeds 5s, so the constant cannot quietly regress below a close.

### 3. A transaction hash makes a failure final

```ts
export function settleRetryReason(result): string | undefined {
  if (result.success) return undefined;
  if (result.transaction) return undefined;   // it reached the network
  return result.errorReason;
}
```

A failure carrying a hash reached the network. Its true outcome is on the ledger, whatever the response says. Retrying risks settling the same payment twice, and **double-settling is categorically worse than failing a valid payment** - the first is unrecoverable value loss for a payer, the second is a retry.

This rule is unconditional. It outranks the reason code entirely: a skew rejection that somehow carries a hash is not retried.

### 4. Retries are counted and visible

Each request's structured outcome carries `skewRetries`, and `/stats` exposes `ledgerSkew.{retriesIssued, recoveredAfterRetry}` - so retry volume and recovery rate are measurable rather than assumed.

### 5. The reason explains itself

The reason table tells an integrator this is usually infrastructure, that we already retried, and what to do:

> The authorization entry's signature expiration ledger is too far in the future. This is usually Soroban RPC ledger-height skew rather than a bad payment (see x402-foundation/x402#3168); the facilitator already retried. Re-signing with a freshly read ledger height will succeed.

## Consequences

**Good**

- Valid payments survive RPC skew without weakening the expiration check.
- Double settlement is structurally impossible via this path: the hash rule is checked before the reason.
- Recovery is measurable, so the mitigation's value can be reported rather than claimed.
- The fix is scoped tightly enough to reason about. One code, one condition, one delay.

**Costs accepted**

- **Genuine rejections of this type take ~12s.** Real latency on a real error path, paid by every legitimately-too-far authorization.
- **Retries hold a signer lease for the whole window.** Under [ADR-007](./adr-007-settlement-throughput.md), a settlement retrying skew occupies a channel account for ~12s, so skew events reduce effective concurrency exactly when they occur.
- **We have never observed a live recovery.** [`retry.test.ts`](../../facilitator-service/src/__tests__/retry.test.ts) reproduces the sequence deterministically, but no real degraded RPC window has occurred while we were watching. The mitigation is tested, not field-proven, and `testnet_docs.md` records that honestly.
- **The reason code is a string match against the package.** A rename upstream silently disables the retry. The reason table test asserts the code still exists in the installed package, which converts that into a test failure rather than a silent regression.

**Deliberately not done**

- **No widening of the expiration tolerance.** That is the security property, not the bug.
- **No retry of any other code.** Including transient-looking RPC errors - those need a different treatment with a different safety analysis.
- **No exponential backoff.** The delay is tied to a physical constant (the ledger close), not to congestion. Backing off further would only add latency.
- **No client-side pre-flight height reconciliation.** Having the facilitator publish its observed height so clients could align is arguably the better fix and belongs upstream, not in one facilitator's behaviour.

## References

- [`facilitator-service/src/retry.ts`](../../facilitator-service/src/retry.ts) - the retry, and why the delay is what it is
- [`facilitator-service/src/reasons.ts`](../../facilitator-service/src/reasons.ts) - `LEDGER_SKEW_REASON` and its explanation
- [`facilitator-service/src/__tests__/retry.test.ts`](../../facilitator-service/src/__tests__/retry.test.ts) - recovery, exhaustion, no-retry-on-other-codes, no-retry-with-hash, and the >5s default assertion
- [x402-foundation/x402#3168](https://github.com/x402-foundation/x402/issues/3168) - the upstream report

/**
 * Veridex Facilitator Service - Settlement Scheduler
 * License: Apache-2.0
 *
 * Every settlement is a Stellar transaction whose source account is one of this
 * facilitator's signers, and a Stellar account has exactly one sequence number.
 * Two settlements submitted concurrently from the same account race for it: one
 * lands, the other comes back `tx_bad_seq` and is retried by the package until
 * it happens to win. That retry loop is where a settlement was observed taking
 * 307 seconds while the resource server's HTTP client had long since given up
 * the buyer paid and got a 502.
 *
 * Agent traffic is bursty, so this is a load-shape problem rather than an edge
 * case. Channel accounts are the standard remedy: several funded accounts
 * whose sequence numbers advance independently. That is necessary but not
 * sufficient `@x402/stellar` round-robins across signers, which makes a
 * collision less likely without preventing one. With N signers, the N+1st
 * concurrent request still lands on an account that is already in flight.
 *
 * So this scheduler makes the pool the actual concurrency control:
 *
 *  - a settlement leases a signer before `settle()` is called, and no signer is
 *    ever leased twice at once, so two transactions never share a sequence
 *    number;
 *  - `selectSigner` is pinned to the leased address through `AsyncLocalStorage`,
 *    because the package's hook is synchronous and cannot await a lease itself;
 *  - when every signer is busy the request waits in FIFO order and, past a
 *    bounded timeout, is refused with a reason. A fast, explicit "busy" is a
 *    better answer than a five-minute hang that ends in a timeout somewhere
 *    upstream, and it is one an agent can act on.
 *
 * Throughput is therefore the pool size, and the honest way to raise it is to
 * fund more channel accounts.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** The signer pinned for the current settlement, read by `selectSigner`. */
export const settleContext = new AsyncLocalStorage<{ address: string }>();

export interface SignerLease {
  address: string;
  /** Returns the signer to the pool. Must run exactly once, in a finally. */
  release(): void;
}

export class SignerBusyError extends Error {
  constructor(
    message: string,
    readonly waitedMs: number,
    readonly poolSize: number,
  ) {
    super(message);
    this.name = "SignerBusyError";
  }
}

interface Waiter {
  resolve(lease: SignerLease): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  queuedAt: number;
}

export interface SettleSchedulerStats {
  poolSize: number;
  inFlight: number;
  queued: number;
  /** Requests that waited for a signer rather than getting one immediately. */
  totalQueued: number;
  /** Requests refused because no signer freed up in time. */
  totalRejected: number;
  maxObservedWaitMs: number;
}

export class SettleScheduler {
  private idle: string[];
  private readonly busy = new Set<string>();
  private readonly waiters: Waiter[] = [];
  private stats = { totalQueued: 0, totalRejected: 0, maxObservedWaitMs: 0 };

  /**
   * @param addresses - Signer addresses available for settlement
   * @param queueTimeoutMs - How long a request may wait for a free signer
   */
  constructor(
    addresses: string[],
    private readonly queueTimeoutMs: number,
  ) {
    this.idle = [...addresses];
  }

  /** Signer addresses this scheduler manages. */
  get poolSize(): number {
    return this.idle.length + this.busy.size;
  }

  /**
   * Replaces the signer set, for example after the channel pool initializes.
   *
   * Only safe while nothing is in flight, which is true at startup.
   *
   * @param addresses - The new signer addresses
   */
  setSigners(addresses: string[]): void {
    if (this.busy.size > 0) {
      throw new Error("Cannot change the signer set while settlements are in flight");
    }
    this.idle = [...addresses];
  }

  /**
   * Leases a signer for one settlement.
   *
   * @returns The leased signer, which the caller must release
   * @throws {SignerBusyError} When no signer becomes free within the timeout
   */
  async acquire(): Promise<SignerLease> {
    if (this.poolSize === 0) {
      throw new Error("No settlement signers are configured");
    }

    const address = this.idle.shift();
    if (address !== undefined) {
      this.busy.add(address);
      return this.leaseFor(address);
    }

    // Every signer is in flight. Wait in order rather than racing for a
    // sequence number we would lose.
    this.stats.totalQueued++;
    const queuedAt = Date.now();

    return new Promise<SignerLease>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        queuedAt,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) this.waiters.splice(index, 1);
          this.stats.totalRejected++;
          reject(
            new SignerBusyError(
              `All ${this.poolSize} settlement signers were busy for ${this.queueTimeoutMs}ms. ` +
                "Nothing was submitted and no funds moved; retry, or raise throughput by funding " +
                "more channel accounts in CHANNEL_SECRET_KEYS.",
              Date.now() - queuedAt,
              this.poolSize,
            ),
          );
        }, this.queueTimeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  /**
   * Builds a lease that hands the signer to the next waiter on release.
   *
   * @param address - The leased signer address
   * @returns The lease
   */
  private leaseFor(address: string): SignerLease {
    let released = false;
    return {
      address,
      release: () => {
        if (released) return;
        released = true;

        const waiter = this.waiters.shift();
        if (waiter) {
          // Hand the signer straight over: it never returns to the idle list,
          // so a later arrival cannot jump the queue.
          clearTimeout(waiter.timer);
          const waited = Date.now() - waiter.queuedAt;
          if (waited > this.stats.maxObservedWaitMs) this.stats.maxObservedWaitMs = waited;
          waiter.resolve(this.leaseFor(address));
          return;
        }

        this.busy.delete(address);
        this.idle.push(address);
      },
    };
  }

  /**
   * Runs an operation with a signer leased and pinned for `selectSigner`.
   *
   * @param operation - The settlement, which must be the only user of this signer
   * @returns Whatever the operation returns
   * @throws {SignerBusyError} When no signer becomes free within the timeout
   */
  async withSigner<T>(operation: (address: string) => Promise<T>): Promise<T> {
    const lease = await this.acquire();
    try {
      return await settleContext.run({ address: lease.address }, () => operation(lease.address));
    } finally {
      lease.release();
    }
  }

  /**
   * Selects the signer for the settlement running on this async context.
   *
   * Passed to `ExactStellarScheme` as its `selectSigner` hook. The hook is
   * synchronous, so the choice has to be made before `settle()` is entered and
   * carried in here; falling back to the first address keeps a caller that
   * bypassed `withSigner` working rather than throwing mid-settlement.
   *
   * @param addresses - Addresses the scheme knows about
   * @returns The address to sign with
   */
  selectSigner = (addresses: readonly string[]): string => {
    const pinned = settleContext.getStore()?.address;
    if (pinned && addresses.includes(pinned)) return pinned;
    return addresses[0];
  };

  /**
   * Returns counters for `/stats`.
   *
   * @returns Current and cumulative scheduler statistics
   */
  getStats(): SettleSchedulerStats {
    return {
      poolSize: this.poolSize,
      inFlight: this.busy.size,
      queued: this.waiters.length,
      ...this.stats,
    };
  }
}

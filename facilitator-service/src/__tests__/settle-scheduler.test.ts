import { describe, expect, it } from "vitest";
import { SettleScheduler, SignerBusyError, settleContext } from "../settle-scheduler.js";

const A = "GAAAA";
const B = "GBBBB";
const C = "GCCCC";

/**
 * Resolves after a delay.
 *
 * @param ms - Milliseconds to wait
 * @returns A promise resolving after the delay
 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("settlement scheduler", () => {
  it("never leases the same signer to two settlements at once", async () => {
    // This is the whole point: a Stellar account has one sequence number, so
    // two concurrent transactions from it race and one loses.
    const scheduler = new SettleScheduler([A], 5_000);
    const active: string[] = [];
    let maxConcurrent = 0;

    await Promise.all(
      Array.from({ length: 8 }, () =>
        scheduler.withSigner(async (address) => {
          active.push(address);
          maxConcurrent = Math.max(maxConcurrent, active.length);
          await sleep(5);
          active.splice(active.indexOf(address), 1);
        }),
      ),
    );

    expect(maxConcurrent).toBe(1);
    expect(scheduler.getStats().totalQueued).toBe(7);
  });

  it("runs one settlement per signer concurrently across the pool", async () => {
    const scheduler = new SettleScheduler([A, B, C], 5_000);
    const inFlight = new Set<string>();
    let maxConcurrent = 0;

    await Promise.all(
      Array.from({ length: 3 }, () =>
        scheduler.withSigner(async (address) => {
          expect(inFlight.has(address), "a signer was leased twice at once").toBe(false);
          inFlight.add(address);
          maxConcurrent = Math.max(maxConcurrent, inFlight.size);
          await sleep(10);
          inFlight.delete(address);
        }),
      ),
    );

    // Throughput is the pool size: three signers, three settlements at once.
    expect(maxConcurrent).toBe(3);
    expect(scheduler.getStats().totalQueued).toBe(0);
  });

  it("pins selectSigner to the leased address", async () => {
    // The package's selectSigner hook is synchronous and cannot await a lease,
    // so the choice is carried in through AsyncLocalStorage.
    const scheduler = new SettleScheduler([A, B], 5_000);
    const observed: string[] = [];

    await Promise.all(
      Array.from({ length: 2 }, () =>
        scheduler.withSigner(async (leased) => {
          await sleep(5);
          const chosen = scheduler.selectSigner([A, B]);
          expect(chosen, "selectSigner must return the signer this settlement leased").toBe(leased);
          observed.push(chosen);
        }),
      ),
    );

    expect(new Set(observed).size).toBe(2);
  });

  it("waits for the payer-authorized signer instead of leasing another account", async () => {
    const scheduler = new SettleScheduler([A, B], 5_000);
    const holding = scheduler.withSigner(async (address) => {
      expect(address).toBe(A);
      await sleep(30);
    }, A);

    await sleep(5);
    const selected = scheduler.withSigner(async (address) => address, A);
    await expect(selected).resolves.toBe(A);
    await holding;
  });

  it("falls back to a real address outside a lease rather than throwing", () => {
    const scheduler = new SettleScheduler([A, B], 5_000);
    expect(settleContext.getStore()).toBeUndefined();
    expect([A, B]).toContain(scheduler.selectSigner([A, B]));
  });

  it("refuses with a usable error instead of hanging when the pool is saturated", async () => {
    // The failure this replaces: a settlement that retried tx_bad_seq for 307
    // seconds while the caller's HTTP client had already timed out.
    const scheduler = new SettleScheduler([A], 50);
    const holding = scheduler.withSigner(async () => {
      await sleep(400);
    });

    await expect(scheduler.withSigner(async () => "never runs")).rejects.toThrow(SignerBusyError);
    await holding;

    const stats = scheduler.getStats();
    expect(stats.totalRejected).toBe(1);
  });

  it("says how to raise throughput when it refuses", async () => {
    const scheduler = new SettleScheduler([A], 20);
    const holding = scheduler.withSigner(async () => {
      await sleep(200);
    });

    await expect(scheduler.withSigner(async () => 1)).rejects.toThrow(
      /no funds moved.*CHANNEL_SECRET_KEYS/s,
    );
    await holding;
  });

  it("releases the signer even when the settlement throws", async () => {
    const scheduler = new SettleScheduler([A], 1_000);

    await expect(
      scheduler.withSigner(async () => {
        throw new Error("settlement blew up");
      }),
    ).rejects.toThrow("settlement blew up");

    // A leaked lease would deadlock every later settlement.
    expect(scheduler.getStats().inFlight).toBe(0);
    await expect(scheduler.withSigner(async () => "ok")).resolves.toBe("ok");
  });

  it("serves waiters in the order they arrived", async () => {
    const scheduler = new SettleScheduler([A], 5_000);
    const order: number[] = [];

    const blocker = scheduler.withSigner(async () => {
      await sleep(30);
    });
    // Give the blocker time to take the only signer before the others queue.
    await sleep(5);

    const queued = [1, 2, 3].map((n) =>
      scheduler.withSigner(async () => {
        order.push(n);
      }),
    );

    await Promise.all([blocker, ...queued]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("hands a released signer straight to a waiter, not back to the idle list", async () => {
    const scheduler = new SettleScheduler([A], 5_000);
    const blocker = scheduler.withSigner(async () => sleep(20));
    await sleep(5);

    const waiter = scheduler.withSigner(async () => "waited");
    expect(scheduler.getStats().queued).toBe(1);

    await Promise.all([blocker, waiter]);
    expect(scheduler.getStats()).toMatchObject({ inFlight: 0, queued: 0, poolSize: 1 });
  });

  it("refuses to swap signers while settlements are in flight", async () => {
    const scheduler = new SettleScheduler([A], 5_000);
    const holding = scheduler.withSigner(async () => sleep(30));
    await sleep(5);

    expect(() => scheduler.setSigners([B])).toThrow(/while settlements are in flight/);
    await holding;
    expect(() => scheduler.setSigners([B])).not.toThrow();
    expect(scheduler.poolSize).toBe(1);
  });

  it("reports a pool with no signers rather than queueing forever", async () => {
    const scheduler = new SettleScheduler([], 5_000);
    await expect(scheduler.withSigner(async () => 1)).rejects.toThrow(/No settlement signers/);
  });

  it("records the longest wait, so an undersized pool is visible in /stats", async () => {
    const scheduler = new SettleScheduler([A], 5_000);
    const blocker = scheduler.withSigner(async () => sleep(40));
    await sleep(5);
    const waiter = scheduler.withSigner(async () => "ok");

    await Promise.all([blocker, waiter]);
    expect(scheduler.getStats().maxObservedWaitMs).toBeGreaterThan(0);
  });

  it("quarantines the exact signer used by an uncertain post-submit result", async () => {
    const scheduler = new SettleScheduler([A, B], 50);
    const result = await scheduler.withSigner(
      async (address) => ({ success: false, transaction: "a".repeat(64), address }),
      undefined,
      (settlement) => !settlement.success && Boolean(settlement.transaction),
    );

    expect(scheduler.getQuarantinedSigners()).toEqual([result.address]);
    expect(scheduler.getStats()).toMatchObject({ poolSize: 2, available: 1, quarantined: 1, inFlight: 0 });
  });

  it("releases a signer after a definitive pre-submit failure", async () => {
    const scheduler = new SettleScheduler([A], 50);
    await scheduler.withSigner(
      async () => ({ success: false, transaction: "" }),
      undefined,
      (settlement) => !settlement.success && Boolean(settlement.transaction),
    );

    expect(scheduler.getStats()).toMatchObject({ available: 1, quarantined: 0 });
  });

  it("requires explicit recovery before a quarantined signer can settle again", async () => {
    const scheduler = new SettleScheduler([A], 20);
    await scheduler.withSigner(async () => "uncertain", A, () => true);

    await expect(scheduler.withSigner(async () => "never", A)).rejects.toThrow(/quarantined/);
    expect(scheduler.recoverSigner(A)).toBe(true);
    await expect(scheduler.withSigner(async () => "recovered", A)).resolves.toBe("recovered");
    expect(scheduler.recoverSigner(A)).toBe(false);
  });
});

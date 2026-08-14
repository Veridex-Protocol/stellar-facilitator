/**
 * Veridex Facilitator Service - Channel Pool Concurrency & Recovery Tests
 * License: Apache-2.0
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import { ChannelAccountPool } from "../channel/pool.js";
import { ChannelAccountState } from "../channel/types.js";

describe("Channel Pool Concurrency & Recovery", () => {
  let pool: ChannelAccountPool;
  let sourceKeypair: Keypair;

  beforeEach(() => {
    sourceKeypair = Keypair.random();
    pool = new ChannelAccountPool({
      poolSize: 3,
      networkPassphrase: Networks.TESTNET,
      horizonUrl: "https://horizon-testnet.stellar.org",
      sourceSecretKey: sourceKeypair.secret(),
      cooldownMs: 200,
      channelStartingBalance: "5",
      refillThreshold: "2",
      refillAmount: "3",
    });
  });

  it("should handle rapid channel acquisitions and state transitions mock", () => {
    // Inject mock channels directly to test state machine & concurrency logic
    const channelsMap = (pool as any).channels as Map<string, any>;

    const channelKeys: string[] = [];
    for (let i = 0; i < 3; i++) {
      const kp = Keypair.random();
      const pk = kp.publicKey();
      channelKeys.push(pk);
      channelsMap.set(pk, {
        publicKey: pk,
        keypair: kp,
        state: ChannelAccountState.AVAILABLE,
        transactionCount: 0,
        lastUsedAt: 0,
        sequence: "100",
      });
    }

    (pool as any).isInitialized = true;

    const stats = pool.getStats();
    expect(stats.total).toBe(3);
    expect(stats.available).toBe(3);
  });

  it("should queue acquisition requests when all channels are in-use", async () => {
    const channelsMap = (pool as any).channels as Map<string, any>;
    const kp = Keypair.random();
    const pk = kp.publicKey();

    channelsMap.set(pk, {
      publicKey: pk,
      keypair: kp,
      state: ChannelAccountState.AVAILABLE,
      transactionCount: 0,
      lastUsedAt: 0,
      sequence: "100",
    });

    (pool as any).isInitialized = true;

    // First acquire
    const acq1 = await pool.acquire();
    expect(acq1.channel.publicKey).toBe(pk);
    expect(pool.getStats().inUse).toBe(1);

    // Second acquire should queue
    let acquiredSecond = false;
    const acq2Promise = pool.acquire().then((res) => {
      acquiredSecond = true;
      return res;
    });

    expect(acquiredSecond).toBe(false);
    expect(pool.getStats().queueLength).toBe(1);

    // Release first channel
    await acq1.release();

    // Now second acquire resolves
    const acq2 = await acq2Promise;
    expect(acq2.channel.publicKey).toBe(pk);
    await acq2.release();
  });
});

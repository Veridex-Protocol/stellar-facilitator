/**
 * Veridex Facilitator Service - Channel Account Pool Tests
 * License: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import { ChannelAccountPool } from "../channel/pool.js";
import { ChannelAccountState } from "../channel/types.js";

describe("ChannelAccountPool", () => {
  let pool: ChannelAccountPool;
  let sourceKeypair: Keypair;

  beforeEach(() => {
    sourceKeypair = Keypair.random();
    pool = new ChannelAccountPool({
      poolSize: 3,
      networkPassphrase: Networks.TESTNET,
      horizonUrl: "https://horizon-testnet.stellar.org",
      sourceSecretKey: sourceKeypair.secret(),
      cooldownMs: 500,
      channelStartingBalance: "5",
      refillThreshold: "2",
      refillAmount: "3",
    });
  });

  it("should instantiate with correct configuration", () => {
    expect(pool).toBeDefined();
    const stats = pool.getStats();
    expect(stats.total).toBe(0); // Not initialized yet
  });

  it("should handle channel acquisition errors when pool is not initialized", async () => {
    await expect(pool.acquire()).rejects.toThrow("Channel pool not initialized");
  });

  it("should return empty channel list before initialization", () => {
    const channels = pool.getAllChannels();
    expect(channels).toEqual([]);
  });

  it("should track stats correctly", () => {
    const stats = pool.getStats();
    expect(stats).toEqual({
      total: 0,
      available: 0,
      inUse: 0,
      cooldown: 0,
      error: 0,
      queueLength: 0,
      totalTransactions: 0,
    });
  });
});

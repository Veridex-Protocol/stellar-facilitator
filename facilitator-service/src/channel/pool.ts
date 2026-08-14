/**
 * Veridex Facilitator Service - Channel Account Pool
 * License: Apache-2.0
 *
 * Manages a pool of 50 Stellar channel accounts for parallel transaction submission.
 * Each channel account acts as a transaction source to avoid sequence number conflicts.
 *
 * Features:
 * - Automatic channel creation and funding
 * - Concurrent transaction support via round-robin allocation
 * - Cooldown period after use
 * - Automatic balance monitoring and refill
 * - Error recovery and channel rotation
 */

import {
  Keypair,
  Horizon,
  TransactionBuilder,
  Operation,
  Asset,
  Networks,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import type {
  ChannelAccount,
  ChannelAccountState,
  ChannelPoolConfig,
  ChannelAcquisition,
} from "./types.js";
import { ChannelAccountState as State } from "./types.js";

/**
 * Channel Account Pool Manager
 *
 * Maintains a pool of funded Stellar accounts for parallel transaction submission.
 */
export class ChannelAccountPool {
  private config: ChannelPoolConfig;
  private server: Horizon.Server;
  private sourceKeypair: Keypair;
  private channels: Map<string, ChannelAccount>;
  private acquisitionQueue: Array<{
    resolve: (channel: ChannelAcquisition) => void;
    reject: (error: Error) => void;
  }>;
  private isInitialized: boolean = false;
  private monitoringInterval: NodeJS.Timeout | null = null;

  constructor(config: ChannelPoolConfig) {
    this.config = config;
    this.server = new Horizon.Server(config.horizonUrl);
    this.sourceKeypair = Keypair.fromSecret(config.sourceSecretKey);
    this.channels = new Map();
    this.acquisitionQueue = [];
  }

  /**
   * Initialize the channel pool
   *
   * Creates and funds all channel accounts if they don't exist.
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      console.log("[Channel Pool] Already initialized");
      return;
    }

    console.log(`[Channel Pool] Initializing ${this.config.poolSize} channel accounts...`);

    const configuredSecrets = this.config.channelSecretKeys || [];
    if (this.config.poolSize > configuredSecrets.length && !this.config.autoCreateChannels) {
      throw new Error(
        `CHANNEL_POOL_SIZE=${this.config.poolSize} requires ${this.config.poolSize} durable ` +
          `CHANNEL_SECRET_KEYS entries (or CHANNEL_AUTO_CREATE=true for development)`
      );
    }

    for (let i = 0; i < this.config.poolSize; i++) {
      // All account-creation transactions share one source sequence number.
      // Serialize them so a fresh pool cannot submit conflicting sequences.
      const configuredSecret = configuredSecrets[i];
      const keypair = configuredSecret ? Keypair.fromSecret(configuredSecret) : Keypair.random();
      await this.initializeChannel(i, keypair);
    }

    this.isInitialized = true;
    console.log(`[Channel Pool] ✓ Initialized ${this.channels.size} channels`);

    // Start background monitoring
    this.startMonitoring();
  }

  /**
   * Initialize a single channel account
   */
  private async initializeChannel(index: number, keypair: Keypair): Promise<void> {
    try {
      const publicKey = keypair.publicKey();

      // Check if account exists on network
      let accountExists = false;
      let sequence = "0";

      try {
        const account = await this.server.loadAccount(publicKey);
        accountExists = true;
        sequence = account.sequence;
      } catch (error: any) {
        if (error?.response?.status !== 404) {
          throw error;
        }
      }

      // Create account if it doesn't exist
      if (!accountExists) {
        console.log(`[Channel Pool] Creating channel ${index}: ${publicKey}`);
        await this.createAndFundChannel(keypair);

        // Load sequence number
        const account = await this.server.loadAccount(publicKey);
        sequence = account.sequence;
      }

      // Add to pool
      const channel: ChannelAccount = {
        publicKey,
        keypair,
        state: State.AVAILABLE,
        transactionCount: 0,
        lastUsedAt: 0,
        sequence,
      };

      this.channels.set(publicKey, channel);
      console.log(`[Channel Pool] ✓ Channel ${index} ready: ${publicKey}`);
    } catch (error) {
      console.error(`[Channel Pool] Failed to initialize channel ${index}:`, error);
      throw error;
    }
  }

  /**
   * Create and fund a new channel account
   */
  private async createAndFundChannel(channelKeypair: Keypair): Promise<void> {
    const sourceAccount = await this.server.loadAccount(this.sourceKeypair.publicKey());

    const transaction = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        Operation.createAccount({
          destination: channelKeypair.publicKey(),
          startingBalance: this.config.channelStartingBalance,
        })
      )
      .setTimeout(30)
      .build();

    transaction.sign(this.sourceKeypair);

    await this.server.submitTransaction(transaction);
  }

  /**
   * Acquire a channel account for transaction submission
   *
   * Returns a promise that resolves when a channel becomes available.
   */
  async acquire(): Promise<ChannelAcquisition> {
    if (!this.isInitialized) {
      throw new Error("Channel pool not initialized");
    }

    // Try to get an available channel immediately
    const available = this.getAvailableChannel();

    if (available) {
      return this.markAsInUse(available);
    }

    // No channels available, queue the request
    return new Promise<ChannelAcquisition>((resolve, reject) => {
      this.acquisitionQueue.push({ resolve, reject });

      // Timeout after 30 seconds
      setTimeout(() => {
        const index = this.acquisitionQueue.findIndex((r) => r.resolve === resolve);
        if (index !== -1) {
          this.acquisitionQueue.splice(index, 1);
          reject(new Error("Channel acquisition timeout (30s)"));
        }
      }, 30_000);
    });
  }

  /**
   * Get an available channel (round-robin)
   */
  private getAvailableChannel(): ChannelAccount | null {
    const availableChannels = Array.from(this.channels.values()).filter(
      (ch) => ch.state === State.AVAILABLE
    );

    if (availableChannels.length === 0) {
      // Check for cooldown channels that can be released
      this.processCooldowns();
      return null;
    }

    // Round-robin: return least recently used
    availableChannels.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    return availableChannels[0];
  }

  /**
   * Mark channel as in-use and return acquisition
   */
  private markAsInUse(channel: ChannelAccount): ChannelAcquisition {
    channel.state = State.IN_USE;
    channel.lastUsedAt = Date.now();

    const release = async () => {
      await this.releaseChannel(channel.publicKey);
    };

    return {
      channel,
      release,
    };
  }

  /**
   * Release a channel back to the pool
   */
  private async releaseChannel(publicKey: string): Promise<void> {
    const channel = this.channels.get(publicKey);

    if (!channel) {
      console.warn(`[Channel Pool] Attempted to release unknown channel: ${publicKey}`);
      return;
    }

    if (channel.state !== State.IN_USE) {
      console.warn(`[Channel Pool] Channel not in use: ${publicKey}`);
      return;
    }

    // Increment transaction count
    channel.transactionCount++;

    // Move to cooldown
    channel.state = State.COOLDOWN;
    channel.lastUsedAt = Date.now();

    console.log(
      `[Channel Pool] Released channel ${publicKey} (${channel.transactionCount} txs)`
    );

    // Schedule cooldown expiration
    setTimeout(() => {
      this.processCooldowns();
      this.processQueue();
    }, this.config.cooldownMs);

    // Process queue if any
    this.processQueue();
  }

  /**
   * Process cooldown channels and mark as available
   */
  private processCooldowns(): void {
    const now = Date.now();

    for (const channel of this.channels.values()) {
      if (channel.state === State.COOLDOWN) {
        const cooldownElapsed = now - channel.lastUsedAt;

        if (cooldownElapsed >= this.config.cooldownMs) {
          channel.state = State.AVAILABLE;
          console.log(`[Channel Pool] Channel ${channel.publicKey} available (cooldown complete)`);
        }
      }
    }
  }

  /**
   * Process queued acquisition requests
   */
  private processQueue(): void {
    if (this.acquisitionQueue.length === 0) {
      return;
    }

    const available = this.getAvailableChannel();

    if (available) {
      const request = this.acquisitionQueue.shift();
      if (request) {
        const acquisition = this.markAsInUse(available);
        request.resolve(acquisition);

        // Continue processing
        if (this.acquisitionQueue.length > 0) {
          setImmediate(() => this.processQueue());
        }
      }
    }
  }

  /**
   * Start background monitoring for balance refills
   */
  private startMonitoring(): void {
    this.monitoringInterval = setInterval(async () => {
      await this.monitorBalances();
    }, 60_000); // Check every minute
  }

  /**
   * Monitor channel balances and refill if needed
   */
  private async monitorBalances(): Promise<void> {
    const refillThreshold = parseFloat(this.config.refillThreshold);

    for (const channel of this.channels.values()) {
      try {
        const account = await this.server.loadAccount(channel.publicKey);
        const balance = parseFloat(
          account.balances.find((b) => b.asset_type === "native")?.balance || "0"
        );

        if (balance < refillThreshold) {
          console.log(
            `[Channel Pool] Channel ${channel.publicKey} below threshold (${balance} XLM), refilling...`
          );
          await this.refillChannel(channel);
        }
      } catch (error) {
        console.error(`[Channel Pool] Failed to check balance for ${channel.publicKey}:`, error);
      }
    }
  }

  /**
   * Refill a channel account
   */
  private async refillChannel(channel: ChannelAccount): Promise<void> {
    try {
      const sourceAccount = await this.server.loadAccount(this.sourceKeypair.publicKey());

      const transaction = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.config.networkPassphrase,
      })
        .addOperation(
          Operation.payment({
            destination: channel.publicKey,
            asset: Asset.native(),
            amount: this.config.refillAmount,
          })
        )
        .setTimeout(30)
        .build();

      transaction.sign(this.sourceKeypair);

      await this.server.submitTransaction(transaction);

      console.log(`[Channel Pool] ✓ Refilled ${channel.publicKey} with ${this.config.refillAmount} XLM`);
    } catch (error) {
      console.error(`[Channel Pool] Failed to refill ${channel.publicKey}:`, error);
      channel.state = State.ERROR;
      channel.error = error instanceof Error ? error.message : "Unknown error";
    }
  }

  /**
   * Get pool statistics
   */
  getStats(): {
    total: number;
    available: number;
    inUse: number;
    cooldown: number;
    error: number;
    queueLength: number;
    totalTransactions: number;
  } {
    const channels = Array.from(this.channels.values());

    return {
      total: channels.length,
      available: channels.filter((ch) => ch.state === State.AVAILABLE).length,
      inUse: channels.filter((ch) => ch.state === State.IN_USE).length,
      cooldown: channels.filter((ch) => ch.state === State.COOLDOWN).length,
      error: channels.filter((ch) => ch.state === State.ERROR).length,
      queueLength: this.acquisitionQueue.length,
      totalTransactions: channels.reduce((sum, ch) => sum + ch.transactionCount, 0),
    };
  }

  /**
   * Get all channel accounts (for x402 signer adapter)
   *
   * @returns Array of all channel accounts
   */
  getAllChannels(): ChannelAccount[] {
    return Array.from(this.channels.values());
  }

  /**
   * Shutdown the pool
   */
  async shutdown(): Promise<void> {
    console.log("[Channel Pool] Shutting down...");
    this.isInitialized = false;

    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }

    // Reject all queued requests
    for (const request of this.acquisitionQueue) {
      request.reject(new Error("Channel pool shutting down"));
    }

    this.acquisitionQueue = [];
    console.log("[Channel Pool] Shutdown complete");
  }
}

/**
 * Create channel pool with default configuration
 */
export function createChannelPool(config: Partial<ChannelPoolConfig>): ChannelAccountPool {
  const defaultConfig: ChannelPoolConfig = {
    poolSize: 50,
    networkPassphrase: Networks.TESTNET,
    horizonUrl: "https://horizon-testnet.stellar.org",
    sourceSecretKey: "",
    channelSecretKeys: [],
    autoCreateChannels: false,
    cooldownMs: 5000, // 5 seconds
    channelStartingBalance: "5", // 5 XLM
    refillThreshold: "2", // Refill when below 2 XLM
    refillAmount: "3", // Add 3 XLM
    ...config,
  };

  if (!defaultConfig.sourceSecretKey) {
    throw new Error("Source secret key is required for channel pool");
  }

  return new ChannelAccountPool(defaultConfig);
}

/**
 * Veridex Bazaar Discovery Engine - Liveness Circuit Breaker
 * License: Apache-2.0
 *
 * Implements auto-pruning logic for unresponsive nodes:
 * - HEALTHY: < 1 missed heartbeat
 * - DEGRADED: 1-3 missed heartbeats (70% ranking penalty)
 * - OFFLINE: > 3 missed heartbeats (filtered from search)
 *
 * Usage:
 * ```typescript
 * const breaker = new LivenessCircuitBreaker();
 * const status = breaker.evaluateNodeStatus(lastHeartbeatAt.getTime());
 * const multiplier = breaker.getSearchMultiplier(status);
 * const adjustedScore = compositeScore * multiplier;
 * ```
 */

export enum LivenessStatus {
  HEALTHY = "HEALTHY",
  DEGRADED = "DEGRADED",
  OFFLINE = "OFFLINE",
}

/**
 * Constants for circuit breaker configuration
 */
export const HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds
export const MAX_MISSED_HEARTBEATS = 3;

export interface LivenessConfig {
  heartbeatIntervalMs: number;
  maxMissedHeartbeats: number;
}

export const DEFAULT_LIVENESS_CONFIG: LivenessConfig = {
  heartbeatIntervalMs: 30_000, // 30 seconds
  maxMissedHeartbeats: 3,
};

export class LivenessCircuitBreaker {
  private config: LivenessConfig;

  constructor(config: Partial<LivenessConfig> = {}) {
    this.config = { ...DEFAULT_LIVENESS_CONFIG, ...config };
  }

  /**
   * Evaluate node status based on last seen timestamp
   *
   * @param lastSeenTimestampMs - Last heartbeat timestamp in milliseconds
   * @returns Current liveness status
   */
  evaluateNodeStatus(lastSeenTimestampMs: number): LivenessStatus {
    const elapsed = Date.now() - lastSeenTimestampMs;
    const missedPings = Math.floor(elapsed / this.config.heartbeatIntervalMs);

    if (missedPings < 1) {
      return LivenessStatus.HEALTHY;
    }

    if (missedPings <= this.config.maxMissedHeartbeats) {
      return LivenessStatus.DEGRADED;
    }

    return LivenessStatus.OFFLINE;
  }

  /**
   * Get search ranking multiplier for a liveness status
   *
   * @param status - Current liveness status
   * @returns Multiplier to apply to composite score (0.0 to 1.0)
   */
  getSearchMultiplier(status: LivenessStatus): number {
    switch (status) {
      case LivenessStatus.HEALTHY:
        return 1.0;
      case LivenessStatus.DEGRADED:
        return 0.3; // 70% penalty
      case LivenessStatus.OFFLINE:
        return 0.0; // Filtered out
      default:
        return 0.0;
    }
  }

  /**
   * Check if a node should be included in search results
   *
   * @param status - Current liveness status
   * @returns true if node should be included
   */
  shouldIncludeInSearch(status: LivenessStatus): boolean {
    return status !== LivenessStatus.OFFLINE;
  }

  /**
   * Calculate uptime ratio from heartbeat history
   *
   * @param successfulPings - Number of successful heartbeats
   * @param expectedPings - Expected number of heartbeats
   * @returns Uptime ratio (0.0 to 1.0)
   */
  calculateUptimeRatio(successfulPings: number, expectedPings: number): number {
    if (expectedPings === 0) {
      return 1.0;
    }

    return Math.min(1.0, successfulPings / expectedPings);
  }

  /**
   * Get expected number of pings in a time window
   *
   * @param windowMs - Time window in milliseconds
   * @returns Expected number of heartbeat pings
   */
  getExpectedPingsInWindow(windowMs: number): number {
    return Math.floor(windowMs / this.config.heartbeatIntervalMs);
  }
}

/**
 * Veridex Bazaar Discovery Engine - Telemetry Tracker
 * License: Apache-2.0
 *
 * Tracks and updates resource telemetry metrics:
 * - Response time (exponential moving average)
 * - Uptime ratio (30-day window)
 * - Settlement success/failure counts
 * - Liveness status from circuit breaker
 *
 * Integrates with P2P mesh to process heartbeat messages and
 * update the resource_telemetry table in PostgreSQL.
 */

import type { Pool as PoolType } from "pg";
import { Database } from "../db/config.js";
import {
  LivenessCircuitBreaker,
  LivenessStatus,
  HEARTBEAT_INTERVAL_MS,
  MAX_MISSED_HEARTBEATS,
  SETTLEMENT_LIVENESS_WINDOW_MS,
} from "./circuit-breaker.js";
import type { AnnounceMessage } from "../p2p/types.js";

/**
 * Telemetry data interface
 */
export interface Telemetry {
  resourceId: string;
  nodeId?: string;
  avgResponseTimeMs: number;
  uptimeRatio: number;
  settlementCount: number;
  failedSettlementCount: number;
  lastHeartbeatAt: Date;
  heartbeatSequence: number;
}

/**
 * Telemetry Tracker
 *
 * Responsibilities:
 * - Process P2P heartbeat messages
 * - Update telemetry metrics in database
 * - Calculate uptime ratios from heartbeat history
 * - Determine liveness status via circuit breaker
 * - Record settlement events (success/failure)
 */
export class TelemetryTracker {
  private db: Database;
  private circuitBreaker: LivenessCircuitBreaker;

  constructor(db: Database, circuitBreaker?: LivenessCircuitBreaker) {
    this.db = db;
    this.circuitBreaker = circuitBreaker || new LivenessCircuitBreaker();
  }

  /**
   * Process an incoming heartbeat announcement message
   *
   * Flow:
   * 1. Find or skip if resource doesn't exist in catalog
   * 2. Record heartbeat in audit log (node_heartbeats table)
   * 3. Calculate 30-day uptime ratio from heartbeat history
   * 4. Update resource_telemetry with new metrics
   * 5. Apply exponential moving average to response time
   *
   * @param message - Announcement message from P2P mesh
   */
  async processHeartbeat(message: AnnounceMessage): Promise<void> {
    const pool = this.db.getPool();
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      // Find resource in catalog
      const resourceResult = await client.query(
        `SELECT id FROM catalog_resources
         WHERE resource_url = $1 AND COALESCE(tool_name, '') = COALESCE($2, '')`,
        [message.resourceUrl, message.toolName || null]
      );

      if (resourceResult.rows.length === 0) {
        // Resource not in catalog yet - skip telemetry update
        // It will be added by the ingestion worker when first payment settles
        await client.query("ROLLBACK");
        return;
      }

      const resourceId = resourceResult.rows[0].id;

      // Record heartbeat in audit log
      await client.query(
        `INSERT INTO node_heartbeats (
          node_id, resource_url, tool_name, timestamp, sequence,
          avg_response_time_ms, uptime_30d, successful_settlements, signature
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (node_id, sequence) DO NOTHING`,
        [
          message.nodeId,
          message.resourceUrl,
          message.toolName || null,
          message.timestamp,
          message.sequence,
          message.telemetry.avgResponseTimeMs,
          message.telemetry.uptime30d,
          message.telemetry.successfulSettlements || 0,
          message.signature,
        ]
      );

      // Calculate uptime ratio from last 30 days of heartbeats
      const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const expectedPings = this.circuitBreaker.getExpectedPingsInWindow(
        30 * 24 * 60 * 60 * 1000
      );

      const uptimeResult = await client.query(
        `SELECT COUNT(*) as successful_pings
         FROM node_heartbeats
         WHERE resource_url = $1
           AND COALESCE(tool_name, '') = COALESCE($2, '')
           AND timestamp >= $3`,
        [message.resourceUrl, message.toolName || null, thirtyDaysAgo]
      );

      const successfulPings = parseInt(uptimeResult.rows[0].successful_pings);
      const uptimeRatio = this.circuitBreaker.calculateUptimeRatio(
        successfulPings,
        expectedPings
      );

      // Update or insert telemetry record
      // Use exponential moving average for response time: new = old * 0.7 + current * 0.3
      await client.query(
        `INSERT INTO resource_telemetry (
          resource_id, node_id, last_heartbeat_at, heartbeat_sequence,
          avg_response_time_ms, uptime_ratio
        )
        VALUES ($1, $2, to_timestamp($3 / 1000.0), $4, $5, $6)
        ON CONFLICT (resource_id)
        DO UPDATE SET
          node_id = EXCLUDED.node_id,
          last_heartbeat_at = EXCLUDED.last_heartbeat_at,
          heartbeat_sequence = GREATEST(resource_telemetry.heartbeat_sequence, EXCLUDED.heartbeat_sequence),
          avg_response_time_ms = (resource_telemetry.avg_response_time_ms * 0.7) + (EXCLUDED.avg_response_time_ms * 0.3),
          uptime_ratio = EXCLUDED.uptime_ratio,
          liveness_status = 'HEALTHY',
          updated_at = now()`,
        [
          resourceId,
          message.nodeId,
          message.timestamp,
          message.sequence,
          message.telemetry.avgResponseTimeMs,
          uptimeRatio,
        ]
      );

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("[Telemetry Tracker] Error processing heartbeat:", error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Record a successful settlement
   *
   * Called by the facilitator after a successful payment settlement.
   *
   * @param resourceId - UUID of the resource
   */
  async recordSuccessfulSettlement(resourceId: string): Promise<void> {
    await this.db.query(
      `UPDATE resource_telemetry
       SET settlement_count = settlement_count + 1,
           updated_at = now()
       WHERE resource_id = $1`,
      [resourceId]
    );
  }

  /**
   * Record a failed settlement
   *
   * Called by the facilitator when a settlement fails.
   *
   * @param resourceId - UUID of the resource
   */
  async recordFailedSettlement(resourceId: string): Promise<void> {
    await this.db.query(
      `UPDATE resource_telemetry
       SET failed_settlement_count = failed_settlement_count + 1,
           updated_at = now()
       WHERE resource_id = $1`,
      [resourceId]
    );
  }

  /**
   * Get telemetry data for a resource
   *
   * @param resourceId - UUID of the resource
   * @returns Telemetry data or null if not found
   */
  async getTelemetry(resourceId: string): Promise<Telemetry | null> {
    const result = await this.db.query<any>(
      `SELECT
        resource_id,
        node_id,
        avg_response_time_ms,
        uptime_ratio,
        settlement_count,
        failed_settlement_count,
        last_heartbeat_at,
        heartbeat_sequence
       FROM resource_telemetry
       WHERE resource_id = $1`,
      [resourceId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      resourceId: row.resource_id,
      nodeId: row.node_id,
      avgResponseTimeMs: parseFloat(row.avg_response_time_ms),
      uptimeRatio: parseFloat(row.uptime_ratio),
      settlementCount: parseInt(row.settlement_count),
      failedSettlementCount: parseInt(row.failed_settlement_count),
      lastHeartbeatAt: row.last_heartbeat_at,
      heartbeatSequence: parseInt(row.heartbeat_sequence),
    };
  }

  /**
   * Auto-prune offline nodes (circuit breaker)
   *
   * Updates liveness status from the most recent liveness signal: a P2P
   * heartbeat, or a settlement this service confirmed on Horizon.
   *
   * Heartbeats alone are not enough. A seller who simply exposes a paid
   * endpoint and never joins the mesh produces no heartbeats at all, so
   * heartbeat-only pruning marked every auto-catalogued resource OFFLINE within
   * minutes and removed it from search - with nothing wrong with it. A payment
   * that settled is proof the endpoint was reachable and served someone.
   *
   * Should be called periodically (e.g., every 5 minutes).
   *
   * @returns Number of nodes marked offline
   */
  async pruneOfflineNodes(): Promise<number> {
    // Two independent liveness signals, either of which keeps a resource
    // discoverable. Heartbeats are frequent and cheap; settlements are sparse
    // but far stronger evidence, so they get a much longer window.
    const result = await this.db.query(
      `UPDATE resource_telemetry
       SET liveness_status = CASE
             WHEN last_heartbeat_at >= now() - interval '${HEARTBEAT_INTERVAL_MS} milliseconds' THEN 'HEALTHY'
             WHEN last_settlement_at >= now() - interval '${SETTLEMENT_LIVENESS_WINDOW_MS} milliseconds' THEN 'HEALTHY'
             WHEN last_heartbeat_at >= now() - interval '${HEARTBEAT_INTERVAL_MS * MAX_MISSED_HEARTBEATS} milliseconds' THEN 'DEGRADED'
             WHEN last_settlement_at >= now() - interval '${SETTLEMENT_LIVENESS_WINDOW_MS * 7} milliseconds' THEN 'DEGRADED'
             ELSE 'OFFLINE'
           END,
           updated_at = now()
       WHERE liveness_status IS DISTINCT FROM CASE
             WHEN last_heartbeat_at >= now() - interval '${HEARTBEAT_INTERVAL_MS} milliseconds' THEN 'HEALTHY'
             WHEN last_settlement_at >= now() - interval '${SETTLEMENT_LIVENESS_WINDOW_MS} milliseconds' THEN 'HEALTHY'
             WHEN last_heartbeat_at >= now() - interval '${HEARTBEAT_INTERVAL_MS * MAX_MISSED_HEARTBEATS} milliseconds' THEN 'DEGRADED'
             WHEN last_settlement_at >= now() - interval '${SETTLEMENT_LIVENESS_WINDOW_MS * 7} milliseconds' THEN 'DEGRADED'
             ELSE 'OFFLINE'
           END
       RETURNING resource_id`
    );

    const prunedCount = result.rowCount || 0;

    if (prunedCount > 0) {
      console.log(`[Telemetry Tracker] Identified ${prunedCount} offline nodes`);
    }

    return prunedCount;
  }

  /**
   * Get statistics for all tracked resources
   *
   * @returns Summary statistics
   */
  async getStats(): Promise<{
    totalResources: number;
    healthyNodes: number;
    degradedNodes: number;
    offlineNodes: number;
    avgUptime: number;
    totalSettlements: number;
  }> {
    const result = await this.db.query<any>(`
      SELECT
        COUNT(*) as total_resources,
        AVG(uptime_ratio) as avg_uptime,
        SUM(settlement_count) as total_settlements
      FROM resource_telemetry
    `);

    const row = result.rows[0];
    // Count nodes by liveness status
    const telemetryResult = await this.db.query<any>(`
      SELECT last_heartbeat_at, last_settlement_at FROM resource_telemetry
    `);

    let healthy = 0;
    let degraded = 0;
    let offline = 0;

    for (const telemetry of telemetryResult.rows) {
      const status = this.circuitBreaker.evaluateResourceStatus(
        telemetry.last_heartbeat_at ? telemetry.last_heartbeat_at.getTime() : null,
        telemetry.last_settlement_at ? telemetry.last_settlement_at.getTime() : null,
      );

      if (status === LivenessStatus.HEALTHY) healthy++;
      else if (status === LivenessStatus.DEGRADED) degraded++;
      else offline++;
    }

    return {
      totalResources: parseInt(row.total_resources) || 0,
      healthyNodes: healthy,
      degradedNodes: degraded,
      offlineNodes: offline,
      avgUptime: parseFloat(row.avg_uptime) || 0,
      totalSettlements: parseInt(row.total_settlements) || 0,
    };
  }

  /**
   * Close database connection
   */
  async close(): Promise<void> {
    await this.db.close();
  }
}

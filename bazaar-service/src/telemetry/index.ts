/**
 * Veridex Bazaar Discovery Engine - Telemetry Module
 * License: Apache-2.0
 *
 * Exports telemetry tracking and liveness monitoring:
 * - TelemetryTracker: Process heartbeats and record settlements
 * - LivenessCircuitBreaker: Evaluate node health status
 * - Types: Telemetry data and liveness enums
 */

export * from "./circuit-breaker.js";
export * from "./tracker.js";

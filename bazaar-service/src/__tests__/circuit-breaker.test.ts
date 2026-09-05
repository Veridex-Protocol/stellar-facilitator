import { describe, expect, it } from "vitest";
import {
  HEARTBEAT_INTERVAL_MS,
  LivenessCircuitBreaker,
  LivenessStatus,
  SETTLEMENT_LIVENESS_WINDOW_MS,
} from "../telemetry/circuit-breaker.js";

describe("resource liveness", () => {
  const breaker = new LivenessCircuitBreaker();
  const now = 1_700_000_000_000;

  it("uses a recent heartbeat as healthy evidence", () => {
    expect(breaker.evaluateResourceStatus(now - HEARTBEAT_INTERVAL_MS + 1, null, now)).toBe(LivenessStatus.HEALTHY);
  });

  it("uses a recent settlement as independent healthy evidence", () => {
    expect(breaker.evaluateResourceStatus(null, now - SETTLEMENT_LIVENESS_WINDOW_MS + 1, now)).toBe(LivenessStatus.HEALTHY);
  });

  it("does not treat an old settlement as current", () => {
    expect(breaker.evaluateResourceStatus(null, now - SETTLEMENT_LIVENESS_WINDOW_MS * 8, now)).toBe(LivenessStatus.OFFLINE);
  });
});
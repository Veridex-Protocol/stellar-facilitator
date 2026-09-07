import assert from "node:assert/strict";
import test from "node:test";
import { assessConcurrencyReport } from "./concurrency-assessment.mjs";

test("accepts bounded capacity rejection in saturation mode", () => {
  assert.deepEqual(assessConcurrencyReport({
    succeeded: 9,
    confirmedOnLedger: 9,
    retryCount: 0,
    sequenceErrors: 0,
    reasonCounts: { settlement_capacity_exceeded: 1 },
  }, { allowCapacityRejection: true }), {
    safetyPassed: true,
    allowCapacityRejection: true,
    expectedCapacityRejections: 1,
    unexpectedFailures: 0,
    unexpectedFailureReasons: {},
    unconfirmedSuccesses: 0,
  });
});

test("keeps capacity rejection strict outside saturation mode", () => {
  const result = assessConcurrencyReport({
    succeeded: 9,
    confirmedOnLedger: 9,
    retryCount: 0,
    sequenceErrors: 0,
    reasonCounts: { settlement_capacity_exceeded: 1 },
  });
  assert.equal(result.safetyPassed, false);
  assert.equal(result.unexpectedFailures, 1);
});

test("fails on sequence errors, retries, unconfirmed success, or other failures", () => {
  const result = assessConcurrencyReport({
    succeeded: 3,
    confirmedOnLedger: 2,
    retryCount: 1,
    sequenceErrors: 1,
    reasonCounts: {
      settlement_capacity_exceeded: 4,
      invalid_exact_stellar_payload_simulation_failed: 2,
    },
  }, { allowCapacityRejection: true });
  assert.equal(result.safetyPassed, false);
  assert.equal(result.expectedCapacityRejections, 4);
  assert.equal(result.unexpectedFailures, 2);
  assert.equal(result.unconfirmedSuccesses, 1);
});
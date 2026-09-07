export function assessConcurrencyReport(report, options = {}) {
  const allowCapacityRejection = options.allowCapacityRejection === true;
  const expectedCapacityRejections = Number(report.reasonCounts?.settlement_capacity_exceeded ?? 0);
  const unexpectedFailureReasons = Object.fromEntries(
    Object.entries(report.reasonCounts ?? {}).filter(([reason]) =>
      reason !== "settlement_capacity_exceeded" || !allowCapacityRejection
    ),
  );
  const unexpectedFailures = Object.values(unexpectedFailureReasons)
    .reduce((sum, count) => sum + Number(count), 0);
  const unconfirmedSuccesses = Math.max(0, Number(report.succeeded ?? 0) - Number(report.confirmedOnLedger ?? 0));
  const safetyPassed =
    Number(report.sequenceErrors ?? 0) === 0 &&
    Number(report.retryCount ?? 0) === 0 &&
    unexpectedFailures === 0 &&
    unconfirmedSuccesses === 0;

  return {
    safetyPassed,
    allowCapacityRejection,
    expectedCapacityRejections,
    unexpectedFailures,
    unexpectedFailureReasons,
    unconfirmedSuccesses,
  };
}
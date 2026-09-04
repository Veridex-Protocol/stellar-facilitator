/**
 * Response-aware seller execution for x402 resources.
 * License: Apache-2.0
 */

import {
  verifyProviderOutcome,
  type ProviderOutcome,
  type ProviderOutcomeValidationOptions,
} from "./provider-outcome.js";

export type ChargeDisposition = "settle" | "skip" | "policy_decision";
export type FailureChargePolicy = "settle" | "skip";

export interface ResponseAwareCall<T> {
  result: T;
  outcome: ProviderOutcome;
}

export interface ResponseAwareExecution<T, S> {
  execute: () => Promise<ResponseAwareCall<T>>;
  settle: () => Promise<S>;
  outcomeValidation?: ProviderOutcomeValidationOptions;
  callerFailurePolicy?: FailureChargePolicy;
  ambiguousFailurePolicy?: FailureChargePolicy;
  onObservation?: (outcome: ProviderOutcome) => Promise<void> | void;
  onSettlement?: (outcome: ProviderOutcome, settlement: S) => Promise<void> | void;
}

export interface ResponseAwareResult<T, S> {
  result: T;
  outcome: ProviderOutcome;
  chargeDisposition: ChargeDisposition;
  settled: boolean;
  settlement?: S;
}

export async function executeResponseAware<T, S>(
  execution: ResponseAwareExecution<T, S>,
): Promise<ResponseAwareResult<T, S>> {
  const call = await execution.execute();
  const validation = verifyProviderOutcome(call.outcome, execution.outcomeValidation);
  if (!validation.valid) throw new Error(validation.error);

  await execution.onObservation?.(call.outcome);

  const decision = decideChargeDisposition(call.outcome, execution);
  if (!decision.shouldSettle) {
    return {
      result: call.result,
      outcome: call.outcome,
      chargeDisposition: decision.chargeDisposition,
      settled: false,
    };
  }

  const settlement = await execution.settle();
  await execution.onSettlement?.(call.outcome, settlement);
  return {
    result: call.result,
    outcome: call.outcome,
    chargeDisposition: decision.chargeDisposition,
    settled: true,
    settlement,
  };
}

function decideChargeDisposition<T, S>(
  outcome: ProviderOutcome,
  execution: ResponseAwareExecution<T, S>,
): { chargeDisposition: ChargeDisposition; shouldSettle: boolean } {
  if (outcome.usable) return { chargeDisposition: "settle", shouldSettle: true };
  if (outcome.providerAtFault) return { chargeDisposition: "skip", shouldSettle: false };

  const policy = outcome.attributable === "caller"
    ? execution.callerFailurePolicy ?? "skip"
    : execution.ambiguousFailurePolicy ?? "skip";
  return { chargeDisposition: "policy_decision", shouldSettle: policy === "settle" };
}
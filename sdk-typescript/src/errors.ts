/** Canonical outward-facing Veridex error contract. License: Apache-2.0 */

import registry from "../../error-registry.json" with { type: "json" };

export type VeridexErrorCategory = "validation" | "network" | "payment" | "provider" | "discovery";
export type VeridexRegisteredErrorCode = keyof typeof registry;

export interface VeridexPublicError {
  code: string;
  reason: string;
  retryable: boolean;
  category: VeridexErrorCategory;
  details?: Record<string, unknown>;
}

export function publicError(
  code: VeridexRegisteredErrorCode,
  options: { reason?: string; details?: Record<string, unknown> } = {},
): VeridexPublicError {
  const definition = registry[code];
  return {
    code,
    reason: options.reason?.trim() || definition.reason,
    retryable: definition.retryable,
    category: definition.category as VeridexErrorCategory,
    ...(options.details ? { details: options.details } : {}),
  };
}

export { registry as VERIDEX_ERROR_REGISTRY };
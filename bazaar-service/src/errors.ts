/** Canonical outward-facing Veridex error adapter. License: Apache-2.0 */

import registry from "../../error-registry.json" with { type: "json" };

export type RegisteredErrorCode = keyof typeof registry;

export function publicError(
  code: RegisteredErrorCode,
  options: { reason?: string; details?: Record<string, unknown> } = {},
) {
  const definition = registry[code];
  return {
    code,
    reason: options.reason?.trim() || definition.reason,
    retryable: definition.retryable,
    category: definition.category,
    ...(options.details ? { details: options.details } : {}),
  };
}
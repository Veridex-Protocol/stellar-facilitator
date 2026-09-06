import { describe, expect, it } from "vitest";
import { VERIDEX_ERROR_REGISTRY, publicError } from "../errors.js";

describe("canonical Veridex error registry", () => {
  it("defines a stable non-empty contract for every registered code", () => {
    for (const [code, definition] of Object.entries(VERIDEX_ERROR_REGISTRY)) {
      expect(code).toMatch(/^[a-z][a-z0-9_]+$/);
      expect(definition.reason.trim().length).toBeGreaterThan(0);
      expect(typeof definition.retryable).toBe("boolean");
      expect(["validation", "network", "payment", "provider", "discovery"]).toContain(definition.category);
    }
  });

  it("uses the registered reason when an override is blank", () => {
    expect(publicError("payment_rejected", { reason: "  " })).toEqual({
      code: "payment_rejected",
      reason: VERIDEX_ERROR_REGISTRY.payment_rejected.reason,
      retryable: false,
      category: "payment",
    });
  });
});
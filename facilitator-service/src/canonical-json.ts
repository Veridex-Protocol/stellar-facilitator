/**
 * Veridex Facilitator Service - JSON Canonicalization Scheme (RFC 8785)
 * License: Apache-2.0
 *
 * Anything that gets signed or digested has to serialize to the same bytes on
 * both sides, every time. `JSON.stringify(value, Object.keys(value).sort())`
 * looks like it does that and does not: the array form of the replacer is an
 * *allowlist applied at every nesting level*, so a nested object whose keys are
 * absent from the top-level key list serializes as `{}`. A receipt signed that
 * way covers none of its nested claims.
 *
 * This is RFC 8785 (JCS) instead: keys sorted by UTF-16 code unit, no
 * whitespace, ECMAScript number formatting, applied recursively.
 */

/**
 * Serializes a value to its RFC 8785 canonical JSON form.
 *
 * @param value - Any JSON-serializable value
 * @returns The canonical JSON string
 * @throws {TypeError} When the value contains a non-finite number, a BigInt, or a cycle
 */
export function canonicalize(value: unknown): string {
  return serialize(value, new WeakSet());
}

/**
 * Serializes one value, tracking visited objects to reject cycles.
 *
 * @param value - Value to serialize
 * @param seen - Objects currently on the serialization stack
 * @returns Canonical JSON for this value
 */
function serialize(value: unknown, seen: WeakSet<object>): string {
  // Mirror JSON.stringify: toJSON() wins before anything else is considered.
  if (value !== null && typeof value === "object" && typeof (value as any).toJSON === "function") {
    return serialize((value as any).toJSON(), seen);
  }

  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";

    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`Cannot canonicalize non-finite number: ${value}`);
      }
      // RFC 8785 mandates ECMAScript Number::toString, which is what
      // JSON.stringify emits. It also normalizes -0 to 0, as required.
      return JSON.stringify(value);

    case "string":
      // JSON.stringify's string escaping is exactly the escaping JCS specifies.
      return JSON.stringify(value);

    case "bigint":
      throw new TypeError("Cannot canonicalize BigInt: JSON has no representation for it");

    case "undefined":
    case "function":
    case "symbol":
      // Only reachable at the top level; inside arrays and objects these are
      // handled below, the same way JSON.stringify handles them.
      return "null";
  }

  const object = value as object;
  if (seen.has(object)) {
    throw new TypeError("Cannot canonicalize a structure containing a cycle");
  }
  seen.add(object);

  try {
    if (Array.isArray(object)) {
      const items = object.map((item) => {
        const type = typeof item;
        // JSON.stringify turns holes and non-serializable entries into null.
        if (item === undefined || type === "function" || type === "symbol") return "null";
        return serialize(item, seen);
      });
      return `[${items.join(",")}]`;
    }

    const entries: string[] = [];
    // Sort by UTF-16 code unit, which is what the default string comparison
    // does in JavaScript and what RFC 8785 requires.
    for (const key of Object.keys(object).sort()) {
      const entry = (object as Record<string, unknown>)[key];
      const type = typeof entry;
      // Omitted, exactly as JSON.stringify omits them.
      if (entry === undefined || type === "function" || type === "symbol") continue;
      entries.push(`${JSON.stringify(key)}:${serialize(entry, seen)}`);
    }
    return `{${entries.join(",")}}`;
  } finally {
    seen.delete(object);
  }
}

/**
 * Veridex Bazaar Discovery Engine - JSON Canonicalization Scheme (RFC 8785)
 * License: Apache-2.0
 *
 * Deterministic JSON serialization for canonical hashing and Ed25519 signing.
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

function serialize(value: unknown, seen: WeakSet<object>): string {
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
      return JSON.stringify(value);

    case "string":
      return JSON.stringify(value);

    case "bigint":
      throw new TypeError("Cannot canonicalize BigInt: JSON has no representation for it");

    case "undefined":
    case "symbol":
    case "function":
      return "";

    case "object": {
      if (seen.has(value)) {
        throw new TypeError("Cannot canonicalize object with cyclic references");
      }
      seen.add(value);
      try {
        if (Array.isArray(value)) {
          const elements = value.map((elem) => {
            const result = serialize(elem, seen);
            return result === "" ? "null" : result;
          });
          return `[${elements.join(",")}]`;
        }

        // Keys sorted strictly by UTF-16 code units
        const keys = Object.keys(value).sort();
        const entries: string[] = [];
        for (const key of keys) {
          const propVal = (value as Record<string, unknown>)[key];
          if (
            propVal === undefined ||
            typeof propVal === "symbol" ||
            typeof propVal === "function"
          ) {
            continue;
          }
          const serializedKey = JSON.stringify(key);
          const serializedVal = serialize(propVal, seen);
          if (serializedVal !== "") {
            entries.push(`${serializedKey}:${serializedVal}`);
          }
        }
        return `{${entries.join(",")}}`;
      } finally {
        seen.delete(value);
      }
    }
  }
}

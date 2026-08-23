/**
 * RFC 8785 canonical JSON, reimplemented for the browser.
 * License: Apache-2.0
 *
 * Deliberately a second implementation. The facilitator canonicalizes a receipt
 * with `facilitator-service/src/canonical-json.ts` before signing it; the
 * conformance harness canonicalizes it again with its own copy before checking
 * the signature. This is the third, and it runs in the visitor's browser.
 *
 * Verifying a receipt with the code that produced it proves only that the code
 * agrees with itself. The point of a recomputable receipt is that an
 * independent implementation reaches the same bytes - so this file must not
 * import anything from the service, and must not be refactored into a shared
 * helper with it.
 */

/**
 * Serializes a value to RFC 8785 canonical JSON.
 *
 * @param value - Any JSON-serializable value
 * @returns The canonical JSON string
 */
export function jcs(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : jcs(item))).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${jcs(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  return "null";
}

/**
 * Computes the `sha256:<hex>` digest of a value's canonical form.
 *
 * Uses WebCrypto, so the digest is computed by the browser rather than by any
 * code this playground ships.
 *
 * @param value - A string, or any value to canonicalize first
 * @returns The digest in `sha256:<hex>` form
 */
export async function digest(value: unknown): Promise<string> {
  const serialized = typeof value === "string" ? value : jcs(value);
  const bytes = new TextEncoder().encode(serialized);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${toHex(new Uint8Array(hash))}`;
}

/**
 * Renders bytes as lowercase hex.
 *
 * @param bytes - The bytes to render
 * @returns Lowercase hex
 */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Parses lowercase or uppercase hex into bytes.
 *
 * @param hex - Hex string, with an even number of digits
 * @returns The decoded bytes
 * @throws {Error} When the input is not valid hex
 */
export function fromHex(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error("not a hex string");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

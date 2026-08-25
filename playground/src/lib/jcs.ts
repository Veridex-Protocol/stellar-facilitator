/**
 * RFC 8785 JSON Canonicalization Scheme (JCS)
 * License: Apache-2.0
 */

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const entries = value.map((entry) => canonicalize(entry));
    return `[${entries.join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const pairs: string[] = [];

  for (const key of keys) {
    const val = record[key];
    if (val === undefined || typeof val === "symbol") continue;
    pairs.push(`${JSON.stringify(key)}:${canonicalize(val)}`);
  }

  return `{${pairs.join(",")}}`;
}

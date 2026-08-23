/**
 * Veridex Bazaar Discovery Engine - Cursor Pagination
 * License: Apache-2.0
 *
 * The discovery spec pages `/discovery/search` with an opaque cursor rather
 * than a client-supplied offset. Opaque matters for two reasons: it lets the
 * pagination strategy change without breaking callers, and it stops a client
 * inventing an offset into a ranking it never asked for.
 *
 * A cursor here carries the position plus a fingerprint of the query that
 * produced it. Presenting a cursor from one query against a different one is
 * rejected rather than silently answered, because the ranking a cursor points
 * into is only meaningful for the query that built it — the same offset under
 * different terms is a different set of rows.
 *
 * The catalog changes under a paging client, so the spec's `partialResults`
 * flag, not the cursor, is what signals an incomplete view. See engine.ts.
 */

import { createHash } from "node:crypto";

/** Bumped when the encoded shape changes, so old cursors fail cleanly. */
const CURSOR_VERSION = 1;

export interface CursorPayload {
  /** Row offset this cursor resumes from. */
  offset: number;
  /** Page size the cursor was issued with. */
  limit: number;
  /** Fingerprint of the query and filters that produced it. */
  fingerprint: string;
}

export class InvalidCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCursorError";
  }
}

/**
 * Fingerprints the query and filters a cursor belongs to.
 *
 * Uses the canonical ordering of `Object.keys().sort()` at one level, which is
 * enough here because filter values are scalars and string arrays.
 *
 * @param parts - The query terms and filters in force
 * @returns A short stable hash
 */
export function fingerprint(parts: Record<string, unknown>): string {
  const normalized = Object.keys(parts)
    .sort()
    .filter((key) => parts[key] !== undefined && parts[key] !== null)
    .map((key) => `${key}=${Array.isArray(parts[key]) ? [...(parts[key] as unknown[])].sort().join("|") : String(parts[key])}`)
    .join("&");
  return createHash("sha256").update(normalized).digest("base64url").slice(0, 16);
}

/**
 * Encodes a cursor.
 *
 * @param payload - Position and the query fingerprint it belongs to
 * @returns A base64url token
 */
export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(
    JSON.stringify({ v: CURSOR_VERSION, o: payload.offset, l: payload.limit, f: payload.fingerprint }),
  ).toString("base64url");
}

/**
 * Decodes a cursor and confirms it belongs to this query.
 *
 * @param cursor - The token a client presented
 * @param expectedFingerprint - Fingerprint of the query now being run
 * @returns The decoded position
 * @throws {InvalidCursorError} When the token is malformed, stale, or from another query
 */
export function decodeCursor(cursor: string, expectedFingerprint: string): CursorPayload {
  let decoded: any;
  try {
    decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new InvalidCursorError("cursor is not a valid pagination token");
  }

  if (decoded?.v !== CURSOR_VERSION) {
    throw new InvalidCursorError(
      "cursor was issued by an incompatible version of this service; restart paging without a cursor",
    );
  }
  if (!Number.isInteger(decoded.o) || decoded.o < 0 || !Number.isInteger(decoded.l) || decoded.l < 1) {
    throw new InvalidCursorError("cursor carries an invalid position");
  }
  if (decoded.f !== expectedFingerprint) {
    throw new InvalidCursorError(
      "cursor belongs to a different query or filter set; a cursor may only be used to continue the search that produced it",
    );
  }

  return { offset: decoded.o, limit: decoded.l, fingerprint: decoded.f };
}

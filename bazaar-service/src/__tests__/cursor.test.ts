import { describe, expect, it } from "vitest";
import { InvalidCursorError, decodeCursor, encodeCursor, fingerprint } from "../search/cursor.js";

const FP = fingerprint({ q: "weather", network: "stellar:testnet" });

describe("cursor pagination", () => {
  it("round-trips a position", () => {
    const cursor = encodeCursor({ offset: 40, limit: 20, fingerprint: FP });
    expect(decodeCursor(cursor, FP)).toEqual({ offset: 40, limit: 20, fingerprint: FP });
  });

  it("is opaque rather than a readable offset", () => {
    const cursor = encodeCursor({ offset: 40, limit: 20, fingerprint: FP });
    // A client must not be able to read or hand-edit the position; that is the
    // point of the spec asking for a cursor rather than an offset.
    expect(cursor).not.toContain("40");
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("refuses a cursor issued for a different query", () => {
    const cursor = encodeCursor({ offset: 20, limit: 20, fingerprint: FP });
    const otherQuery = fingerprint({ q: "storage", network: "stellar:testnet" });

    // The same offset under different terms is a different set of rows, so
    // answering it would silently return the wrong page.
    expect(() => decodeCursor(cursor, otherQuery)).toThrow(InvalidCursorError);
    expect(() => decodeCursor(cursor, otherQuery)).toThrow(/different query or filter set/);
  });

  it("refuses a cursor issued for a different filter set", () => {
    const withFilter = fingerprint({ q: "weather", network: "stellar:testnet", type: "mcp" });
    const cursor = encodeCursor({ offset: 20, limit: 20, fingerprint: FP });
    expect(() => decodeCursor(cursor, withFilter)).toThrow(InvalidCursorError);
  });

  it("rejects a malformed token", () => {
    expect(() => decodeCursor("not-a-cursor", FP)).toThrow(/not a valid pagination token/);
    expect(() => decodeCursor("", FP)).toThrow(InvalidCursorError);
  });

  it("rejects a token carrying an impossible position", () => {
    const forged = Buffer.from(JSON.stringify({ v: 1, o: -5, l: 20, f: FP })).toString("base64url");
    expect(() => decodeCursor(forged, FP)).toThrow(/invalid position/);
  });

  it("rejects a token from an incompatible version", () => {
    const old = Buffer.from(JSON.stringify({ v: 0, o: 20, l: 20, f: FP })).toString("base64url");
    expect(() => decodeCursor(old, FP)).toThrow(/incompatible version/);
  });

  it("fingerprints independently of key order and array order", () => {
    expect(fingerprint({ a: 1, b: "x" })).toBe(fingerprint({ b: "x", a: 1 }));
    expect(fingerprint({ tags: ["a", "b"] })).toBe(fingerprint({ tags: ["b", "a"] }));
  });

  it("ignores absent filters, so adding an unset filter does not invalidate a cursor", () => {
    expect(fingerprint({ q: "weather" })).toBe(fingerprint({ q: "weather", payTo: undefined }));
  });

  it("distinguishes filters that differ only in value", () => {
    expect(fingerprint({ payTo: "GA" })).not.toBe(fingerprint({ payTo: "GB" }));
  });
});

import { describe, expect, it } from "vitest";
import { canonicalize } from "../canonical-json.js";

describe("RFC 8785 canonicalization", () => {
  it("sorts keys at every nesting level, not just the top one", () => {
    // This is the property the previous implementation lacked. It used
    // JSON.stringify's array-replacer form, which is an allowlist applied
    // recursively, so nested objects collapsed to {}.
    const nested = { b: 1, a: { d: 2, c: { f: 3, e: 4 } } };
    expect(canonicalize(nested)).toBe('{"a":{"c":{"e":4,"f":3},"d":2},"b":1}');
  });

  it("preserves nested values rather than dropping them", () => {
    const value = { top: "x", settlement: { tx: "HASH", amount: "50000" } };
    expect(canonicalize(value)).toContain('"tx":"HASH"');
    expect(canonicalize(value)).toContain('"amount":"50000"');
  });

  it("gives different byte strings to different nested content", () => {
    const a = { s: { tx: "A", amount: "1" } };
    const b = { s: { tx: "B", amount: "999" } };
    expect(canonicalize(a)).not.toBe(canonicalize(b));
  });

  it("is stable across key insertion order", () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
  });

  it("canonicalizes arrays element-wise without reordering them", () => {
    expect(canonicalize([{ b: 1, a: 2 }, 3])).toBe('[{"a":2,"b":1},3]');
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });

  it("normalizes -0 to 0 and rejects non-finite numbers", () => {
    expect(canonicalize({ n: -0 })).toBe('{"n":0}');
    expect(() => canonicalize({ n: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalize({ n: Number.POSITIVE_INFINITY })).toThrow(TypeError);
  });

  it("omits undefined object members and nulls undefined array entries", () => {
    expect(canonicalize({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalize([undefined, 1])).toBe("[null,1]");
  });

  it("escapes strings the way JSON does", () => {
    expect(canonicalize({ s: 'q"\\\n' })).toBe('{"s":"q\\"\\\\\\n"}');
    expect(canonicalize({ s: "é😀" })).toBe('{"s":"é😀"}');
  });

  it("rejects cycles rather than overflowing the stack", () => {
    const cyclic: any = { a: 1 };
    cyclic.self = cyclic;
    expect(() => canonicalize(cyclic)).toThrow(/cycle/i);
  });

  it("honours toJSON, as JSON.stringify does", () => {
    const date = new Date("2026-01-01T00:00:00.000Z");
    expect(canonicalize({ at: date })).toBe('{"at":"2026-01-01T00:00:00.000Z"}');
  });
});

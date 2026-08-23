# ADR-006: Recomputable Receipts — RFC 8785, Because the Obvious Canonicalization Signs Nothing

## Status

Accepted (2026-08-23) — records why `x402job/1` receipts are signed over RFC 8785 canonical JSON, after the previous canonicalization was found to exclude the entire `settlement` object from the signature, making every settlement field freely forgeable.

Implements the receipt format from extension proposal [#3117](https://github.com/x402-foundation/x402).

## Context

A receipt is worth exactly what a third party can recompute from it. `x402job/1` claims a service performed a job, names the settlement that paid for it, and digests the request and result bytes — so a verifier can hash the same bytes, rebuild the claims, and check one signature.

That requires a canonicalization: both sides must reach identical bytes. Ours was:

```ts
const canonicalClaimsStr = JSON.stringify(claims, Object.keys(claims).sort());
```

This looks like "serialize with sorted keys". It is not. The array form of `JSON.stringify`'s second parameter is a **property allowlist applied at every nesting level**, not a key order for the top level. Nested objects are filtered against the *top-level* key list.

`claims.settlement` holds `tx`, `payer`, `asset`, `amount`, `network`. None appear in the top-level key list (`v`, `service`, `job`, `requestDigest`, `resultDigest`, `settlement`, `signer`, `issuedAt`). So `settlement` serialized as `{}`.

Demonstrated before the fix:

```
SIGNED BYTES:
{"issuedAt":1,...,"settlement":{},"signer":"GSIGNER","v":"x402job/1"}

TAMPERED (tx→HASH_B, amount→999999999, payer→GATTACKER):
{"issuedAt":1,...,"settlement":{},"signer":"GSIGNER","v":"x402job/1"}

IDENTICAL?  true
```

**The signature covered no settlement field.** Anyone holding a valid receipt could rewrite the transaction hash, the amount, the payer, the asset, and the network, and it would still verify. The one thing a settlement receipt exists to attest was the one thing unsigned.

The same bug sat in `computeSha256Digest`, so nested request and result bodies were gutted before hashing: two payloads differing only in `accepted.amount` and `payload.transaction` produced identical digest input. Meanwhile `/.well-known/x402` advertised *"request and result digests recompute from exact bytes exchanged"*, which was false.

The existing test passed because it used flat, one-level objects. A test that never nests cannot catch a bug that only affects nesting.

## Decision

**Implement RFC 8785 (JCS) properly, sign the canonical form, verify against re-canonicalized claims, and refuse to issue a receipt whose facts we do not actually know.**

### 1. Real canonicalization

[`canonical-json.ts`](../../facilitator-service/src/canonical-json.ts) recurses: keys sorted by UTF-16 code unit at every level, no whitespace, ECMAScript number formatting, `-0` normalized to `0`, non-finite numbers and BigInt rejected, cycles rejected rather than overflowing the stack, `toJSON()` honoured as `JSON.stringify` does.

`JSON.stringify` is reused for two sub-problems where it is exactly right — string escaping and finite-number formatting are precisely what JCS specifies — and for nothing else.

### 2. Verification never trusts bytes the receipt carries

The receipt publishes `canonicalClaims` so a verifier need not guess the encoding. Verification **ignores it** and re-canonicalizes `receipt.claims`:

```ts
const canonicalClaims = canonicalClaimBytes(receipt.claims);
const signatureValid = keypair.verify(Buffer.from(canonicalClaims, "utf8"), ...);
```

Otherwise a forger rewrites `claims`, leaves the original `canonicalClaims`, and the signature verifies against bytes that disagree with the claims on display. The published string is a convenience for humans, never an input to the check.

### 3. No defaults on facts we do not know

The old code did:

```ts
payer: result.payer || paymentRequirements.payTo,   // payTo is the RECIPIENT
asset: paymentRequirements.asset || "USDC",         // a guess
```

Substituting the recipient for an unknown payer produces a signed, verifiable, **false** statement — strictly worse than no receipt. Now every settlement field is validated non-empty and generation throws otherwise; the server catches it, logs, and returns the settle response without a receipt.

The signing key must also match the advertised signer, so a receipt cannot be signed by a key `/.well-known/x402` does not name.

### 4. The canonicalization is published

The descriptor states `canonicalization: "RFC8785"`. A verifier should not have to reverse-engineer it from a working example.

### 5. Strings are digested as their own bytes

`computeSha256Digest` hashes a string directly rather than its JSON quoting, so a raw body and its JSON encoding do not collide — and `sha256("hello") ≠ sha256("\"hello\"")` is asserted in test.

## Consequences

**Good**

- The signature covers every claim, including all five settlement fields. Verified independently by the conformance harness, which reimplements JCS rather than importing ours — because verifying with the code that produced it proves only self-consistency.
- Forgery is detected across the board: the harness rewrites `tx`, `amount`, `payer`, `asset`, and `network` in turn and asserts the signature fails on each.
- A receipt is never issued with an invented fact. Absence of a receipt is now information.
- 12 receipt tests plus 10 canonicalization tests, several written specifically to fail against the old implementation.

**Costs accepted**

- **All previously issued receipts are invalid.** The signed bytes changed. Nothing was in production, so this cost nothing in practice, and the format carries no version discriminator for the canonicalization — a future change would need one.
- **We maintain a canonicalization implementation.** ~100 lines that must stay RFC-correct. An off-the-shelf JCS library would remove that, at the cost of a dependency on the security-critical path; at this size we preferred the auditable version.
- **Canonicalization cost is O(n log n) per settle.** Sorting keys at every level, on payloads of a few KB. Immaterial next to a Soroban round trip.
- **Receipts are issued only when the settlement names a payer.** `@x402/stellar` populates `payer` on success, so this is rare — but it is a silent absence and only a debug log records it.

**Deliberately not done**

- **No receipt chaining or revocation.** Each receipt stands alone.
- **No TEE attestation.** `runtime.attested` is hardcoded `false` ([ADR-005](./adr-005-advertise-only-what-is-verified.md)).
- **No receipt storage.** Issued in the settle response and not retained. Retrieval by transaction hash would need a store and a retention policy.
- **No canonicalization version field.** Noted above as the cost of the format as specified.

## References

- [`facilitator-service/src/canonical-json.ts`](../../facilitator-service/src/canonical-json.ts) — RFC 8785, and why `JSON.stringify` is used for exactly two sub-problems
- [`facilitator-service/src/stellar/receipt.ts`](../../facilitator-service/src/stellar/receipt.ts) — issuance, the no-defaults rule, verification against re-canonicalized claims
- [`facilitator-service/src/__tests__/receipt.test.ts`](../../facilitator-service/src/__tests__/receipt.test.ts) — per-field tamper tests, and the forged-`canonicalClaims` case
- [`facilitator-service/src/__tests__/canonical-json.test.ts`](../../facilitator-service/src/__tests__/canonical-json.test.ts) — nested ordering, `-0`, cycles, escaping
- [`conformance/src/harness.mjs`](../../conformance/src/harness.mjs) — the independent JCS implementation and the five-field forgery check

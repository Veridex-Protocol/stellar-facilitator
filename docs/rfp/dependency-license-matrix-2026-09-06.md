# Dependency and License Matrix

Date: 2026-09-06. Method: offline inspection of direct manifest dependencies,
installed package metadata, and every tracked npm lockfile. No registry license
lookup was used.

## Runtime Dependencies

| Dependency | License | Runtime/dev | Acceptable? |
|---|---|---|---|
| `@x402/core`, `@x402/stellar`, `@x402/extensions`, `@x402/fetch`, `@x402/hono` | Apache-2.0 | runtime | Yes |
| `@stellar/stellar-sdk` | Apache-2.0 | runtime | Yes |
| `@hono/node-server`, `hono` | MIT | runtime | Yes |
| `@modelcontextprotocol/sdk` | MIT | runtime | Yes |
| `@libp2p/*`, `libp2p`, `uint8arrays` | Apache-2.0 or MIT | runtime | Yes |
| `ajv`, `ajv-formats`, `pg`, `pgvector`, `zod` | MIT | runtime | Yes |
| `dotenv` | BSD-2-Clause | runtime | Yes |
| `buffer`, `clsx`, `next`, `react`, `react-dom`, `tailwind-merge` | MIT | Playground runtime | Yes |
| `lucide-react` | ISC | Playground runtime | Yes |
| `requests` | Apache-2.0 | Python runtime | Yes |
| Go SDK | No external modules | runtime | Yes |
| Veridex `upto-settlement` Rust dependency graph | Apache/MIT ecosystem; locked tests pass | contract build/test | Requires contract release review |

No direct runtime dependency is GPL, AGPL, unknown, or unlicensed.

## Items to Investigate

The Playground's Next.js lockfile contains platform-specific `sharp`/`libvips`
optional binaries licensed `LGPL-3.0-or-later` or combined
`Apache-2.0 AND LGPL-3.0-or-later [AND MIT]`. They are transitive image-optimizer
artifacts, not direct facilitator/Bazaar/MCP dependencies. This is not labeled
incompatible here, but legal/distribution review is required before claiming a
strictly permissive Playground dependency path.

The full npm lockfile scan found no `GPL`, `AGPL`, or `UNKNOWN` license entry.
Other transitive licenses present include BSD, ISC, MPL-2.0, Python-2.0,
CC-BY-4.0, Unlicense, and the LGPL entries above.

MCP initially reported a high `fast-uri` advisory and a moderate `qs`
advisory through `@modelcontextprotocol/sdk`. A non-breaking lockfile-only
update resolved `fast-uri` to `3.1.7` and `qs` to `6.16.0`; MCP typecheck and
17 tests passed afterward, and `npm audit --omit=dev` reports zero
vulnerabilities.

## Reproducibility Corrections

- MCP `@x402/core` and `@x402/stellar` are pinned to `2.21.0`; caret ranges had
  resolved `2.22.0` while the rest of the conformance stack used `2.21.0`.
- The Python requirements file now matches `setup.py` and imports: `requests`
  is the only runtime dependency. The unused `stellar-sdk` entry was removed.

## Limitations

License metadata is publisher-supplied and is not legal advice. This artifact
does not replace counsel or a software-composition-analysis release gate.
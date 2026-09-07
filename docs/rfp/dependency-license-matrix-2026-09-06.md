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
artifacts, not direct facilitator/Bazaar/MCP dependencies. The license gate
reports 14 explicit optional-binary exceptions. This is not labeled incompatible
here, but legal/distribution review is required before claiming a strictly
permissive Playground dependency path.

The full npm lockfile scan found no `GPL`, `AGPL`, or `UNKNOWN` license entry.
Other transitive licenses present include BSD, ISC, MPL-2.0, Python-2.0,
CC-BY-4.0, Unlicense, and the LGPL entries above.

MCP initially reported a high `fast-uri` advisory and a moderate `qs`
advisory through `@modelcontextprotocol/sdk`. A non-breaking lockfile-only
update resolved `fast-uri` to `3.1.7` and `qs` to `6.16.0`; MCP typecheck and
17 tests passed afterward, and `npm audit --omit=dev` reports zero
vulnerabilities.

The Playground was upgraded to Next `16.3.4`, Stellar SDK `16.2.0`, and Sharp
`0.35.4`. Its production audit reports zero vulnerabilities; typecheck, webpack
production build, smoke, and responsive browser checks pass. The upgrade does
not remove the LGPL-bearing optional libvips distributions described above.

Final package-wide audit found `fast-uri@3.1.5` under Ajv in the facilitator,
Bazaar, and demo seller lockfiles. All three compatible lock entries now resolve
`fast-uri@3.1.7`. The demo seller also moved from Stellar SDK `13.3.0` to the
repository's proven `16.2.0` line, removing vulnerable `toml@3.0.0`. Clean
production audits, typechecks, builds, and affected package tests pass after the
updates.

## Reproducibility Corrections

- MCP `@x402/core` and `@x402/stellar` are pinned to `2.21.0`; caret ranges had
  resolved `2.22.0` while the rest of the conformance stack used `2.21.0`.
- The Python requirements file now matches `setup.py` and imports: `requests`
  is the only runtime dependency. The unused `stellar-sdk` entry was removed.
- CI runs `npm run licenses:check` and `npm run errors:check`. The license policy
  fails unknown/GPL/AGPL entries unless a reviewed package/path exception is
  present; exceptions remain visible in command output.

## Limitations

License metadata is publisher-supplied and is not legal advice. This artifact
does not replace counsel or a software-composition-analysis release gate.
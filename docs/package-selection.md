# Package Selection

Use the smallest package that matches the job.

| Need | Install/use | Status |
|---|---|---|
| Accept exact Stellar x402 payments | Official `@x402/hono` or another official x402 server adapter plus `@x402/stellar` | Canonical seller path |
| Pay an HTTP x402 Stellar resource | `@veridex/stellar` `createVeridexClient()` or official `@x402/fetch` plus `@x402/stellar` | Canonical Stellar x402 buyer path; tarball tested, npm publication pending |
| Query Bazaar or call facilitator APIs directly | `@veridex/stellar` `BazaarClient` / `FacilitatorClient` | Advanced low-level API |
| Build an autonomous multi-protocol agent | `@veridex/agentic-payments@2.0.7` | Published policy/session/protocol package; its current EVM x402 handler is compatibility-limited and is not the Stellar v2 payment path |
| Passkeys, vaults, wallet identity, and cross-chain operations | `@veridex/sdk@1.1.6` | Published general wallet/identity package; not the focused x402 buyer SDK |
| MCP discovery and payment tools | `mcp-server` in this repository | Operated keyless MCP service: challenge preparation plus externally signed submission |

Payment does not require Bazaar, P2P, or provider-quality services. Discovery is optional.

For a Stellar-paying agent, compose local `@veridex/agentic-payments` policy
with `@veridex/stellar` or official x402 Stellar signing. Do not route the
current Stellar v2 payment through the sibling package's legacy-shaped parser.

Verified on 2026-09-06: `@veridex/sdk` built and passed 658 tests;
`@veridex/agentic-payments` built and passed 437 tests; both registry versions
matched their manifests. `@veridex/stellar` remained unpublished (`npm` 404).
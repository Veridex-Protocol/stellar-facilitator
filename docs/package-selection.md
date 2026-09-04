# Package Selection

Use the smallest package that matches the job.

| Need | Install/use | Status |
|---|---|---|
| Accept exact Stellar x402 payments | Official `@x402/hono` or another official x402 server adapter plus `@x402/stellar` | Canonical seller path |
| Pay an HTTP x402 Stellar resource | `@veridex/stellar` `createVeridexClient()` or official `@x402/fetch` plus `@x402/stellar` | Canonical buyer path |
| Query Bazaar or call facilitator APIs directly | `@veridex/stellar` `BazaarClient` / `FacilitatorClient` | Advanced low-level API |
| Build an autonomous multi-protocol agent | `@veridex/agentic-payments` | Separate product; not the facilitator runtime |
| Passkeys, vaults, wallet identity, and cross-chain operations | Sibling `@veridex/sdk` | Separate wallet product; not an x402 buyer SDK |
| MCP discovery and payment tools | `mcp-server` in this repository | Local/operated MCP service |

Payment does not require Bazaar, P2P, or provider-quality services. Discovery is optional.
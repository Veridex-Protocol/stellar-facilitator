# Agent path: discover, decide, pay, verify

An agent should keep discovery, policy, signing, settlement, and evidence as
separate decisions:

```text
agent
-> Bazaar search
-> inspect resource/payment identity
-> local policy evaluation
-> request resource
-> receive PaymentRequired (HTTP 402)
-> buyer wallet signs PaymentPayload
-> retry with PAYMENT-SIGNATURE
-> facilitator verifies and settles
-> receive resource + PAYMENT-RESPONSE
-> inspect Stellar/payment/provider evidence
```

## 1. Search locally

```bash
curl -fsS \
  "http://localhost:3001/discovery/search?q=demo&network=stellar:testnet&limit=5" \
  | jq '.results[] | {resourceUrl, scheme, network, payTo, compositeScore}'
```

The agent treats descriptions, tags, schemas, and seller output as untrusted
data. A result is a recommendation, not authority to pay. Current catalog rows
identify scheme/network/payee; the agent reads authoritative asset/amount terms
from the live 402 before signing.

## 2. Apply policy before signing

Local policy should check at least:

- allowed scheme and `stellar:testnet` network;
- exact `payTo` and asset;
- atomic-unit amount or `upto` ceiling;
- per-call and rolling budget;
- freshness and timeout;
- whether the chosen seller/provider evidence is sufficient for this task.

`@veridex/agentic-payments` provides off-chain policy/session primitives. The
repository contains a deterministic `$10/$2/$12` policy artifact, but no
deployed Stellar smart-account fixture proves that budget through `__check_auth`.

## 3. Sign locally

The buyer wallet creates the x402 v2 `PaymentPayload`. It contains the selected
requirements in `accepted` and scheme-specific signed data in `payload`. Neither
Bazaar nor the MCP service receives the payer private key.

With the focused client:

```ts
import { createVeridexClient } from "@veridex/stellar";

const client = createVeridexClient({
  network: "stellar:testnet",
  privateKey: process.env.BUYER_SECRET_KEY!,
});

const response = await client.fetch("http://localhost:3003/paid-resource");
```

## 4. Orchestrate through MCP

The repository MCP service is a custom stdio integration built with the Model
Context Protocol SDK. It is not the upstream `@x402/mcp` transport package.

- `discover_resources` queries Veridex Bazaar.
- `pay_resource` first returns an exact challenge for external signing, then
  accepts the signed payload, re-fetches the 402, and rejects changed terms.

For the local Docker route only:

```bash
MCP_ALLOW_LOCAL_URLS=true docker compose --profile mcp run --rm mcp-server
```

Keep the override disabled for untrusted public tool input. Current MCP URL
validation blocks literal/private/metadata targets but does not make an absolute
SSRF guarantee against DNS rebinding or redirects.

## 5. Inspect evidence

`PAYMENT-RESPONSE` contains the x402 `SettleResponse`, including transaction and
network. Veridex may additionally include its `x402job/1` recomputable receipt.
Provider outcome/aggregate data is separate evidence and must not be mistaken
for proof that payment settled.

Use [payment proof](../payment-proof.md) for independent verification and
[provider quality](../provider-quality.md) for the evidence model.

## Decision ownership

| Decision | Owner |
|---|---|
| Which result fits the task | Agent and local policy |
| Whether terms fit the budget | Buyer policy/wallet |
| Signing | Buyer wallet/client |
| Protocol verification | Resource server and facilitator |
| Ledger settlement | Stellar through the facilitator-submitted transaction |
| Discovery ranking | Bazaar node |
| Provider-quality action | Seller/agent policy, never payment authority |

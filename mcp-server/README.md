# Veridex MCP discovery and payment service

Custom stdio MCP service for Veridex Bazaar discovery and keyless exact HTTP
payment orchestration. It uses `@modelcontextprotocol/sdk`; it is not the
upstream `@x402/mcp` payment transport.

## Active tools

### `discover_resources`

Input:

```json
{
  "query": "payment API",
  "network": "stellar:testnet",
  "limit": 5
}
```

The tool queries Veridex `/discovery/search`. Output is JSON text containing
`ok`, `total`, and `resources`. Payment identity (`resourceUrl`, network,
scheme, `payTo`) is separate from seller-controlled values, which are nested
under:

```json
{
  "sellerData": {
    "trust": "untrusted_seller_data",
    "serviceName": "...",
    "description": "...",
    "tags": []
  }
}
```

### `pay_resource`

This is a two-phase, exact-only flow.

First call:

```json
{
  "resourceUrl": "http://localhost:3003/paid-resource",
  "method": "GET",
  "maxAmount": "100000"
}
```

The service fetches the HTTP 402, filters exact `stellar:testnet` requirements
to the atomic-unit ceiling, and returns `action: "sign_payment"` with
`signingLocation: "client_wallet"`. The MCP process performs no signing and has
no payer private key.

The client wallet creates the x402 v2 `PaymentPayload` and calls again:

```json
{
  "resourceUrl": "http://localhost:3003/paid-resource",
  "method": "GET",
  "maxAmount": "100000",
  "paymentPayload": {
    "x402Version": 2,
    "accepted": {},
    "payload": {}
  }
}
```

The service re-fetches the 402 and requires the signed payload to match resource,
version, network, scheme, asset, amount, `payTo`, and timeout before forwarding
`PAYMENT-SIGNATURE`. Changed terms are rejected.

The custom Veridex Stellar `upto` flow is not exposed by this MCP tool.

## Configuration

```text
BAZAAR_URL=http://localhost:3001
FACILITATOR_URL=http://localhost:3002
STELLAR_NETWORK=testnet
MCP_MAX_SPEND_AMOUNT_STROOPS=10000000
```

For an MCP client:

```json
{
  "mcpServers": {
    "veridex": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server/dist/index.js"],
      "env": {
        "BAZAAR_URL": "http://localhost:3001",
        "FACILITATOR_URL": "http://localhost:3002",
        "STELLAR_NETWORK": "testnet",
        "MCP_ALLOW_LOCAL_URLS": "true"
      }
    }
  }
}
```

Use `MCP_ALLOW_LOCAL_URLS=true` only for the repository's local Docker service.
Leave it unset when tool callers can supply arbitrary URLs.

## Run

```bash
npm --prefix mcp-server ci
npm --prefix mcp-server run build
MCP_ALLOW_LOCAL_URLS=true docker compose --profile mcp run --rm mcp-server
```

## Security boundary

- Client-side signing; no payer secret in MCP configuration.
- Fresh challenge re-match before submission.
- Atomic-unit spend ceiling.
- Seller descriptions and paid bodies remain untrusted data.
- Local/private/metadata targets are blocked by default.
- Current URL validation does not provide an absolute guarantee against DNS
  rebinding or redirects.
- Prompt injection is not solved by labeling content as untrusted.

Errors use Veridex wrapper metadata. A first-phase signing request uses
`mcp_signing_required`; payment/protocol failures may be wrapped as
`payment_rejected`. Consumers should not assume raw Stellar reason codes are the
top-level MCP code.

## Upstream MCP distinction

Current upstream `@x402/mcp` transports payment in
`_meta["x402/payment"]` and settlement in
`_meta["x402/payment-response"]`. This service instead exposes custom
`discover_resources` and `pay_resource` orchestration tools over stdio. No wire
interoperability claim is made without a dedicated test.

See [the agent guide](../docs/guide/agent.md),
[standards alignment](../docs/standards-alignment.md), and
[errors](../docs/errors.md).

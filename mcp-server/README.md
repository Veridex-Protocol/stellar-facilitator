# Veridex MCP Discovery Server

**License:** Apache-2.0

Model Context Protocol (MCP) server that exposes Veridex Bazaar discovery and x402 payment tools to compatible clients.

## Overview

This MCP server enables compatible clients to:

1. **Discover resources** - Search Bazaar catalog with lexical-hybrid/keyword queries
2. **Orchestrate payments** - Return a bounded x402 challenge to the client wallet, then submit only the externally signed payload

## Tools

### `discover_resources`

Search Veridex Bazaar catalog using BM25 plus deterministic feature-hash lexical retrieval.

**Input:**
```json
{
  "query": "weather forecast API",
  "network": "stellar:pubnet",
  "limit": 20
}
```

**Output:**
```
Found 15 resources:

- https://api.weather.io/forecast
  Service: WeatherIO
  Description: Real-time weather forecasts with 7-day predictions
  Network: stellar:pubnet
  Score: 0.892
  Uptime: 99.8%
  Avg Latency: 145ms
  Reliability: 98.5%

...
```

---

### `pay_resource`

Prepare or submit an x402 Stellar payment without placing a buyer key in the MCP process.

**Input:**
```json
{
  "resourceUrl": "https://api.weather.io/forecast",
  "resourceUrl": "https://api.weather.io/forecast",
  "maxAmount": "100000"
}
```

The first call returns `action: "sign_payment"`, `signingLocation:
"client_wallet"`, and only payment alternatives within `maxAmount`. The client
wallet signs one of those exact terms and calls `pay_resource` again with the
resulting `paymentPayload`. The MCP server re-fetches the challenge, checks
version, resource, network, scheme, asset, amount, payee, and timeout, and only
then forwards `PAYMENT-SIGNATURE`.

---

## Configuration

Set environment variables:

```bash
# Required
BAZAAR_URL=http://localhost:3001
FACILITATOR_URL=http://localhost:3002
STELLAR_NETWORK=testnet
MCP_MAX_SPEND_AMOUNT_STROOPS=10000000
```

## Usage

### 1. Install

```bash
npm install
npm run build
```

### 2. Configure an MCP client

Add the server command to the client's MCP configuration. For the repository's
local Docker seller, set `MCP_ALLOW_LOCAL_URLS=true`; leave it unset when the
server may be asked to fetch arbitrary external URLs.

```json
{
  "mcpServers": {
    "veridex": {
      "command": "node",
      "args": ["/path/to/mcp-server/dist/index.js"],
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

### 3. Restart the client

The server exposes two tools after the client reconnects: `discover_resources` and `pay_resource`.

## Example Tool Flow

1. Call `discover_resources` with `{"query":"weather API"}`.
2. Select a resource from the ranked results.
3. Call `pay_resource` with the resource URL and local spending ceiling.
4. Sign the returned bounded challenge in the client wallet.
5. Call `pay_resource` again with the externally signed `paymentPayload`.

## Development

```bash
# Run in development mode
npm run dev

# Build TypeScript
npm run build

# Type check
npm run typecheck
```

## Security

- The MCP process has no buyer private key and performs no signing
- Externally signed payloads must match the freshly re-fetched challenge
- Seller descriptions and paid bodies are returned inside `untrusted_seller_data`
- SSRF protections are enabled by default; local URLs require an explicit development override

## MCP Client Integration

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['/path/to/mcp-server/dist/index.js'],
  env: {
    BAZAAR_URL: 'http://localhost:3001',
    FACILITATOR_URL: 'http://localhost:3002',
    STELLAR_NETWORK: 'testnet',
  },
});

const client = new Client({ name: 'veridex-client', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);

// Call tool
const result = await client.request({
  method: 'tools/call',
  params: {
    name: 'discover_resources',
    arguments: { query: 'weather API' },
  },
});
```

## License

Apache-2.0

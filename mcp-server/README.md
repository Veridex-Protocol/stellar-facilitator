# Veridex MCP Discovery Server

**License:** Apache-2.0

Model Context Protocol (MCP) server that exposes Veridex Bazaar discovery and x402 payment tools to compatible clients.

## Overview

This MCP server enables compatible clients to:

1. **Discover resources** - Search Bazaar catalog with lexical-hybrid/keyword queries
2. **Execute payments** - Pay for resource access via x402 Stellar protocol

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

Execute x402 Stellar payment to access a resource.

**Input:**
```json
{
  "resourceUrl": "https://api.weather.io/forecast",
  "amountStroops": "100000",
  "toolName": "get_forecast"
}
```

**Output:**
```
Payment successful.

Resource: https://api.weather.io/forecast
Amount: 100000 stroops (0.0100000 XLM)
Transaction: abc123...
Ledger: 12345678

You can now access the resource with this authorization.
```

---

## Configuration

Set environment variables:

```bash
# Required
BAZAAR_URL=http://localhost:3001
FACILITATOR_URL=http://localhost:3002
STELLAR_NETWORK=testnet
STELLAR_CLIENT_SECRET_KEY=S...
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
        "STELLAR_CLIENT_SECRET_KEY": "S...",
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
3. Call `pay_resource` with the resource URL and amount.
4. Use the returned authorization to access the resource.

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

- Client secret key is required for payment operations
- All transactions are signed with Stellar signatures
- MCP server runs locally with stdio transport (no network exposure)

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
    STELLAR_CLIENT_SECRET_KEY: 'S...',
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

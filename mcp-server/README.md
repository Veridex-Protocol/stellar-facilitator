# Veridex MCP Discovery Server

**License:** Apache-2.0

Model Context Protocol (MCP) server that exposes Veridex Bazaar discovery and x402 payment tools to AI agents.

## Overview

This MCP server enables AI agents (Claude, GPT-4, etc.) to:

1. **Discover resources** - Search Bazaar catalog with semantic/keyword queries
2. **Execute payments** - Pay for resource access via x402 Stellar protocol
3. **Manage escrow** - Check balance and deposit funds for metered billing

## Tools

### `discover_resources`

Search Veridex Bazaar catalog using hybrid semantic + keyword search.

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

• https://api.weather.io/forecast
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
✓ Payment successful!

Resource: https://api.weather.io/forecast
Amount: 100000 stroops (0.0100000 XLM)
Transaction: abc123...
Ledger: 12345678

You can now access the resource with this authorization.
```

---

### `get_escrow_balance`

Check escrow account balance for a resource server.

**Input:**
```json
{
  "resourceServerAddress": "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
}
```

**Output:**
```
Escrow Account:

Resource Server: GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
Available Balance: 5.0000000 XLM (50000000 stroops)
Consumed (Pending Claim): 1.2345000 XLM (12345000 stroops)
Total Requests: 123
Last Activity: 2026-08-02T10:30:45.000Z
```

---

### `deposit_escrow`

Deposit XLM into escrow for prepaid resource access.

**Input:**
```json
{
  "resourceServerAddress": "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  "amountStroops": "100000000"
}
```

**Output:**
```
✓ Deposit successful!

Deposited: 10.0000000 XLM (100000000 stroops)
New Balance: 10.0000000 XLM (100000000 stroops)
Resource Server: GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

Your escrow account is ready for metered resource access.
```

## Configuration

Set environment variables:

```bash
# Required
BAZAAR_URL=http://localhost:3001
FACILITATOR_URL=http://localhost:3002
STELLAR_NETWORK=testnet
STELLAR_CLIENT_SECRET_KEY=S...

# Optional (for escrow tools)
ESCROW_CONTRACT_ID=C...
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
```

## Usage

### 1. Install

```bash
npm install
npm run build
```

### 2. Configure Claude Desktop

Add to `claude_desktop_config.json`:

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
        "ESCROW_CONTRACT_ID": "C...",
        "SOROBAN_RPC_URL": "https://soroban-testnet.stellar.org"
      }
    }
  }
}
```

### 3. Restart Claude Desktop

The MCP server will be available to Claude with 4 new tools.

## Example Conversation

**User:** Find me a weather API on Stellar

**Claude:** I'll search the Veridex Bazaar for weather APIs.

*[Uses `discover_resources` tool]*

I found WeatherIO API with 99.8% uptime. Would you like me to pay for access?

**User:** Yes, pay 0.01 XLM for it

**Claude:** I'll execute the payment.

*[Uses `pay_resource` tool]*

Payment successful! Transaction hash: abc123...
You can now access the WeatherIO forecast endpoint.

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

- Client secret key is required for payments and escrow operations
- All transactions are signed with Stellar signatures
- MCP server runs locally with stdio transport (no network exposure)

## Integration with AI Agents

### Claude Desktop

See configuration above.

### Custom MCP Client

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

const client = new Client({ name: 'my-agent', version: '1.0.0' }, { capabilities: {} });
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

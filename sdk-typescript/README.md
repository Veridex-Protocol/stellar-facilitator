# Veridex TypeScript SDK

**License:** Apache-2.0

Official TypeScript/JavaScript SDK for Veridex Bazaar discovery and x402 payment settlement on Stellar.

## Installation

```bash
npm install @veridex/sdk
```

## Quick Start

```typescript
import { createBazaarClient, createFacilitatorClient } from '@veridex/sdk';

// Initialize clients
const bazaar = createBazaarClient({
  bazaarUrl: 'http://localhost:3001',
});

const facilitator = createFacilitatorClient({
  facilitatorUrl: 'http://localhost:3002',
  network: 'testnet',
  clientSecretKey: 'S...', // Your Stellar secret key
});

// 1. Discover resources
const results = await bazaar.search({
  query: 'weather forecast API',
  network: 'stellar:pubnet',
  limit: 10,
});

console.log(`Found ${results.total} resources`);
results.results.forEach(resource => {
  console.log(`- ${resource.resourceUrl}`);
  console.log(`  Uptime: ${(resource.uptimeRatio * 100).toFixed(1)}%`);
  console.log(`  Latency: ${resource.avgResponseTimeMs}ms`);
});

// 2. Pay for access
const payment = await facilitator.pay({
  resourceUrl: results.results[0].resourceUrl,
  amountStroops: '100000', // 0.01 XLM
  toolName: 'get_forecast',
});

if (payment.status === 'success') {
  console.log(`Payment successful! TX: ${payment.transactionHash}`);
} else {
  console.error(`Payment failed: ${payment.error}`);
}
```

## API Reference

### BazaarClient

#### `search(params: SearchParams): Promise<BazaarSearchResponse>`

Search resources with hybrid semantic + keyword search.

**Parameters:**
```typescript
{
  query: string;              // Search query
  network?: string;           // Network filter (default: 'stellar:pubnet')
  minUptimeRatio?: number;    // Minimum uptime (0.0-1.0)
  limit?: number;             // Max results (default: 20)
  offset?: number;            // Pagination offset
}
```

**Returns:**
```typescript
{
  results: BazaarResource[];
  total: number;
  queryTimeMs: number;
}
```

**Example:**
```typescript
const results = await bazaar.search({
  query: 'translate API',
  minUptimeRatio: 0.95,
  limit: 5,
});
```

---

#### `list(filters?: { network?, limit?, offset? }): Promise<BazaarSearchResponse>`

List all resources with optional filters.

**Example:**
```typescript
const all = await bazaar.list({
  network: 'stellar:testnet',
  limit: 50,
});
```

---

#### `health(): Promise<HealthStatus>`

Check Bazaar service health.

**Example:**
```typescript
const health = await bazaar.health();
console.log(`Status: ${health.status}`);
```

---

#### `stats(): Promise<ServiceStats>`

Get service statistics (P2P, telemetry).

**Example:**
```typescript
const stats = await bazaar.stats();
console.log(`P2P peers: ${stats.p2p.connectedPeers}`);
```

---

### FacilitatorClient

#### `pay(request: X402PaymentRequest): Promise<X402PaymentResponse>`

Execute x402 payment for resource access.

**Parameters:**
```typescript
{
  resourceUrl: string;
  amountStroops: string;  // Amount in stroops
  toolName?: string;      // Optional tool name
  sessionId?: string;     // Optional session ID
}
```

**Returns:**
```typescript
{
  status: 'success' | 'error';
  transactionHash?: string;
  ledger?: number;
  error?: string;
  errorCode?: string;
}
```

**Example:**
```typescript
const payment = await facilitator.pay({
  resourceUrl: 'https://api.example.com/tool',
  amountStroops: '1000000', // 0.1 XLM
});
```

---

#### `verify(transactionXdr: string, expectedAmount?: string): Promise<VerificationResult>`

Verify transaction without submitting.

**Example:**
```typescript
const verification = await facilitator.verify(txXdr, '100000');
console.log(`Valid: ${verification.valid}`);
```

---

#### `getTransactionStatus(hash: string): Promise<TransactionStatus>`

Check transaction status by hash.

**Example:**
```typescript
const status = await facilitator.getTransactionStatus('abc123...');
console.log(`Found: ${status.found}, Successful: ${status.successful}`);
```

---

#### `getSupportedSchemes(): Promise<{ schemes: FacilitatorScheme[] }>`

Get supported payment schemes.

**Example:**
```typescript
const schemes = await facilitator.getSupportedSchemes();
console.log(`Facilitator: ${schemes.schemes[0].facilitatorAccount}`);
```

---

#### `health(): Promise<HealthStatus>`

Check Facilitator service health.

---

#### `stats(): Promise<ServiceStats>`

Get settlement statistics.

---

## Advanced Usage

### Error Handling

```typescript
try {
  const payment = await facilitator.pay({
    resourceUrl: 'https://api.example.com/tool',
    amountStroops: '100000',
  });
  
  if (payment.status === 'error') {
    console.error(`Payment error: ${payment.errorCode} - ${payment.error}`);
  }
} catch (error) {
  console.error('Request failed:', error);
}
```

### Pagination

```typescript
async function getAllResources() {
  const pageSize = 20;
  let offset = 0;
  let resources = [];
  
  while (true) {
    const page = await bazaar.list({ limit: pageSize, offset });
    resources.push(...page.results);
    
    if (page.results.length < pageSize) break;
    offset += pageSize;
  }
  
  return resources;
}
```

### Custom Timeout

```typescript
const bazaar = createBazaarClient({
  bazaarUrl: 'http://localhost:3001',
  timeout: 10000, // 10 seconds
});
```

### Network Selection

```typescript
// Testnet
const facilitator = createFacilitatorClient({
  facilitatorUrl: 'http://localhost:3002',
  network: 'testnet',
  clientSecretKey: 'S...',
});

// Pubnet
const facilitatorProd = createFacilitatorClient({
  facilitatorUrl: 'https://facilitator.veridex.io',
  network: 'pubnet',
  clientSecretKey: 'S...',
});
```

## TypeScript Types

All types are exported from the main package:

```typescript
import type {
  BazaarResource,
  BazaarSearchResponse,
  X402PaymentRequest,
  X402PaymentResponse,
  FacilitatorScheme,
  VeridexSDKConfig,
} from '@veridex/sdk';
```

## Browser Support

The SDK works in both Node.js and browser environments. For browsers, ensure you have a Stellar SDK polyfill if needed:

```html
<script src="https://cdn.jsdelivr.net/npm/stellar-sdk@latest/dist/stellar-sdk.min.js"></script>
```

## Examples

### React Hook

```typescript
import { useState, useEffect } from 'react';
import { createBazaarClient } from '@veridex/sdk';

function useResourceSearch(query: string) {
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  
  useEffect(() => {
    const bazaar = createBazaarClient({
      bazaarUrl: 'http://localhost:3001',
    });
    
    setLoading(true);
    bazaar.search({ query })
      .then(res => setResults(res.results))
      .finally(() => setLoading(false));
  }, [query]);
  
  return { results, loading };
}
```

### CLI Tool

```typescript
#!/usr/bin/env node
import { createBazaarClient } from '@veridex/sdk';

const bazaar = createBazaarClient({
  bazaarUrl: process.env.BAZAAR_URL || 'http://localhost:3001',
});

const query = process.argv[2];
if (!query) {
  console.error('Usage: search <query>');
  process.exit(1);
}

const results = await bazaar.search({ query });
console.log(JSON.stringify(results, null, 2));
```

## License

Apache-2.0

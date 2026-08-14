# Veridex Python SDK

**License:** Apache-2.0

Official Python SDK for Veridex Bazaar discovery and x402 payment settlement on Stellar.

## Installation

```bash
pip install veridex-sdk
```

## Quick Start

```python
from veridex import BazaarClient, FacilitatorClient, SearchParams, PaymentRequest

# Initialize clients
bazaar = BazaarClient(bazaar_url="http://localhost:3001")

facilitator = FacilitatorClient(
    facilitator_url="http://localhost:3002",
    network="testnet",
    client_secret_key="S..."  # Your Stellar secret key
)

# 1. Discover resources
results = bazaar.search(SearchParams(
    query="weather forecast API",
    network="stellar:pubnet",
    limit=10
))

print(f"Found {results.total} resources")
for resource in results.results:
    print(f"- {resource.resource_url}")
    print(f"  Uptime: {resource.uptime_ratio * 100:.1f}%")
    print(f"  Latency: {resource.avg_response_time_ms}ms")

# 2. Pay for access
payment = facilitator.pay(PaymentRequest(
    resource_url=results.results[0].resource_url,
    amount_stroops="100000",  # 0.01 XLM
    tool_name="get_forecast"
))

if payment.status == "success":
    print(f"Payment successful! TX: {payment.transaction_hash}")
else:
    print(f"Payment failed: {payment.error}")
```

## API Reference

### BazaarClient

#### `search(params: SearchParams) -> BazaarSearchResponse`

Search resources with hybrid semantic + keyword search.

**Parameters:**
```python
SearchParams(
    query: str,              # Search query
    network: str = None,     # Network filter (default: 'stellar:pubnet')
    min_uptime_ratio: float = None,  # Minimum uptime (0.0-1.0)
    limit: int = None,       # Max results (default: 20)
    offset: int = None,      # Pagination offset
)
```

**Returns:**
```python
BazaarSearchResponse(
    results: List[BazaarResource],
    total: int,
    query_time_ms: float
)
```

**Example:**
```python
results = bazaar.search(SearchParams(
    query="translate API",
    min_uptime_ratio=0.95,
    limit=5
))
```

---

#### `list(network=None, limit=None, offset=None) -> BazaarSearchResponse`

List all resources with optional filters.

**Example:**
```python
all_resources = bazaar.list(network="stellar:testnet", limit=50)
```

---

#### `health() -> dict`

Check Bazaar service health.

**Example:**
```python
health = bazaar.health()
print(f"Status: {health['status']}")
```

---

#### `stats() -> dict`

Get service statistics (P2P, telemetry).

**Example:**
```python
stats = bazaar.stats()
print(f"P2P peers: {stats['p2p']['connectedPeers']}")
```

---

### FacilitatorClient

#### `pay(request: PaymentRequest) -> PaymentResponse`

Execute x402 payment for resource access.

**Parameters:**
```python
PaymentRequest(
    resource_url: str,
    amount_stroops: str,  # Amount in stroops
    tool_name: str = None,      # Optional tool name
    session_id: str = None,     # Optional session ID
)
```

**Returns:**
```python
PaymentResponse(
    status: str,  # 'success' or 'error'
    transaction_hash: str = None,
    ledger: int = None,
    error: str = None,
    error_code: str = None
)
```

**Example:**
```python
payment = facilitator.pay(PaymentRequest(
    resource_url="https://api.example.com/tool",
    amount_stroops="1000000"  # 0.1 XLM
))
```

---

#### `verify(transaction_xdr: str, expected_amount: str = None) -> dict`

Verify transaction without submitting.

**Example:**
```python
verification = facilitator.verify(tx_xdr, expected_amount="100000")
print(f"Valid: {verification['valid']}")
```

---

#### `get_transaction_status(hash: str) -> dict`

Check transaction status by hash.

**Example:**
```python
status = facilitator.get_transaction_status("abc123...")
print(f"Found: {status['found']}, Successful: {status.get('successful')}")
```

---

#### `get_supported_schemes() -> List[FacilitatorScheme]`

Get supported payment schemes.

**Example:**
```python
schemes = facilitator.get_supported_schemes()
print(f"Facilitator: {schemes[0].facilitator_account}")
```

---

## Context Managers

Both clients support Python context managers:

```python
with BazaarClient(bazaar_url="http://localhost:3001") as bazaar:
    results = bazaar.search(SearchParams(query="weather API"))
    print(f"Found {results.total} resources")

with FacilitatorClient(
    facilitator_url="http://localhost:3002",
    network="testnet",
    client_secret_key="S..."
) as facilitator:
    payment = facilitator.pay(PaymentRequest(
        resource_url="https://api.example.com/tool",
        amount_stroops="100000"
    ))
    print(f"Status: {payment.status}")
```

## Advanced Usage

### Error Handling

```python
import requests

try:
    payment = facilitator.pay(PaymentRequest(
        resource_url="https://api.example.com/tool",
        amount_stroops="100000"
    ))
    
    if payment.status == "error":
        print(f"Payment error: {payment.error_code} - {payment.error}")
except requests.RequestException as e:
    print(f"Request failed: {e}")
except ValueError as e:
    print(f"Configuration error: {e}")
```

### Pagination

```python
def get_all_resources(bazaar: BazaarClient):
    page_size = 20
    offset = 0
    resources = []
    
    while True:
        page = bazaar.list(limit=page_size, offset=offset)
        resources.extend(page.results)
        
        if len(page.results) < page_size:
            break
        
        offset += page_size
    
    return resources
```

### Custom Timeout

```python
bazaar = BazaarClient(
    bazaar_url="http://localhost:3001",
    timeout=10  # 10 seconds
)
```

### Network Selection

```python
# Testnet
facilitator_test = FacilitatorClient(
    facilitator_url="http://localhost:3002",
    network="testnet",
    client_secret_key="S..."
)

# Pubnet
facilitator_prod = FacilitatorClient(
    facilitator_url="https://facilitator.veridex.io",
    network="pubnet",
    client_secret_key="S..."
)
```

## Examples

### Django Integration

```python
from django.conf import settings
from veridex import BazaarClient

class ResourceDiscoveryService:
    def __init__(self):
        self.bazaar = BazaarClient(
            bazaar_url=settings.BAZAAR_URL,
            default_network=settings.STELLAR_NETWORK
        )
    
    def find_resources(self, query: str):
        results = self.bazaar.search(SearchParams(
            query=query,
            min_uptime_ratio=0.95,
            limit=20
        ))
        return results.results
```

### Flask API

```python
from flask import Flask, jsonify, request
from veridex import BazaarClient, SearchParams

app = Flask(__name__)
bazaar = BazaarClient(bazaar_url="http://localhost:3001")

@app.route("/search")
def search():
    query = request.args.get("q")
    results = bazaar.search(SearchParams(query=query))
    
    return jsonify({
        "total": results.total,
        "results": [
            {
                "url": r.resource_url,
                "description": r.description,
                "uptime": r.uptime_ratio
            }
            for r in results.results
        ]
    })
```

### CLI Tool

```python
#!/usr/bin/env python3
import sys
from veridex import BazaarClient, SearchParams

def main():
    if len(sys.argv) < 2:
        print("Usage: search.py <query>")
        sys.exit(1)
    
    query = " ".join(sys.argv[1:])
    
    with BazaarClient(bazaar_url="http://localhost:3001") as bazaar:
        results = bazaar.search(SearchParams(query=query))
        
        print(f"Found {results.total} resources:\n")
        for resource in results.results:
            print(f"- {resource.resource_url}")
            print(f"  Description: {resource.description}")
            print(f"  Uptime: {resource.uptime_ratio * 100:.1f}%\n")

if __name__ == "__main__":
    main()
```

## Development

```bash
# Install development dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Run type checking
mypy veridex

# Format code
black veridex
```

## License

Apache-2.0

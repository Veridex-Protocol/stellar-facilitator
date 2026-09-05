# Veridex Python SDK

Python helpers for Bazaar discovery and advanced facilitator HTTP operations.

## Scope

This package does **not** create canonical Stellar x402 authorization entries or perform the HTTP 402 challenge/retry loop. `FacilitatorClient.pay()` submits a pre-built signed payload and is intended for advanced integrations.

For the canonical beginner buyer flow, use the TypeScript `@veridex/stellar` facade or the official x402 packages.

## Installation

```bash
pip install veridex-sdk
```

## Discovery

```python
from veridex import BazaarClient, SearchParams

bazaar = BazaarClient(
    bazaar_url="http://localhost:3001",
    default_network="stellar:testnet",
)
page = bazaar.search(SearchParams(query="weather forecast", limit=5))
for resource in page.results:
    print(resource.resource_url)
```

## Advanced facilitator transport

```python
from veridex import FacilitatorClient, PaymentRequest

facilitator = FacilitatorClient(
    facilitator_url="http://localhost:3002",
    network="testnet",
)

# These values must already be created and signed by an x402-compatible client.
result = facilitator.pay(PaymentRequest(
    resource_url="https://seller.example/data",
    payment_payload=signed_payload,
    payment_requirements=requirements,
))
```

The package also exposes digest-only provider-quality reads through
`BazaarClient.provider_quality()` and `provider_observations()`.

License: Apache-2.0.

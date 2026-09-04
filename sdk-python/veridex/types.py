"""
Veridex Python SDK - Types
License: Apache-2.0
"""

from dataclasses import dataclass
from typing import Optional, List, Dict, Any


@dataclass
class BazaarResource:
    """Bazaar resource metadata"""
    resource_url: str
    service_name: Optional[str]
    description: str
    network: str
    node_id: str
    last_seen: int
    uptime_ratio: Optional[float] = None
    avg_response_time_ms: Optional[float] = None
    reliability_score: Optional[float] = None
    final_score: Optional[float] = None


@dataclass
class BazaarSearchResponse:
    """Bazaar search response"""
    results: List[BazaarResource]
    total: int
    query_time_ms: float


@dataclass
class PaymentResponse:
    """x402 payment response"""
    status: str
    transaction_hash: Optional[str] = None
    ledger: Optional[int] = None
    error: Optional[str] = None
    error_code: Optional[str] = None


@dataclass
class FacilitatorScheme:
    """Supported payment scheme"""
    scheme: str
    networks: List[str]
    facilitator_account: str
    current_network: str
    features: List[str]


@dataclass
class ProviderAggregate:
    """Signed provider-quality aggregate returned by the public read API."""
    endpoint: str
    state: str
    fault_rate_upper_bound: float
    faults_observed: int
    n: int
    window: str
    retrieved_at: int
    issuer: Optional[str] = None
    signature: Optional[str] = None
    pay_to: Optional[str] = None


def provider_aggregate_from_dict(value: Dict[str, Any]) -> ProviderAggregate:
    """Convert the camelCase aggregate wire object to Python fields."""
    return ProviderAggregate(
        endpoint=value.get("endpoint", ""),
        state=value.get("state", "insufficient_data"),
        fault_rate_upper_bound=value.get("faultRateUpperBound", 1.0),
        faults_observed=value.get("faultsObserved", 0),
        n=value.get("n", 0),
        window=value.get("window", ""),
        retrieved_at=value.get("retrievedAt", 0),
        issuer=value.get("issuer"),
        signature=value.get("signature"),
        pay_to=value.get("payTo"),
    )

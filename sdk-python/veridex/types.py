"""
Veridex Python SDK - Types
License: Apache-2.0
"""

from dataclasses import dataclass
from typing import Optional, List


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

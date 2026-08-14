"""
Veridex Python SDK
License: Apache-2.0

Client SDK for interacting with Veridex Bazaar and x402 Facilitator.
"""

from .bazaar_client import BazaarClient, SearchParams
from .facilitator_client import FacilitatorClient, PaymentRequest
from .types import BazaarResource, BazaarSearchResponse, PaymentResponse

__version__ = "0.1.0"
__all__ = [
    "BazaarClient",
    "FacilitatorClient",
    "SearchParams",
    "PaymentRequest",
    "BazaarResource",
    "BazaarSearchResponse",
    "PaymentResponse",
]

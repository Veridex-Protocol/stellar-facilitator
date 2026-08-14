"""
Veridex Python SDK - Facilitator Client
License: Apache-2.0

Client for x402 Facilitator payment settlement.
"""

import requests
from typing import Optional, Dict, Any, List
from dataclasses import dataclass
from .types import PaymentResponse, FacilitatorScheme


@dataclass
class PaymentRequest:
    """A canonical x402 payload and the requirements it was signed against."""
    resource_url: str
    payment_payload: Dict[str, Any]
    payment_requirements: Dict[str, Any]
    tool_name: Optional[str] = None
    session_id: Optional[str] = None


class FacilitatorClient:
    """
    Facilitator Client

    Execute x402 payments via Stellar facilitator.

    Args:
        facilitator_url: Facilitator service URL
        network: Stellar network (pubnet, testnet, futurenet)
        client_secret_key: Client Stellar secret key for signing
        timeout: Request timeout in seconds

    Example:
        >>> client = FacilitatorClient(
        ...     facilitator_url="http://localhost:3002",
        ...     network="testnet",
        ...     client_secret_key="S..."
        ... )
        >>> payment = client.pay(PaymentRequest(
        ...     resource_url="https://api.example.com/tool",
        ...     amount_stroops="100000"
        ... ))
        >>> if payment.status == "success":
        ...     print(f"TX: {payment.transaction_hash}")
    """

    def __init__(
        self,
        facilitator_url: str,
        network: str = "testnet",
        client_secret_key: Optional[str] = None,
        timeout: int = 30,
    ):
        self.facilitator_url = facilitator_url.rstrip("/")
        self.network = network
        self.timeout = timeout
        self.session = requests.Session()

        if network not in ("pubnet", "testnet"):
            raise ValueError(f"Invalid network: {network}")

    def get_supported_schemes(self) -> List[FacilitatorScheme]:
        """
        Get supported payment schemes

        Returns:
            List of supported schemes
        """
        url = f"{self.facilitator_url}/supported"
        response = self.session.get(url, timeout=self.timeout)
        response.raise_for_status()

        return response.json().get("kinds", [])

    def pay(self, request: PaymentRequest) -> PaymentResponse:
        """
        Pay for resource access

        Submits a canonical payload created by an x402 Stellar signer.

        Args:
            request: Payment request

        Returns:
            Payment response with transaction hash or error

        Raises:
            ValueError: If client secret key not configured
            requests.RequestException: If request fails
        """
        url = f"{self.facilitator_url}/settle"

        response = self.session.post(
            url,
            json={
                "x402Version": request.payment_payload.get("x402Version", 2),
                "paymentPayload": request.payment_payload,
                "paymentRequirements": request.payment_requirements,
            },
            timeout=self.timeout,
        )

        data = response.json()

        if response.ok:
            return PaymentResponse(
                status=data.get("success") and "success" or "error",
                transaction_hash=data.get("transaction" ) or data.get("transactionHash"),
                ledger=data.get("ledger"),
            )
        else:
            return PaymentResponse(
                status="error",
                error=data.get("errorMessage") or data.get("error") or response.reason,
                error_code=data.get("errorReason") or data.get("errorCode") or "UNKNOWN",
            )

    def verify(
        self, payment_payload: Dict[str, Any], payment_requirements: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Verify a transaction without submitting

        Args:
            transaction_xdr: Transaction XDR
            expected_amount: Expected amount in stroops

        Returns:
            Verification result
        """
        url = f"{self.facilitator_url}/verify"

        response = self.session.post(
            url, json={"paymentPayload": payment_payload, "paymentRequirements": payment_requirements}, timeout=self.timeout
        )

        return response.json()

    def get_transaction_status(self, transaction_hash: str) -> Dict[str, Any]:
        """
        Get transaction status

        Args:
            transaction_hash: Transaction hash

        Returns:
            Transaction status
        """
        url = f"{self.facilitator_url}/transaction/{transaction_hash}"
        response = self.session.get(url, timeout=self.timeout)

        if response.status_code == 404:
            return {"found": False}

        response.raise_for_status()
        return response.json()

    def health(self) -> Dict[str, Any]:
        """
        Get service health status

        Returns:
            Health status dictionary
        """
        url = f"{self.facilitator_url}/health"
        response = self.session.get(url, timeout=self.timeout)
        response.raise_for_status()
        return response.json()

    def stats(self) -> Dict[str, Any]:
        """
        Get service statistics

        Returns:
            Service stats dictionary
        """
        url = f"{self.facilitator_url}/stats"
        response = self.session.get(url, timeout=self.timeout)
        response.raise_for_status()
        return response.json()

    def close(self):
        """Close the HTTP session"""
        self.session.close()

    def __enter__(self):
        """Context manager entry"""
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Context manager exit"""
        self.close()

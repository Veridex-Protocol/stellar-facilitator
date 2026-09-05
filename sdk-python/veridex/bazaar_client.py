"""
Veridex Python SDK - Bazaar Client
License: Apache-2.0

Client for Veridex Bazaar discovery service.
"""

import requests
from typing import Optional, Dict, Any
from dataclasses import dataclass
from .types import BazaarResource, BazaarSearchResponse, ProviderAggregate, provider_aggregate_from_dict


def _to_resource(row: Dict[str, Any]) -> BazaarResource:
    """Maps one catalog row onto a BazaarResource.

    The discovery API is camelCase on the wire while this SDK is snake_case, so
    both spellings are accepted. Telemetry fields are optional because a
    resource that has never been probed simply has none.
    """
    telemetry = row.get("telemetry") or {}

    def pick(*names, default=None):
        for name in names:
            if name in row and row[name] is not None:
                return row[name]
            if name in telemetry and telemetry[name] is not None:
                return telemetry[name]
        return default

    return BazaarResource(
        resource_url=pick("resourceUrl", "resource_url", default=""),
        service_name=pick("serviceName", "service_name"),
        description=pick("description", default=""),
        network=pick("network", default=""),
        node_id=pick("nodeId", "node_id", default=""),
        last_seen=pick("lastSeen", "last_seen", "updatedAt", "updated_at", default=""),
        uptime_ratio=pick("uptimeRatio", "uptime_ratio"),
        avg_response_time_ms=pick("avgResponseTimeMs", "avg_response_time_ms"),
        reliability_score=pick("reliabilityScore", "reliability_score"),
        final_score=pick("compositeScore", "composite_score", "final_score"),
    )


@dataclass
class SearchParams:
    """Bazaar search parameters"""
    query: str
    network: Optional[str] = None
    min_uptime_ratio: Optional[float] = None
    limit: Optional[int] = None
    offset: Optional[int] = None


class BazaarClient:
    """
    Bazaar Client

    Discover and search x402 resources in the Veridex Bazaar catalog.

    Args:
        bazaar_url: Bazaar service URL
        default_network: Default network filter
        timeout: Request timeout in seconds

    Example:
        >>> client = BazaarClient(bazaar_url="http://localhost:3001")
        >>> results = client.search(SearchParams(query="weather API", limit=10))
        >>> for resource in results.results:
        ...     print(f"{resource.resource_url} - {resource.uptime_ratio}")
    """

    def __init__(
        self,
        bazaar_url: str,
        default_network: str = "stellar:pubnet",
        timeout: int = 30,
    ):
        self.bazaar_url = bazaar_url.rstrip("/")
        self.default_network = default_network
        self.timeout = timeout
        self.session = requests.Session()

    def search(self, params: SearchParams) -> BazaarSearchResponse:
        """
        Search resources with semantic + keyword hybrid search

        Args:
            params: Search parameters

        Returns:
            Search results with ranked resources

        Raises:
            requests.RequestException: If request fails
        """
        url = f"{self.bazaar_url}/discovery/search"

        query_params: Dict[str, Any] = {
            "q": params.query,
            "network": params.network or self.default_network,
        }

        if params.min_uptime_ratio is not None:
            query_params["minUptimeRatio"] = params.min_uptime_ratio

        if params.limit is not None:
            query_params["limit"] = params.limit

        if params.offset is not None:
            query_params["offset"] = params.offset

        response = self.session.get(url, params=query_params, timeout=self.timeout)
        response.raise_for_status()

        data = response.json()

        resources = [_to_resource(r) for r in data.get("results", [])]

        return BazaarSearchResponse(
            results=resources,
            total=data.get("total", 0),
            query_time_ms=data.get("query_time_ms", 0),
        )

    def list(
        self,
        network: Optional[str] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
    ) -> BazaarSearchResponse:
        """
        List all resources with optional filters

        Args:
            network: Network filter
            limit: Maximum results
            offset: Pagination offset

        Returns:
            Resources list
        """
        url = f"{self.bazaar_url}/discovery/resources"

        query_params: Dict[str, Any] = {}

        if network is not None:
            query_params["network"] = network

        if limit is not None:
            query_params["limit"] = limit

        if offset is not None:
            query_params["offset"] = offset

        response = self.session.get(url, params=query_params, timeout=self.timeout)
        response.raise_for_status()

        data = response.json()

        resources = [_to_resource(r) for r in data.get("results", [])]

        return BazaarSearchResponse(
            results=resources,
            total=data.get("total", 0),
            query_time_ms=data.get("query_time_ms", 0),
        )

    def health(self) -> Dict[str, Any]:
        """
        Get service health status

        Returns:
            Health status dictionary
        """
        url = f"{self.bazaar_url}/health"
        response = self.session.get(url, timeout=self.timeout)
        response.raise_for_status()
        return response.json()

    def stats(self) -> Dict[str, Any]:
        """
        Get service statistics

        Returns:
            Service stats dictionary
        """
        url = f"{self.bazaar_url}/stats"
        response = self.session.get(url, timeout=self.timeout)
        response.raise_for_status()
        return response.json()

    def provider_quality(self, endpoint: str, pay_to: Optional[str] = None) -> ProviderAggregate:
        """Read signed provider-quality state without affecting payment flow."""
        response = self.session.get(
            f"{self.bazaar_url}/v1/provider",
            params={"endpoint": endpoint, **({"payTo": pay_to} if pay_to else {})},
            timeout=self.timeout,
        )
        response.raise_for_status()
        return provider_aggregate_from_dict(response.json())

    def provider_observations(
        self, endpoint: str, pay_to: Optional[str] = None, limit: Optional[int] = None
    ) -> Dict[str, Any]:
        """Read digest-only provider observation history."""
        params: Dict[str, Any] = {"endpoint": endpoint}
        if pay_to:
            params["payTo"] = pay_to
        if limit is not None:
            params["limit"] = limit
        response = self.session.get(
            f"{self.bazaar_url}/v1/provider/observations",
            params=params,
            timeout=self.timeout,
        )
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

"""
Veridex Python SDK - Bazaar Client
License: Apache-2.0

Client for Veridex Bazaar discovery service.
"""

import requests
from typing import Optional, Dict, Any
from dataclasses import dataclass
from .types import BazaarResource, BazaarSearchResponse


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

        resources = [
            BazaarResource(
                resource_url=r["resource_url"],
                service_name=r.get("service_name"),
                description=r["description"],
                network=r["network"],
                node_id=r["node_id"],
                last_seen=r["last_seen"],
                uptime_ratio=r.get("uptime_ratio"),
                avg_response_time_ms=r.get("avg_response_time_ms"),
                reliability_score=r.get("reliability_score"),
                final_score=r.get("final_score"),
            )
            for r in data.get("results", [])
        ]

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

        resources = [
            BazaarResource(
                resource_url=r["resource_url"],
                service_name=r.get("service_name"),
                description=r["description"],
                network=r["network"],
                node_id=r["node_id"],
                last_seen=r["last_seen"],
                uptime_ratio=r.get("uptime_ratio"),
                avg_response_time_ms=r.get("avg_response_time_ms"),
                reliability_score=r.get("reliability_score"),
                final_score=r.get("final_score"),
            )
            for r in data.get("results", [])
        ]

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

    def close(self):
        """Close the HTTP session"""
        self.session.close()

    def __enter__(self):
        """Context manager entry"""
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Context manager exit"""
        self.close()

"""
Veridex Python SDK tests.
License: Apache-2.0

These use a stubbed transport rather than a live service, so they assert the
request the SDK builds and the response it returns, which is what an integrator
depends on.
"""

import json
import unittest
from unittest import mock
from urllib.parse import urlparse, parse_qs

from veridex.bazaar_client import BazaarClient, SearchParams
from veridex.facilitator_client import FacilitatorClient

BAZAAR_URL = "http://bazaar.test"
FACILITATOR_URL = "http://facilitator.test"


def _response(payload, status=200):
    """Builds a stub requests.Response-alike carrying the given JSON."""
    stub = mock.Mock()
    stub.status_code = status
    stub.ok = 200 <= status < 300
    stub.json.return_value = payload
    stub.text = json.dumps(payload)
    stub.raise_for_status = mock.Mock()
    if not stub.ok:
        stub.raise_for_status.side_effect = Exception(f"HTTP {status}")
    return stub


class BazaarClientTests(unittest.TestCase):
    def setUp(self):
        self.client = BazaarClient(bazaar_url=BAZAAR_URL)

    def test_search_targets_the_discovery_endpoint(self):
        with mock.patch.object(self.client.session, "get") as get:
            get.return_value = _response({"results": [], "total": 0})
            self.client.search(SearchParams(query="weather forecast"))

        url = get.call_args[0][0]
        self.assertEqual(urlparse(url).path, "/discovery/search")

    def test_search_sends_the_query_terms(self):
        with mock.patch.object(self.client.session, "get") as get:
            get.return_value = _response({"results": [], "total": 0})
            self.client.search(SearchParams(query="weather forecast"))

        params = get.call_args.kwargs.get("params") or {}
        self.assertEqual(params.get("q"), "weather forecast")

    def test_search_passes_filters_through(self):
        with mock.patch.object(self.client.session, "get") as get:
            get.return_value = _response({"results": [], "total": 0})
            self.client.search(
                SearchParams(query="storage", network="stellar:testnet", limit=5)
            )

        params = get.call_args.kwargs.get("params") or {}
        self.assertEqual(params.get("network"), "stellar:testnet")
        self.assertEqual(params.get("limit"), 5)

    def test_search_returns_the_results_the_catalog_sent(self):
        with mock.patch.object(self.client.session, "get") as get:
            get.return_value = _response(
                {
                    "results": [
                        {
                            "resourceUrl": "http://seller.test/forecast",
                            "payTo": "GABC",
                            "network": "stellar:testnet",
                        }
                    ],
                    "total": 1,
                }
            )
            response = self.client.search(SearchParams(query="weather"))

        self.assertEqual(len(response.results), 1)

    def test_trailing_slash_in_the_base_url_does_not_double_up(self):
        client = BazaarClient(bazaar_url=BAZAAR_URL + "/")
        self.assertFalse(client.bazaar_url.endswith("/"))


class FacilitatorClientTests(unittest.TestCase):
    def setUp(self):
        self.client = FacilitatorClient(
            facilitator_url=FACILITATOR_URL, network="testnet"
        )

    def test_supported_reports_fee_sponsorship(self):
        # A buyer reads this to learn whether it needs XLM for fees.
        with mock.patch.object(self.client.session, "get") as get:
            get.return_value = _response(
                {
                    "kinds": [
                        {
                            "x402Version": 2,
                            "scheme": "exact",
                            "network": "stellar:testnet",
                            "extra": {"areFeesSponsored": True},
                        }
                    ],
                    "signers": {"stellar:*": ["GABC"]},
                }
            )
            kinds = self.client.get_supported_schemes()

        self.assertEqual(urlparse(get.call_args[0][0]).path, "/supported")
        self.assertEqual(kinds[0]["scheme"], "exact")
        self.assertTrue(kinds[0]["extra"]["areFeesSponsored"])

    def test_trailing_slash_in_the_base_url_does_not_double_up(self):
        client = FacilitatorClient(
            facilitator_url=FACILITATOR_URL + "/", network="testnet"
        )
        self.assertFalse(client.facilitator_url.endswith("/"))


if __name__ == "__main__":
    unittest.main()

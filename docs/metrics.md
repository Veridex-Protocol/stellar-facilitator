# Prometheus Metrics

Both services expose Prometheus text format at `GET /metrics`. Counters are
process-local and reset on restart. Gauges represent scrape-time state.

| Metric | Service | Type | Meaning |
|---|---|---|---|
| `veridex_verifications_total` | Facilitator | counter | Structurally valid verification requests accepted for processing. |
| `veridex_settlements_total` | Facilitator | counter | Structurally valid settlement requests accepted for processing. |
| `veridex_settlement_failures_total` | Facilitator | counter | Settlement requests returning an unsuccessful result. |
| `veridex_settlement_latency` | Facilitator | histogram | End-to-end settlement handler latency in seconds. |
| `veridex_sponsored_fee_total` | Facilitator | counter | Confirmed sponsored fees in stroops when the mechanism reports them. The current upstream exact response does not report a fee, so this remains zero rather than estimating. |
| `veridex_channel_available` | Facilitator | gauge | Settlement signer leases available at scrape time. |
| `veridex_channel_in_use` | Facilitator | gauge | Settlement signer leases currently in flight. |
| `veridex_channel_quarantined` | Facilitator | gauge | Channel-pool accounts in an error state. The upstream scheme scheduler has no uncertainty quarantine yet. |
| `veridex_channel_sequence_drift` | Facilitator | counter | Sequence-drift events reported by the legacy channel settler. Canonical upstream exact does not currently expose this event, so it remains zero there. |
| `veridex_rpc_requests_total` | Facilitator | counter | RPC-dependent verify and settle operations initiated by this process. This is an operation count, not raw SDK HTTP calls. |
| `veridex_rpc_failures_total` | Facilitator | counter | Operations classified as upstream RPC unavailable. |
| `veridex_rpc_disagreements_total` | Facilitator | counter | Conflicting final transaction states from independent providers. Remains zero until multi-provider reconciliation is enabled. |
| `veridex_catalog_resources_total` | Bazaar | gauge | HTTP and MCP resources currently searchable in the local catalog. |
| `veridex_catalog_ingestion_lag` | Bazaar | gauge | Age in seconds of the oldest row still awaiting verification. |
| `veridex_catalog_revalidation_failures_total` | Bazaar | counter | Rows quarantined by the periodic live-term worker. |
| `veridex_embedding_backlog` | Bazaar | gauge | Searchable rows with no embedding. |
| `veridex_search_requests_total` | Bazaar | counter | Hybrid search requests accepted for processing. |
| `veridex_search_latency` | Bazaar | histogram | Search handler latency in seconds. |
| `veridex_search_zero_results_total` | Bazaar | counter | Searches returning zero resources. |
| `veridex_provider_observations_total` | Bazaar | counter | Verified provider observations accepted. |
| `veridex_provider_faults_total` | Bazaar | counter | Accepted observations explicitly attributed to provider fault. |
| `veridex_p2p_messages_total` | Bazaar | counter | P2P messages received by this process. |
| `veridex_p2p_replays_total` | Bazaar | counter | Announcement messages rejected as duplicate or out-of-order replay. |

Example scrape:

```bash
curl -fsS http://localhost:3002/metrics
curl -fsS http://localhost:3001/metrics
```

These endpoints are operational signals, not durable analytics. Published
historical rates should come from a Prometheus server or the structured outcome
logs, not from `/stats` snapshots.
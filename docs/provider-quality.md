# Provider quality

Provider quality is an experimental Veridex evidence plane. It is separate from
x402 payment authority and must not become a synchronous dependency of the
protocol settlement path.

## Per-call outcome

A signed `veridex/provider-outcome/1` record binds the resource and `payTo` to
request/result digests and reports:

| Field | Meaning |
|---|---|
| `usable` | Whether the delivered result was usable for the declared call |
| `providerAtFault` | Whether an unusable result is attributable to the provider |
| `attributable` | `provider`, `caller`, or `unknown` |
| `reasonCode` | Stable outcome reason such as `ok` or `data_stale` |
| `usageAtomic` | Optional actual usage for a metered call |
| `settlementTx` | Optional transaction binding added after settlement |

`providerAtFault: true` requires `attributable: "provider"`. A usable outcome
cannot also report provider fault.

In the response-aware seller path:

- usable results settle;
- provider-attributed unusable results skip settlement;
- caller-attributed or unknown failures follow explicit local policy.

This immediate decision is local to the seller/resource integration. It is not
a Bazaar authorization decision.

## Observation sources and disagreement

Bazaar persists observations as `in_band` or `independent`. When matching
request/resource observations disagree on `usable`, `providerAtFault`,
`attributable`, or `reasonCode`, it stores the differing fields and increments a
disagreement metric. It does not silently replace one source with the other.

## Aggregates

Signed `veridex/provider-aggregate/1` records expose:

| Field | Meaning |
|---|---|
| `state` | `insufficient_data`, `provisional`, or `published` |
| `n` | Number of observations in the configured window |
| `faultsObserved` | Provider-attributed faults in that window |
| `faultRateUpperBound` | Wilson upper confidence bound for the observed fault proportion |
| `window` | Aggregation window label, currently defaulting to `30d` |

Default state thresholds are 20 observations for `provisional` and 100 for
`published`. `faultRateUpperBound` is not the provider's actual failure rate or
a probability that the next call fails. It is a conservative statistical upper
bound used by policy.

## Seller policy

The SDK policy engine returns `sell`, `sell-and-warn`, or `hold`. Defaults use:

- `sell-and-warn` for insufficient/provisional data;
- `sell` for published evidence below the warning boundary;
- `sell-and-warn` at or above `warnMax` (`0.10` by default);
- `hold` above `holdMax` (`0.15` by default).

Stale, invalid, or unavailable aggregate behavior is configured explicitly. The
default preserves payment availability rather than making the observatory a
synchronous dependency.

## Current evidence boundary

Signed outcomes, source/disagreement persistence, Wilson aggregates, endpoint
reads, caching/backoff, and seller policy boundaries are implemented and tested.
A representative corpus of independently operated observers and a mature public
quality service are not proven.

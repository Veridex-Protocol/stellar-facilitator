# ADR-002: Ranking - Telemetry-Weighted Fusion Now, Learned Embeddings Behind a Provider Seam

## Status

Accepted (2026-08-23) - records why the composite score fuses live telemetry with retrieval, why the "vector" leg is currently feature hashing and is labelled as such everywhere, and the exact conditions under which a learned model ships.

Reconciled 2026-09-06: the text leg is PostgreSQL `ts_rank_cd`, not BM25. A
10-document/50-query reviewed regression artifact now reports Recall@1/5/20,
nDCG@5/10, MRR, coverage, zero-result behavior, and in-memory latency. The
corpus and latency are still not production evidence.

Refines the composite ranking in [spec-v2.md §3.2](../specifications/spec-v2.md), and corrects its description of the vector leg as semantic.

## Context

The project brief is blunt that this is the hard part:

> Search quality is a deliverable, not a detail: this means real ranking, and submissions must describe both their retrieval approach and how they will evaluate result quality over time. It is the hardest part of the scope and the part existing catalogs most often leave unimplemented.

There are two separable problems hiding in "search quality", and conflating them is how catalogs end up shipping neither.

**Problem one is retrieval**: given a natural-language query, find candidate resources. The current implementation uses `ts_rank_cd` full-text ranking plus lexical feature hashing.

**Problem two is selection**: of the candidates, which should an agent actually call? A perfectly relevant endpoint that has been dead for six hours is a worse answer than a slightly-less-relevant one that settled a payment ninety seconds ago. Text relevance cannot see this, because the signal is not in the text.

Problem two is the one specific to a *payments* catalog, and a general-purpose search engine has no signal for it. An agent paying per request has real money and a real deadline at stake; recommending a dead API is not a ranking inaccuracy, it is a failed task. We have signals a general search engine does not: settlement counts, heartbeat liveness, measured latency, settlement success ratios. All of it is ground truth about whether an endpoint *works*, and all of it is free - it is a byproduct of being the facilitator.

Problem one, meanwhile, remains lexically bounded. The vector leg is 384-dimensional feature hashing over unigrams and bigrams, not a learned model. It places tokens in a fixed space by hash, so documents are close when they *share tokens*. "car" and "automobile" land in unrelated dimensions. In the current fusion it therefore behaves as a **second lexical signal alongside PostgreSQL full-text rank, not a semantic one**.

Our earlier code and schema described this as "semantic search" with a docstring claiming `all-MiniLM-L6-v2`. That was untrue, and a reviewer reading the code would have caught it. It is now labelled accurately everywhere: the response field is `vectorScore`, the weight is `weights.vector`, and [`embeddings.ts`](../../bazaar-service/src/search/embeddings.ts) states in its header what the technique is and is not.

## Decision

**Fuse five signals with telemetry as a first-class input. Keep the retrieval leg swappable behind a provider seam. Ship feature hashing today, labelled honestly, and gate the learned model on the conditions in the next section.**

### 1. The composite score

$$\Phi = w_1 S_{\text{vector}} + w_2 S_{\text{text}} + w_3 S_{\text{uptime}} + w_4 S_{\text{latency}} + w_5 S_{\text{reliability}}$$

with $w = [0.35, 0.25, 0.15, 0.15, 0.10]$, and a liveness multiplier applied to the whole:

| Liveness | Multiplier | Effect |
| --- | --- | --- |
| `HEALTHY` | 1.0 | Ranked normally |
| `DEGRADED` | 0.3 | Demoted ~70% |
| `OFFLINE` | 0.0 | Filtered out entirely |

$S_{\text{latency}} = \exp(-\text{ms}/500)$ - an exponential penalty, so 100ms scores 0.82 and 2s scores 0.02. Linear decay would treat 2s as merely "somewhat worse"; for an agent it is qualitatively different.

$S_{\text{reliability}} = \min(1, \ln(\text{settlements}+1)/3)$ - logarithmic, because the difference between 0 and 10 settlements is large evidence and the difference between 1,000 and 1,010 is none.

The full fused query lives in [`engine.ts`](../../bazaar-service/src/search/engine.ts) and runs in one round trip: two CTE candidate pools, a telemetry join, and the weighted sum in SQL.

### 2. `partialResults` is computed, not decorative

Each retrieval leg contributes at most `CANDIDATE_POOL_SIZE = 50` candidates before fusion. If a leg fills its pool there were matches ranking never saw, so this page is not a complete answer:

```ts
const poolSaturated =
  vectorCandidates >= CANDIDATE_POOL_SIZE || textCandidates >= CANDIDATE_POOL_SIZE;
```

and `partialReason` says so in words. The spec asks for the flag; returning a hardcoded `false` would satisfy the schema and lie.

### 3. The embedding provider is a seam, not a hardcode

`generateEmbedding()` is the only entry point, its output dimension is fixed at 384 to match the `vector(384)` column, and the technique behind it is an implementation detail. Swapping in a learned model is a provider change plus a re-index, not a schema migration.

### 4. Feature hashing ships today, described accurately

Not "semantic". Not "vector search" in the learned-representation sense. It is a second lexical signal over hashed unigrams/bigrams, requires no model download, native runtime, or network call, and remains subject to lexical-overlap limits.

## Why the learned model is not shipped yet, and what turns it on

This is the weakest part of this implementation. A learned embedding model behind a measured evaluation loop - graded relevance judgements, rank metrics reported per change, and a gate that fails on regression - is standard practice in information retrieval and is a straightforwardly better answer to problem one than feature hashing. We do not have it, and claiming otherwise would be worse than useless.

We have not shipped it because doing it *properly* is the evaluation harness, not the model. Dropping in MiniLM without a way to measure whether results improved would be cargo culting: we would have swapped a signal we understand for one we cannot audit, and we would have no way to know if a later change regressed it. A model with no eval is a worse position than honest feature hashing, because it *looks* solved.

### Turn it on when all of these hold

1. **A representative labelled corpus exists.** The current 10-document/50-query set is a useful reviewer regression artifact, not a realistic traffic corpus.
2. **nDCG@10 and recall metrics are computed on every change** and gated once a representative baseline and accepted regression tolerance exist.
3. **The model runtime is optional at install time.** Inference runtimes are large native dependencies, and an operator who wants lexical-only retrieval must not be forced to carry one. Its absence must be a *degraded state with a stated reason*, never a crash - the same failure discipline as the rest of this codebase.
4. **Re-indexing is a runbook step**, because changing the embedding function invalidates every stored vector. Mixed-generation vectors in one column produce silently wrong distances.

### The switch

No schema migration: the column is already `vector(384)`. A provider swap plus a backfill of `catalog_resources.embedding`. If a model with a different dimension is chosen, the column and the index change too, which is why 384 was fixed early.

## Consequences

**Good**

- Telemetry is a first-class ranking input, which is the part of search quality actually specific to a payments catalog, and it works today. An agent will not be handed a dead endpoint by our ranking; `OFFLINE` is filtered, not demoted.
- Zero-dependency retrieval. No model download, no native runtime, no external API on the query path. Deterministic and reproducible: the same text always produces the same vector, so two nodes in the mesh compute identical embeddings without coordinating.
- `partialResults` means something, so a client can distinguish "these are all the matches" from "these are the first 50 we ranked".
- The honest labelling is itself defensible. A reviewer reading `vectorScore` and finding feature hashing behind it finds exactly what the code says.

**Costs accepted**

- **Our retrieval is lexically bounded.** A query for "weather" will not match a resource described only as "meteorological forecasts". Any catalog using learned embeddings will answer that query and we will not. It is a real quality gap on the most valuable part of the scope, and we do not have a way to argue it away.
- **The evaluation methodology is small and in-memory.** It now ships, but it does not measure PostgreSQL/network latency or representative production relevance.
- **Ranking quality is bounded by local corpus size**, compounding with the federation decision in [ADR-001](./adr-001-discovery-federation.md). A cold node ranks poorly no matter which retrieval technique it uses.
- **The weights are unvalidated.** $[0.35, 0.25, 0.15, 0.15, 0.10]$ is a considered guess, not a fitted result. With no labelled set we cannot claim otherwise, and we do not.

**Deliberately not done**

- **No reranker.** A cross-encoder second stage is the standard next quality step and is pointless before the first stage is measurable.
- **No external embedding API.** A hosted embedding provider on the query path adds a network dependency, a cost centre, and a privacy question about forwarding buyer queries to a third party. If a learned model ships it runs locally.
- **No query-log-driven tuning.** Learning weights from click-through needs traffic we do not have, and doing it early bakes in the biases of a tiny sample.

## References

- [`bazaar-service/src/search/engine.ts`](../../bazaar-service/src/search/engine.ts) - the fused query, candidate pools, `partialResults`
- [`bazaar-service/src/search/embeddings.ts`](../../bazaar-service/src/search/embeddings.ts) - the provider seam and what it honestly is
- [`bazaar-service/src/search/types.ts`](../../bazaar-service/src/search/types.ts) - `RankingWeights`, `vectorScore`
- [`bazaar-service/src/telemetry/tracker.ts`](../../bazaar-service/src/telemetry/tracker.ts) - the liveness multiplier's inputs
- [ADR-003](./adr-003-settlement-liveness.md) - how liveness itself is determined
- Project brief §3.2 - "search quality is a deliverable, not a detail"

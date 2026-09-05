# Search relevance benchmark

The judged dataset in `dataset.ts` is the regression baseline for discovery
ranking. `runner.ts` reports nDCG, MRR, recall, and precision for the current
embedding provider and lexical leg.

The repository default is deterministic feature hashing. It is intentionally
described as lexical, not semantic. A learned provider may be configured only
after running this benchmark and recording the provider name, model revision,
dimension, and metric results in the evidence report.
/**
 * Reproducible search-evaluation report shape.
 * License: Apache-2.0
 */

import { getEmbeddingProviderName } from "../embeddings.js";
import { runSearchEvaluation } from "./runner.js";

export async function createSearchEvaluationReport() {
  const result = await runSearchEvaluation();
  return {
    provider: getEmbeddingProviderName(),
    semanticClaim: false,
    generatedAt: new Date().toISOString(),
    ...result,
  };
}
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

if (import.meta.url === `file://${process.argv[1]}`) {
  createSearchEvaluationReport()
    .then((report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
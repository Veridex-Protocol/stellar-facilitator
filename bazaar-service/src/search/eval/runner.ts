/**
 * Veridex Bazaar Search Evaluation - Evaluation Runner & CI Regression Gate
 * License: Apache-2.0
 */

import {
  BENCHMARK_DOCUMENTS,
  BENCHMARK_QUERIES,
  type BenchmarkDocument,
  type JudgedQuery,
} from "./dataset.js";
import {
  calculateNDCG,
  calculateReciprocalRank,
  calculateRecallAtK,
  calculatePrecisionAtK,
} from "./metrics.js";
import { generateEmbedding } from "../embeddings.js";

export interface EvaluationResult {
  meanNDCG5: number;
  meanNDCG10: number;
  meanMRR: number;
  meanRecall5: number;
  meanPrecision5: number;
  queryResults: {
    query: string;
    ndcg5: number;
    ndcg10: number;
    mrr: number;
    recall5: number;
    precision5: number;
    rankedIds: string[];
  }[];
}

/**
 * In-memory Reciprocal Rank Fusion implementation mirroring the SQL search engine
 * used for benchmark evaluation and automated regression testing.
 */
export async function rankBenchmarkDocuments(
  query: string,
  documents: BenchmarkDocument[] = BENCHMARK_DOCUMENTS,
  weights = { vector: 1.0, text: 1.0, rrfK: 60 }
): Promise<string[]> {
  const queryTokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const queryEmbedding = await generateEmbedding(query);

  // 1. Vector similarity leg
  const vectorScores: { id: string; score: number }[] = [];
  for (const doc of documents) {
    const docText = `${doc.serviceName} ${doc.description} ${doc.tags.join(" ")}`;
    const docEmbedding = await generateEmbedding(docText);
    // Cosine similarity
    let dot = 0;
    for (let i = 0; i < queryEmbedding.length; i++) {
      dot += queryEmbedding[i] * docEmbedding[i];
    }
    vectorScores.push({ id: doc.id, score: dot });
  }
  vectorScores.sort((a, b) => b.score - a.score);
  const vectorRankMap = new Map<string, number>();
  vectorScores.forEach((item, index) => vectorRankMap.set(item.id, index + 1));

  // 2. Full-text cover density leg (lexical match over tokens)
  const textScores: { id: string; score: number }[] = [];
  for (const doc of documents) {
    const docText = `${doc.serviceName} ${doc.description} ${doc.tags.join(" ")}`.toLowerCase();
    let matches = 0;
    for (const token of queryTokens) {
      if (docText.includes(token)) {
        matches++;
      }
    }
    const score = matches / Math.max(1, queryTokens.length);
    textScores.push({ id: doc.id, score });
  }
  textScores.sort((a, b) => b.score - a.score);
  const textRankMap = new Map<string, number>();
  textScores.forEach((item, index) => textRankMap.set(item.id, index + 1));

  // 3. Reciprocal Rank Fusion (RRF)
  const k = weights.rrfK || 60;
  const fusedScores: { id: string; rrfScore: number }[] = [];
  for (const doc of documents) {
    const vRank = vectorRankMap.get(doc.id) || 1000;
    const tRank = textRankMap.get(doc.id) || 1000;

    const rrfScore = (weights.vector / (k + vRank)) + (weights.text / (k + tRank));
    fusedScores.push({ id: doc.id, rrfScore });
  }

  fusedScores.sort((a, b) => b.rrfScore - a.rrfScore);
  return fusedScores.map((item) => item.id);
}

/**
 * Evaluates the retrieval engine against the benchmark dataset
 */
export async function runSearchEvaluation(
  queries: JudgedQuery[] = BENCHMARK_QUERIES,
  documents: BenchmarkDocument[] = BENCHMARK_DOCUMENTS
): Promise<EvaluationResult> {
  const queryResults: EvaluationResult["queryResults"] = [];

  let totalNDCG5 = 0;
  let totalNDCG10 = 0;
  let totalMRR = 0;
  let totalRecall5 = 0;
  let totalPrecision5 = 0;

  for (const q of queries) {
    const rankedIds = await rankBenchmarkDocuments(q.query, documents);

    const ndcg5 = calculateNDCG(rankedIds, q.qrels, 5);
    const ndcg10 = calculateNDCG(rankedIds, q.qrels, 10);
    const mrr = calculateReciprocalRank(rankedIds, q.qrels);
    const recall5 = calculateRecallAtK(rankedIds, q.qrels, 5);
    const precision5 = calculatePrecisionAtK(rankedIds, q.qrels, 5);

    totalNDCG5 += ndcg5;
    totalNDCG10 += ndcg10;
    totalMRR += mrr;
    totalRecall5 += recall5;
    totalPrecision5 += precision5;

    queryResults.push({
      query: q.query,
      ndcg5,
      ndcg10,
      mrr,
      recall5,
      precision5,
      rankedIds,
    });
  }

  const count = queries.length;
  return {
    meanNDCG5: totalNDCG5 / count,
    meanNDCG10: totalNDCG10 / count,
    meanMRR: totalMRR / count,
    meanRecall5: totalRecall5 / count,
    meanPrecision5: totalPrecision5 / count,
    queryResults,
  };
}

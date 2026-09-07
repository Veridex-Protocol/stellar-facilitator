/**
 * Veridex Bazaar Search Evaluation - Evaluation Runner & CI Regression Gate
 * License: Apache-2.0
 */

import { performance } from "node:perf_hooks";
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
} from "./metrics.js";
import { generateEmbedding } from "../embeddings.js";

export interface EvaluationMetrics {
  recall1: number;
  recall5: number;
  recall20: number;
  ndcg5: number;
  ndcg10: number;
  mrr: number;
  coverage: number;
  zeroResultRate: number;
  noResultAccuracy: number;
  latencyMs: { p50: number; p95: number };
}

export interface EvaluationResult {
  datasetSize: number;
  queryCount: number;
  labelingMethodology: string;
  evaluationProcedure: string;
  lexicalBaseline: EvaluationMetrics;
  currentHybrid: EvaluationMetrics;
  queryResults: Array<{
    query: string;
    category: JudgedQuery["category"];
    expectedNoResults: boolean;
    lexical: { rankedIds: string[]; latencyMs: number };
    current: { rankedIds: string[]; latencyMs: number };
  }>;
}

/**
 * In-memory Reciprocal Rank Fusion implementation mirroring the SQL search engine
 * used for benchmark evaluation and automated regression testing.
 */
export async function rankBenchmarkDocuments(
  query: string,
  documents: BenchmarkDocument[] = BENCHMARK_DOCUMENTS,
  weights = { vector: 1.0, text: 1.0, rrfK: 60 },
): Promise<string[]> {
  const queryTokens = tokenize(query);
  const queryEmbedding = await generateEmbedding(query);
  const vectorScores: { id: string; score: number }[] = [];
  const textScores: { id: string; score: number }[] = [];
  for (const document of documents) {
    const documentText = searchableText(document);
    const documentEmbedding = await generateEmbedding(documentText);
    let dot = 0;
    for (let index = 0; index < queryEmbedding.length; index++) {
      dot += queryEmbedding[index] * documentEmbedding[index];
    }
    vectorScores.push({ id: document.id, score: dot });
    textScores.push({ id: document.id, score: lexicalScore(queryTokens, documentText) });
  }

  vectorScores.sort(scoreOrder);
  textScores.sort(scoreOrder);
  const vectorRank = new Map(vectorScores.map((item, index) => [item.id, index + 1]));
  const textRank = new Map(textScores.filter((item) => item.score > 0).map((item, index) => [item.id, index + 1]));
  const candidates = new Set([
    ...vectorScores.filter((item) => textRank.has(item.id)).map((item) => item.id),
    ...textRank.keys(),
  ]);

  return [...candidates]
    .map((id) => ({
      id,
      score:
        (weights.vector / (weights.rrfK + (vectorRank.get(id) ?? 1000))) +
        (weights.text / (weights.rrfK + (textRank.get(id) ?? 1000))),
    }))
    .sort(scoreOrder)
    .map((item) => item.id);
}

export function rankLexicalDocuments(
  query: string,
  documents: BenchmarkDocument[] = BENCHMARK_DOCUMENTS,
): string[] {
  const queryTokens = tokenize(query);
  return documents
    .map((document) => ({ id: document.id, score: lexicalScore(queryTokens, searchableText(document)) }))
    .filter((item) => item.score > 0)
    .sort(scoreOrder)
    .map((item) => item.id);
}

/**
 * Evaluates the retrieval engine against the benchmark dataset
 */
export async function runSearchEvaluation(
  queries: JudgedQuery[] = BENCHMARK_QUERIES,
  documents: BenchmarkDocument[] = BENCHMARK_DOCUMENTS,
): Promise<EvaluationResult> {
  const queryResults: EvaluationResult["queryResults"] = [];
  for (const judgedQuery of queries) {
    const candidates = applyFilters(documents, judgedQuery);
    const lexicalStart = performance.now();
    const lexicalIds = rankLexicalDocuments(judgedQuery.query, candidates);
    const lexicalLatencyMs = performance.now() - lexicalStart;
    const currentStart = performance.now();
    const currentIds = await rankBenchmarkDocuments(judgedQuery.query, candidates);
    const currentLatencyMs = performance.now() - currentStart;
    queryResults.push({
      query: judgedQuery.query,
      category: judgedQuery.category,
      expectedNoResults: judgedQuery.expectedNoResults === true,
      lexical: { rankedIds: lexicalIds, latencyMs: lexicalLatencyMs },
      current: { rankedIds: currentIds, latencyMs: currentLatencyMs },
    });
  }

  return {
    datasetSize: documents.length,
    queryCount: queries.length,
    labelingMethodology: "Hand-authored graded relevance judgments: 3 perfect, 2 highly relevant, 1 marginal, 0 irrelevant. No-result queries have empty qrels.",
    evaluationProcedure: "Apply declared structured filters, rank the same in-memory corpus with lexical-only and feature-hash-plus-lexical RRF, then macro-average judged queries. Measure each ranking call with performance.now().",
    lexicalBaseline: summarize(queryResults.map((result, index) => ({
      rankedIds: result.lexical.rankedIds,
      latencyMs: result.lexical.latencyMs,
      query: queries[index],
    }))),
    currentHybrid: summarize(queryResults.map((result, index) => ({
      rankedIds: result.current.rankedIds,
      latencyMs: result.current.latencyMs,
      query: queries[index],
    }))),
    queryResults,
  };
}

function summarize(results: Array<{ rankedIds: string[]; latencyMs: number; query: JudgedQuery }>): EvaluationMetrics {
  const judged = results.filter(({ query }) => !query.expectedNoResults);
  const noResult = results.filter(({ query }) => query.expectedNoResults);
  const mean = (values: number[]) => values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
  const latencies = results.map(({ latencyMs }) => latencyMs).sort((left, right) => left - right);
  return {
    recall1: mean(judged.map(({ rankedIds, query }) => calculateRecallAtK(rankedIds, query.qrels, 1))),
    recall5: mean(judged.map(({ rankedIds, query }) => calculateRecallAtK(rankedIds, query.qrels, 5))),
    recall20: mean(judged.map(({ rankedIds, query }) => calculateRecallAtK(rankedIds, query.qrels, 20))),
    ndcg5: mean(judged.map(({ rankedIds, query }) => calculateNDCG(rankedIds, query.qrels, 5))),
    ndcg10: mean(judged.map(({ rankedIds, query }) => calculateNDCG(rankedIds, query.qrels, 10))),
    mrr: mean(judged.map(({ rankedIds, query }) => calculateReciprocalRank(rankedIds, query.qrels))),
    coverage: mean(judged.map(({ rankedIds, query }) =>
      Object.entries(query.qrels).some(([id, relevance]) => relevance > 0 && rankedIds.includes(id)) ? 1 : 0,
    )),
    zeroResultRate: mean(results.map(({ rankedIds }) => rankedIds.length === 0 ? 1 : 0)),
    noResultAccuracy: mean(noResult.map(({ rankedIds }) => rankedIds.length === 0 ? 1 : 0)),
    latencyMs: {
      p50: percentile(latencies, 0.50),
      p95: percentile(latencies, 0.95),
    },
  };
}

function applyFilters(documents: BenchmarkDocument[], query: JudgedQuery): BenchmarkDocument[] {
  return documents.filter((document) =>
    (!query.filters?.resourceType || document.resourceType === query.filters.resourceType) &&
    (!query.filters?.toolName || document.toolName === query.filters.toolName) &&
    (!query.filters?.tags || query.filters.tags.every((tag) => document.tags.includes(tag))),
  );
}

function searchableText(document: BenchmarkDocument): string {
  return `${document.serviceName} ${document.description} ${document.tags.join(" ")} ${document.toolName ?? ""}`.toLowerCase();
}

function tokenize(value: string): string[] {
  return value.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}

function lexicalScore(queryTokens: string[], documentText: string): number {
  if (queryTokens.length === 0) return 0;
  return queryTokens.filter((token) => documentText.includes(token)).length / queryTokens.length;
}

function scoreOrder(left: { id: string; score: number }, right: { id: string; score: number }): number {
  return right.score - left.score || left.id.localeCompare(right.id);
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  return values[Math.min(values.length - 1, Math.ceil(values.length * quantile) - 1)];
}

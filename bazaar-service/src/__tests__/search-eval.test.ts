/**
 * Veridex Bazaar - Search Evaluation & Regression Gate Tests
 * License: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import {
  calculateDCG,
  calculateIDCG,
  calculateNDCG,
  calculateReciprocalRank,
  calculateRecallAtK,
  calculatePrecisionAtK,
} from "../search/eval/metrics.js";
import { rankLexicalDocuments, runSearchEvaluation } from "../search/eval/runner.js";

describe("Search Evaluation Metrics & Regression Gate", () => {
  it("calculates DCG and IDCG correctly", () => {
    // Relevances: [3, 2, 0, 1]
    const rels = [3, 2, 0, 1];
    const dcg = calculateDCG(rels, 4);
    // i=0: (2^3-1)/log2(2) = 7 / 1 = 7.0
    // i=1: (2^2-1)/log2(3) = 3 / 1.58496 = 1.892789
    // i=2: 0
    // i=3: (2^1-1)/log2(5) = 1 / 2.321928 = 0.430676
    expect(dcg).toBeCloseTo(7.0 + 1.892789 + 0.430676, 2);

    const idcg = calculateIDCG(rels, 4);
    expect(idcg).toBeGreaterThanOrEqual(dcg);
  });

  it("calculates perfect nDCG = 1.0 when ranking matches ground truth", () => {
    const qrels = { "doc-1": 3, "doc-2": 2, "doc-3": 1, "doc-4": 0 };
    const perfectRanking = ["doc-1", "doc-2", "doc-3", "doc-4"];
    const ndcg = calculateNDCG(perfectRanking, qrels, 4);
    expect(ndcg).toBe(1.0);
  });

  it("penalizes inverted ranking in nDCG", () => {
    const qrels = { "doc-1": 3, "doc-2": 2, "doc-3": 1, "doc-4": 0 };
    const invertedRanking = ["doc-4", "doc-3", "doc-2", "doc-1"];
    const ndcg = calculateNDCG(invertedRanking, qrels, 4);
    expect(ndcg).toBeLessThan(0.6);
  });

  it("calculates MRR (Mean Reciprocal Rank) correctly", () => {
    const qrels = { "doc-1": 3, "doc-2": 0 };
    expect(calculateReciprocalRank(["doc-1", "doc-2"], qrels)).toBe(1.0); // 1/1
    expect(calculateReciprocalRank(["doc-2", "doc-1"], qrels)).toBe(0.5); // 1/2
  });

  it("calculates Recall@k and Precision@k correctly", () => {
    const qrels = { "doc-1": 2, "doc-2": 2, "doc-3": 0, "doc-4": 0 };
    const ranking = ["doc-1", "doc-3", "doc-2", "doc-4"];

    // Top 2: ["doc-1", "doc-3"] -> 1 relevant hit
    expect(calculateRecallAtK(ranking, qrels, 2)).toBe(0.5); // 1/2
    expect(calculatePrecisionAtK(ranking, qrels, 2)).toBe(0.5); // 1/2

    // Top 3: ["doc-1", "doc-3", "doc-2"] -> 2 relevant hits
    expect(calculateRecallAtK(ranking, qrels, 3)).toBe(1.0); // 2/2
    expect(calculatePrecisionAtK(ranking, qrels, 3)).toBeCloseTo(2 / 3, 2);
  });

  it("satisfies CI search quality regression gates on judged benchmark queries", async () => {
    const results = await runSearchEvaluation();

    console.log("[Search Eval Benchmark Results]", {
      datasetSize: results.datasetSize,
      queryCount: results.queryCount,
      lexicalBaseline: results.lexicalBaseline,
      currentHybrid: results.currentHybrid,
    });

    expect(results.datasetSize).toBe(10);
    expect(results.queryCount).toBe(11);
    expect(new Set(results.queryResults.map(({ category }) => category))).toEqual(new Set([
      "exact",
      "paraphrase",
      "zero_lexical_overlap",
      "ambiguous",
      "no_result",
      "mcp",
      "filtered",
    ]));
    expect(results.currentHybrid.ndcg10).toBeGreaterThanOrEqual(0.75);
    expect(results.currentHybrid.mrr).toBeGreaterThanOrEqual(0.75);
    expect(results.currentHybrid.recall5).toBeGreaterThanOrEqual(0.70);
    expect(results.currentHybrid.noResultAccuracy).toBe(1);
    expect(results.lexicalBaseline.noResultAccuracy).toBe(1);
    expect(results.currentHybrid.latencyMs.p95).toBeGreaterThanOrEqual(results.currentHybrid.latencyMs.p50);
    expect(results.lexicalBaseline.latencyMs.p95).toBeGreaterThanOrEqual(results.lexicalBaseline.latencyMs.p50);
  });

  it("returns no lexical result when a query has zero token overlap", () => {
    expect(rankLexicalDocuments("quantum livestock genomics")).toEqual([]);
  });
});

/**
 * Veridex Bazaar Search Evaluation - Information Retrieval Metrics
 * License: Apache-2.0
 *
 * Implements standard IR retrieval metrics:
 * - nDCG@k (Normalized Discounted Cumulative Gain)
 * - MRR (Mean Reciprocal Rank)
 * - Recall@k
 * - Precision@k
 */

/**
 * Calculates Discounted Cumulative Gain (DCG@k) with exponential gain
 */
export function calculateDCG(relevances: number[], k: number): number {
  let dcg = 0;
  const limit = Math.min(relevances.length, k);
  for (let i = 0; i < limit; i++) {
    const gain = Math.pow(2, relevances[i]) - 1;
    const discount = Math.log2(i + 2); // 1-indexed: i=0 -> log2(2) = 1
    dcg += gain / discount;
  }
  return dcg;
}

/**
 * Calculates Ideal DCG (IDCG@k) by sorting all available relevances descending
 */
export function calculateIDCG(allRelevances: number[], k: number): number {
  const sorted = [...allRelevances].sort((a, b) => b - a);
  return calculateDCG(sorted, k);
}

/**
 * Calculates Normalized Discounted Cumulative Gain (nDCG@k)
 *
 * @param rankedDocIds - Array of document IDs returned by search (ordered by rank)
 * @param qrels - Ground truth mapping of document ID to graded relevance
 * @param k - Cutoff rank (e.g. 5, 10)
 * @returns nDCG score in range [0, 1]
 */
export function calculateNDCG(
  rankedDocIds: string[],
  qrels: Record<string, number>,
  k: number
): number {
  const relevances = rankedDocIds.slice(0, k).map((id) => qrels[id] ?? 0);
  const allRelevances = Object.values(qrels);

  const idcg = calculateIDCG(allRelevances, k);
  if (idcg === 0) return 1.0; // If there are no relevant documents, score is 1.0

  const dcg = calculateDCG(relevances, k);
  return Math.min(1.0, dcg / idcg);
}

/**
 * Calculates Reciprocal Rank (RR) of the first document with relevance >= minRelevant
 */
export function calculateReciprocalRank(
  rankedDocIds: string[],
  qrels: Record<string, number>,
  minRelevant = 1
): number {
  for (let i = 0; i < rankedDocIds.length; i++) {
    const rel = qrels[rankedDocIds[i]] ?? 0;
    if (rel >= minRelevant) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

/**
 * Calculates Recall@k for relevant documents (rel >= minRelevant)
 */
export function calculateRecallAtK(
  rankedDocIds: string[],
  qrels: Record<string, number>,
  k: number,
  minRelevant = 1
): number {
  const relevantDocIds = Object.keys(qrels).filter((id) => (qrels[id] ?? 0) >= minRelevant);
  if (relevantDocIds.length === 0) return 1.0;

  const topKDocIds = new Set(rankedDocIds.slice(0, k));
  let hits = 0;
  for (const id of relevantDocIds) {
    if (topKDocIds.has(id)) {
      hits++;
    }
  }
  return hits / relevantDocIds.length;
}

/**
 * Calculates Precision@k for relevant documents (rel >= minRelevant)
 */
export function calculatePrecisionAtK(
  rankedDocIds: string[],
  qrels: Record<string, number>,
  k: number,
  minRelevant = 1
): number {
  if (k <= 0) return 0;
  const topK = rankedDocIds.slice(0, k);
  if (topK.length === 0) return 0;

  let relevantHits = 0;
  for (const id of topK) {
    if ((qrels[id] ?? 0) >= minRelevant) {
      relevantHits++;
    }
  }
  return relevantHits / topK.length;
}

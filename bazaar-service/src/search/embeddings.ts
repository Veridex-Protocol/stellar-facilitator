/**
 * Veridex Bazaar Discovery Engine - Text Embedding Generation
 * License: Apache-2.0
 *
 * Deterministic 384-dimensional **feature hashing** over unigrams and bigrams.
 * Keeps deployments offline, reproducible, and free of native model installs.
 *
 * Be clear about what this is and is not. Feature hashing places tokens in a
 * fixed vector space by hash, so two documents are close when they share
 * tokens. It carries no semantics: "car" and "automobile" land in unrelated
 * dimensions. In the hybrid RRF ranking this is therefore a second *lexical*
 * signal alongside BM25, not a semantic one - useful for bigram and
 * out-of-vocabulary matching that BM25 misses, but it is not what the
 * literature means by dense retrieval.
 *
 * True semantic retrieval needs a learned model behind
 * `EMBEDDING_PROVIDER`. That work is scoped in the roadmap; until it lands,
 * nothing here should be described as semantic or vector search.
 */

import { createHash } from "node:crypto";

const EMBEDDING_DIMENSION = 384;
let initialized = false;

/**
 * Initializes the embedding pipeline.
 *
 * Feature hashing needs no model load; this exists so the service startup
 * sequence stays identical when a learned provider is added behind
 * `EMBEDDING_PROVIDER`.
 */
export async function initializeEmbeddingModel(): Promise<void> {
  initialized = true;
}

/**
 * Generates a 384-dimensional feature-hash vector for text.
 *
 * @param text - Input text to embed
 * @returns An L2-normalized vector of EMBEDDING_DIMENSION components
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  if (!initialized) {
    await initializeEmbeddingModel();
  }

  const normalizedText = text.toLowerCase().normalize("NFKC");
  const tokens = normalizedText.match(/[\p{L}\p{N}]+/gu) || [];
  const features = [
    ...tokens,
    ...tokens.slice(0, -1).map((token, index) => `${token}_${tokens[index + 1]}`),
  ];
  const embedding = new Array<number>(EMBEDDING_DIMENSION).fill(0);

  for (const feature of features) {
    const digest = createHash("sha256").update(feature).digest();
    const index = digest.readUInt32BE(0) % EMBEDDING_DIMENSION;
    const sign = (digest[4] & 1) === 0 ? 1 : -1;
    embedding[index] += sign;
  }

  return normalizeVector(embedding);
}

/**
 * Generate embedding from resource metadata
 * Concatenates: description + service_name + tags
 *
 * @param description - Resource description
 * @param serviceName - Optional service name
 * @param tags - Optional tags array
 * @returns Normalized embedding vector
 */
export async function generateResourceEmbedding(
  description: string,
  serviceName?: string,
  tags?: string[]
): Promise<number[]> {
  const textParts = [description];

  if (serviceName) {
    textParts.push(serviceName);
  }

  if (tags && tags.length > 0) {
    textParts.push(tags.join(" "));
  }

  const combinedText = textParts.join(" ");
  return generateEmbedding(combinedText);
}

/**
 * Calculate cosine similarity between two vectors
 *
 * @param a - First vector
 * @param b - Second vector
 * @returns Cosine similarity score (0 to 1)
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error("Vectors must have the same dimension");
  }

  let dotProduct = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    magnitudeA += a[i] * a[i];
    magnitudeB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB);

  if (magnitude === 0) {
    return 0;
  }

  return dotProduct / magnitude;
}

/**
 * Normalize vector to unit length
 *
 * @param vector - Input vector
 * @returns Normalized vector
 */
export function normalizeVector(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));

  if (magnitude === 0) {
    return vector;
  }

  return vector.map(val => val / magnitude);
}

/**
 * Returns the embedding dimension (384, matching the `vector(384)` column)
 */
export function getEmbeddingDimension(): number {
  return EMBEDDING_DIMENSION;
}

/**
 * Check if embedding model is initialized
 */
export function isModelInitialized(): boolean {
  return initialized;
}

/**
 * Format embedding as PostgreSQL vector string
 *
 * @param embedding - Embedding vector
 * @returns PostgreSQL vector format: '[0.1, 0.2, ...]'
 */
export function formatEmbeddingForPostgres(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

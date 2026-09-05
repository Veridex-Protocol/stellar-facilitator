/**
 * Veridex Bazaar Discovery Engine - Search & Cosine Similarity Tests
 * License: Apache-2.0
 */

import { describe, it, expect } from "vitest";
import { cosineSimilarity, HttpEmbeddingProvider, configureEmbeddingProvider, generateEmbedding, getEmbeddingProviderName } from "../search/embeddings.js";

describe("Embeddings & Vector Search Utilities", () => {
  it("should calculate identical vector similarity as 1.0", () => {
    const vecA = [0.5, 0.5, 0.5, 0.5];
    const vecB = [0.5, 0.5, 0.5, 0.5];
    const similarity = cosineSimilarity(vecA, vecB);
    expect(similarity).toBeCloseTo(1.0, 5);
  });

  it("should calculate orthogonal vector similarity as 0.0", () => {
    const vecA = [1, 0, 0, 0];
    const vecB = [0, 1, 0, 0];
    const similarity = cosineSimilarity(vecA, vecB);
    expect(similarity).toBeCloseTo(0.0, 5);
  });

  it("should throw error if vector dimensions mismatch", () => {
    const vecA = [1, 2, 3];
    const vecB = [1, 2];
    expect(() => cosineSimilarity(vecA, vecB)).toThrow("Vectors must have the same dimension");
  });

  it("keeps the deterministic feature-hash provider explicitly non-semantic", async () => {
    expect(getEmbeddingProviderName()).toBe("feature-hash");
    expect((await generateEmbedding("car")).length).toBe(384);
  });

  it("falls back when a configured HTTP provider fails", async () => {
    configureEmbeddingProvider(new HttpEmbeddingProvider({
      endpoint: "https://embeddings.example/v1",
      fetchImpl: (async () => new Response("offline", { status: 503 })) as typeof fetch,
    }));
    expect((await generateEmbedding("automobile")).length).toBe(384);
    configureEmbeddingProvider({
      name: "feature-hash",
      dimension: 384,
      embed: async (text: string) => generateEmbedding(text),
    });
  });
});

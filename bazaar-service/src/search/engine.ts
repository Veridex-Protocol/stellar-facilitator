/**
 * Veridex Bazaar Discovery Engine - Hybrid RRF Search Engine
 * License: Apache-2.0
 *
 * Implements Reciprocal Rank Fusion (RRF) combining:
 * - BM25 full-text keyword search (PostgreSQL ts_rank_cd)
 * - Feature-hash vector similarity (pgvector cosine distance)
 * - Real-time telemetry ranking (uptime, latency, reliability)
 *
 * The vector leg is feature hashing, not a learned model, so it behaves as a
 * second lexical signal rather than a semantic one. See search/embeddings.ts.
 */

import pkg from "pg";
const { Pool } = pkg;
import type { Pool as PoolType } from "pg";
import {
  type ResourceFilters,
  type SearchQuery,
  type SearchResponse,
  type SearchResult,
  type RankingWeights,
  type DatabaseConfig,
  DEFAULT_RANKING_WEIGHTS,
} from "./types.js";
import { generateEmbedding } from "./embeddings.js";
import { decodeCursor, encodeCursor, fingerprint } from "./cursor.js";

/**
 * How many candidates each leg of the hybrid search contributes before fusion.
 *
 * Ranking only ever sees this many rows per leg, so when a leg fills its pool
 * there were probably matches it never considered. That is exactly what the
 * spec's `partialResults` flag is for, and it is why the flag cannot simply be
 * hardcoded false.
 */
const CANDIDATE_POOL_SIZE = 50;

export class BazaarSearchEngine {
  private pool: PoolType;
  private weights: RankingWeights;

  constructor(config: DatabaseConfig, weights: RankingWeights = DEFAULT_RANKING_WEIGHTS) {
    this.pool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
      max: config.maxConnections || 20,
    });

    this.weights = weights;
  }

  /**
   * Execute hybrid RRF search combining vector similarity, BM25 text match, and telemetry ranking
   */
  async search(query: SearchQuery): Promise<SearchResponse> {
    const { query: searchText, limit } = query;

    // A cursor is only valid for the query and filters that issued it, so the
    // fingerprint covers both.
    const queryFingerprint = fingerprint({
      q: searchText,
      resourceType: query.resourceType,
      network: query.network,
      scheme: query.scheme,
      payTo: query.payTo,
      extensions: query.extensions,
      tags: query.tags,
      minUptimeRatio: query.minUptimeRatio,
    });

    const offset = query.cursor
      ? decodeCursor(query.cursor, queryFingerprint).offset
      : query.offset;

    // Generate query embedding
    const queryEmbedding = await generateEmbedding(searchText);
    const embeddingString = `[${queryEmbedding.join(",")}]`;

    // Build filter conditions
    const filters: string[] = [];
    const params: any[] = [searchText, embeddingString, limit, offset];
    let paramIndex = 5;

    if (query.resourceType) {
      filters.push(`r.resource_type = $${paramIndex++}`);
      params.push(query.resourceType);
    }

    if (query.network) {
      filters.push(`r.network = $${paramIndex++}`);
      params.push(query.network);
    }

    if (query.scheme) {
      filters.push(`r.scheme = $${paramIndex++}`);
      params.push(query.scheme);
    }

    if (query.payTo) {
      filters.push(`r.pay_to = $${paramIndex++}`);
      params.push(query.payTo);
    }

    if (query.extensions && query.extensions.length > 0) {
      // `?&` is "JSONB has all these top-level keys". node-postgres uses $n
      // placeholders, so a literal `?` in the SQL is unambiguous here.
      filters.push(`r.extensions ?& $${paramIndex++}::text[]`);
      params.push(query.extensions);
    }

    if (query.tags && query.tags.length > 0) {
      filters.push(`r.tags && $${paramIndex++}::text[]`);
      params.push(query.tags);
    }

    if (query.minUptimeRatio !== undefined) {
      filters.push(`(t.uptime_ratio IS NULL OR t.uptime_ratio >= $${paramIndex++})`);
      params.push(query.minUptimeRatio);
    }

    const filterClause = filters.length > 0 ? `AND ${filters.join(" AND ")}` : "";

    // Hybrid RRF Query with Composite Telemetry Ranking
    const searchQuery = `
      WITH vector_search AS (
          SELECT id,
                 RANK() OVER (ORDER BY embedding <=> $2::vector) AS rank,
                 (1 - (embedding <=> $2::vector)) AS vec_score
          FROM catalog_resources
          WHERE embedding IS NOT NULL
          ORDER BY embedding <=> $2::vector
          LIMIT ${CANDIDATE_POOL_SIZE}
      ),
      text_search AS (
          SELECT id,
                 RANK() OVER (ORDER BY ts_rank_cd(
                   to_tsvector('english', description || ' ' || COALESCE(service_name, '')),
                   plainto_tsquery('english', $1)
                 ) DESC) AS rank,
                 ts_rank_cd(
                   to_tsvector('english', description || ' ' || COALESCE(service_name, '')),
                   plainto_tsquery('english', $1)
                 ) AS text_score
          FROM catalog_resources
          WHERE to_tsvector('english', description || ' ' || COALESCE(service_name, ''))
                @@ plainto_tsquery('english', $1)
          LIMIT ${CANDIDATE_POOL_SIZE}
      )
      SELECT
          r.id,
          r.resource_url,
          r.resource_type,
          r.tool_name,
          r.service_name,
          r.description,
          r.mime_type,
          r.pay_to,
          r.network,
          r.scheme,
          r.tags,
          r.icon_url,
          r.route_template,
          r.input_spec,
          r.output_spec,
          r.extensions,
          r.created_at,
          r.updated_at,
          -- Telemetry metrics
          t.node_id,
          t.last_heartbeat_at,
          t.avg_response_time_ms,
          t.uptime_ratio,
          t.settlement_count,
          t.failed_settlement_count,
          t.liveness_status,
          -- Individual ranking components
          COALESCE(v.vec_score, 0.0) AS vector_score,
          LEAST(1.0, COALESCE(k.text_score, 0.0)) AS bm25_score,
          COALESCE(t.uptime_ratio, 0.5) AS uptime_score,
          EXP(-COALESCE(t.avg_response_time_ms, 1000.0) / 500.0) AS latency_score,
          LEAST(1.0, LN(COALESCE(t.settlement_count, 0) + 1) / 3.0) AS reliability_score,
          -- Composite Quality Score (Φ)
          (
            ${this.weights.vector} * COALESCE(v.vec_score, 0.0) +
            ${this.weights.bm25} * LEAST(1.0, COALESCE(k.text_score, 0.0)) +
            ${this.weights.uptime} * COALESCE(t.uptime_ratio, 0.5) +
            ${this.weights.latency} * EXP(-COALESCE(t.avg_response_time_ms, 1000.0) / 500.0) +
            ${this.weights.reliability} * LEAST(1.0, LN(COALESCE(t.settlement_count, 0) + 1) / 3.0)
          ) * CASE COALESCE(t.liveness_status, 'HEALTHY')
                WHEN 'HEALTHY' THEN 1.0
                WHEN 'DEGRADED' THEN 0.3
                ELSE 0.0
              END AS composite_score,
          -- Count total matches for pagination, and how full each candidate
          -- pool was, so partialResults can be answered honestly.
          COUNT(*) OVER() AS total_count,
          (SELECT COUNT(*) FROM vector_search) AS vector_candidates,
          (SELECT COUNT(*) FROM text_search) AS text_candidates
      FROM catalog_resources r
      LEFT JOIN vector_search v ON r.id = v.id
      LEFT JOIN text_search k ON r.id = k.id
      LEFT JOIN resource_telemetry t ON r.id = t.resource_id
      WHERE (v.id IS NOT NULL OR k.id IS NOT NULL)
        AND r.soft_dropped = false
        AND COALESCE(t.liveness_status, 'HEALTHY') <> 'OFFLINE'
        ${filterClause}
      ORDER BY composite_score DESC
      LIMIT $3 OFFSET $4
    `;

    const result = await this.pool.query(searchQuery, params);

    const results: SearchResult[] = result.rows.map(row => ({
      id: row.id,
      resourceUrl: row.resource_url,
      resourceType: row.resource_type,
      toolName: row.tool_name,
      serviceName: row.service_name,
      description: row.description,
      mimeType: row.mime_type,
      payTo: row.pay_to,
      network: row.network,
      scheme: row.scheme,
      tags: row.tags || [],
      iconUrl: row.icon_url,
      routeTemplate: row.route_template,
      inputSpec: row.input_spec,
      outputSpec: row.output_spec,
      extensions: row.extensions || {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      compositeScore: parseFloat(row.composite_score),
      vectorScore: parseFloat(row.vector_score),
      bm25Score: parseFloat(row.bm25_score),
      uptimeScore: parseFloat(row.uptime_score),
      latencyScore: parseFloat(row.latency_score),
      reliabilityScore: parseFloat(row.reliability_score),
      telemetry: row.node_id ? {
        resourceId: row.id,
        nodeId: row.node_id,
        lastHeartbeatAt: row.last_heartbeat_at,
        heartbeatSequence: 0, // Not queried
        avgResponseTimeMs: parseFloat(row.avg_response_time_ms),
        uptimeRatio: parseFloat(row.uptime_ratio),
        settlementCount: parseInt(row.settlement_count),
        failedSettlementCount: parseInt(row.failed_settlement_count),
        livenessStatus: row.liveness_status,
        updatedAt: row.updated_at,
      } : undefined,
    }));

    const total = result.rows.length > 0 ? parseInt(result.rows[0].total_count) : 0;

    // A saturated candidate pool means fusion ranked a truncated view of the
    // matches, so this page is not a complete answer to the query.
    const vectorCandidates = result.rows.length > 0 ? parseInt(result.rows[0].vector_candidates) : 0;
    const textCandidates = result.rows.length > 0 ? parseInt(result.rows[0].text_candidates) : 0;
    const poolSaturated =
      vectorCandidates >= CANDIDATE_POOL_SIZE || textCandidates >= CANDIDATE_POOL_SIZE;

    const hasMore = offset + results.length < total;

    return {
      results,
      total,
      limit,
      offset,
      nextCursor: hasMore
        ? encodeCursor({ offset: offset + results.length, limit, fingerprint: queryFingerprint })
        : undefined,
      partialResults: poolSaturated,
      partialReason: poolSaturated
        ? `More than ${CANDIDATE_POOL_SIZE} candidates matched in at least one retrieval leg, so ranking considered a truncated set. Narrow the query or apply filters for a complete ordering.`
        : undefined,
    };
  }

  /**
   * List all resources with optional filters (no query ranking applied)
   */
  async list(filters: ResourceFilters = { limit: 20, offset: 0 }): Promise<SearchResponse> {
    const limit = filters.limit ?? 20;

    // Same cursor contract as search: a token is only valid for the filter set
    // that issued it.
    const listFingerprint = fingerprint({
      resourceType: filters.resourceType,
      payTo: filters.payTo,
      network: filters.network,
      extensions: filters.extensions,
      scheme: filters.scheme,
      tags: filters.tags,
    });

    const offset = filters.cursor
      ? decodeCursor(filters.cursor, listFingerprint).offset
      : (filters.offset ?? 0);

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (filters.resourceType) {
      conditions.push(`r.resource_type = $${paramIndex++}`);
      params.push(filters.resourceType);
    }

    if (filters.network) {
      conditions.push(`r.network = $${paramIndex++}`);
      params.push(filters.network);
    }

    if (filters.scheme) {
      conditions.push(`r.scheme = $${paramIndex++}`);
      params.push(filters.scheme);
    }

    if (filters.payTo) {
      conditions.push(`r.pay_to = $${paramIndex++}`);
      params.push(filters.payTo);
    }

    if (filters.extensions && filters.extensions.length > 0) {
      // JSONB "has all these top-level keys".
      conditions.push(`r.extensions ?& $${paramIndex++}::text[]`);
      params.push(filters.extensions);
    }

    if (filters.tags && filters.tags.length > 0) {
      conditions.push(`r.tags && $${paramIndex++}::text[]`);
      params.push(filters.tags);
    }

    params.push(limit, offset);

    conditions.push("r.soft_dropped = false");
    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    const query = `
      SELECT
          r.id,
          r.resource_url,
          r.resource_type,
          r.tool_name,
          r.service_name,
          r.description,
          r.mime_type,
          r.pay_to,
          r.network,
          r.scheme,
          r.tags,
          r.icon_url,
          r.route_template,
          r.input_spec,
          r.output_spec,
          r.extensions,
          r.created_at,
          r.updated_at,
          COUNT(*) OVER() AS total_count
      FROM catalog_resources r
      ${whereClause}
      ORDER BY r.created_at DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;

    const result = await this.pool.query(query, params);

    const results: SearchResult[] = result.rows.map(row => ({
      id: row.id,
      resourceUrl: row.resource_url,
      resourceType: row.resource_type,
      toolName: row.tool_name,
      serviceName: row.service_name,
      description: row.description,
      mimeType: row.mime_type,
      payTo: row.pay_to,
      network: row.network,
      scheme: row.scheme,
      tags: row.tags || [],
      iconUrl: row.icon_url,
      routeTemplate: row.route_template,
      inputSpec: row.input_spec,
      outputSpec: row.output_spec,
      extensions: row.extensions || {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      compositeScore: 1.0, // Listing applies no ranking
    }));

    const total = result.rows.length > 0 ? parseInt(result.rows[0].total_count) : 0;
    const hasMore = offset + results.length < total;

    return {
      results,
      total,
      limit,
      offset,
      nextCursor: hasMore
        ? encodeCursor({ offset: offset + results.length, limit, fingerprint: listFingerprint })
        : undefined,
      // Listing filters and pages over the whole catalog with no candidate
      // truncation, so a page is always a complete view of its slice.
      partialResults: false,
    };
  }

  /**
   * Close database connection pool
   */
  async close(): Promise<void> {
    await this.pool.end();
  }
}

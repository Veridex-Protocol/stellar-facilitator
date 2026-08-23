/**
 * Veridex Bazaar Discovery Engine - Search Types
 * License: Apache-2.0
 */

import { z } from "zod";

/**
 * Resource catalog entry
 */
export const CatalogResourceSchema = z.object({
  id: z.string().uuid(),
  resourceUrl: z.string().url(),
  resourceType: z.enum(["http", "mcp"]),
  toolName: z.string().max(64).optional(),
  serviceName: z.string().max(32).optional(),
  description: z.string(),
  mimeType: z.string().max(64).default("application/json"),
  payTo: z.string().length(56), // Stellar G-address
  network: z.string(), // e.g. stellar:pubnet
  scheme: z.string(), // e.g. exact, upto
  tags: z.array(z.string()).default([]),
  iconUrl: z.string().max(2048).optional(),
  routeTemplate: z.string().optional(),
  inputSpec: z.record(z.any()),
  outputSpec: z.record(z.any()).optional(),
  extensions: z.record(z.any()).default({}),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type CatalogResource = z.infer<typeof CatalogResourceSchema>;

/**
 * Telemetry metrics for a resource node
 */
export const ResourceTelemetrySchema = z.object({
  resourceId: z.string().uuid(),
  nodeId: z.string(),
  lastHeartbeatAt: z.date(),
  heartbeatSequence: z.number().int(),
  avgResponseTimeMs: z.number(),
  uptimeRatio: z.number().min(0).max(1),
  settlementCount: z.number().int(),
  failedSettlementCount: z.number().int(),
  livenessStatus: z.enum(["HEALTHY", "DEGRADED", "OFFLINE"]),
  updatedAt: z.date(),
});

export type ResourceTelemetry = z.infer<typeof ResourceTelemetrySchema>;

/**
 * Search query parameters
 */
export const SearchQuerySchema = z.object({
  query: z.string().min(1),
  resourceType: z.enum(["http", "mcp"]).optional(),
  network: z.string().optional(),
  scheme: z.string().optional(),
  /** Filter to resources paying this Stellar address. */
  payTo: z.string().optional(),
  /** Filter to resources declaring all of these extensions. */
  extensions: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  minUptimeRatio: z.number().min(0).max(1).default(0.9),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
  /** Opaque continuation token from a previous response. Supersedes `offset`. */
  cursor: z.string().optional(),
});

export type SearchQuery = z.infer<typeof SearchQuerySchema>;

/**
 * Search result with composite quality score
 */
export const SearchResultSchema = CatalogResourceSchema.extend({
  compositeScore: z.number(),
  rrfScore: z.number().optional(),
  vectorScore: z.number().optional(),
  textScore: z.number().optional(),
  bm25Score: z.number().optional(),
  uptimeScore: z.number().optional(),
  latencyScore: z.number().optional(),
  reliabilityScore: z.number().optional(),
  telemetry: ResourceTelemetrySchema.optional(),
});

export type SearchResult = z.infer<typeof SearchResultSchema>;

/**
 * Paginated search response
 */
export const SearchResponseSchema = z.object({
  results: z.array(SearchResultSchema),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
  /**
   * Opaque token for the next page, absent on the last page. Clients page by
   * echoing this back as `cursor` rather than computing an offset.
   */
  nextCursor: z.string().optional(),
  /**
   * True when this response is not a complete view of what matched: the
   * candidate pool was truncated before ranking, or a leg of the hybrid search
   * was unavailable and the query fell back. Never defaulted to false blindly.
   */
  partialResults: z.boolean().default(false),
  /** Why `partialResults` is set, when it is. */
  partialReason: z.string().optional(),
});

export type SearchResponse = z.infer<typeof SearchResponseSchema>;

/**
 * Filters for `GET /discovery/resources`.
 *
 * `type`, `payTo`, `network`, `extensions`, `limit` and `offset` are the filters
 * the x402 discovery spec names; `scheme` and `tags` are supported extras.
 */
export const ResourceFiltersSchema = z.object({
  resourceType: z.enum(["http", "mcp"]).optional(),
  payTo: z.string().optional(),
  network: z.string().optional(),
  extensions: z.array(z.string()).optional(),
  scheme: z.string().optional(),
  tags: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
  cursor: z.string().optional(),
});

export type ResourceFilters = z.infer<typeof ResourceFiltersSchema>;

/**
 * Composite ranking weights for Reciprocal Rank Fusion (RRF) & Telemetry
 */
export interface RankingWeights {
  vector: number;      // Feature-hash vector RRF weight (default: 1.0)
  text: number;        // Text cover-density RRF weight (default: 1.0)
  bm25?: number;       // Backward-compat alias for text weight
  uptime: number;      // Node uptime modulation weight (default: 0.15)
  latency: number;     // Response latency modulation weight (default: 0.15)
  reliability: number; // Settlement success modulation weight (default: 0.10)
  rrfK?: number;       // RRF smoothing constant k (default: 60)
}

export const DEFAULT_RANKING_WEIGHTS: RankingWeights = {
  vector: 1.0,
  text: 1.0,
  bm25: 1.0,
  uptime: 0.15,
  latency: 0.15,
  reliability: 0.10,
  rrfK: 60,
};

/**
 * Database connection configuration
 */
export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl?: boolean;
  maxConnections?: number;
}

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
  tags: z.array(z.string()).optional(),
  minUptimeRatio: z.number().min(0).max(1).default(0.9),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
});

export type SearchQuery = z.infer<typeof SearchQuerySchema>;

/**
 * Search result with composite quality score
 */
export const SearchResultSchema = CatalogResourceSchema.extend({
  compositeScore: z.number(),
  semanticScore: z.number().optional(),
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
  partialResults: z.boolean().default(false),
});

export type SearchResponse = z.infer<typeof SearchResponseSchema>;

/**
 * Composite ranking weights
 */
export interface RankingWeights {
  semantic: number;    // Vector similarity weight (default: 0.35)
  bm25: number;        // Keyword match weight (default: 0.25)
  uptime: number;      // Node uptime weight (default: 0.15)
  latency: number;     // Response latency weight (default: 0.15)
  reliability: number; // Settlement success weight (default: 0.10)
}

export const DEFAULT_RANKING_WEIGHTS: RankingWeights = {
  semantic: 0.35,
  bm25: 0.25,
  uptime: 0.15,
  latency: 0.15,
  reliability: 0.10,
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

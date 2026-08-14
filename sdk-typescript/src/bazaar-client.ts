/**
 * Veridex TypeScript SDK - Bazaar Client
 * License: Apache-2.0
 *
 * Client for Veridex Bazaar discovery service.
 */

import type { BazaarResource, BazaarSearchResponse } from "./types.js";

/**
 * Bazaar Client Configuration
 */
export interface BazaarClientConfig {
  /** Bazaar service URL */
  bazaarUrl: string;

  /** Default network filter */
  defaultNetwork?: string;

  /** Request timeout (ms) */
  timeout?: number;
}

/**
 * Search parameters
 */
export interface SearchParams {
  /** Search query */
  query: string;

  /** Network filter */
  network?: string;

  /** Minimum uptime ratio (0.0-1.0) */
  minUptimeRatio?: number;

  /** Maximum results */
  limit?: number;

  /** Offset for pagination */
  offset?: number;
}

/**
 * Bazaar Client
 *
 * Discover and search x402 resources in the Veridex Bazaar catalog.
 */
export class BazaarClient {
  private config: Required<BazaarClientConfig>;

  constructor(config: BazaarClientConfig) {
    this.config = {
      bazaarUrl: config.bazaarUrl,
      defaultNetwork: config.defaultNetwork || "stellar:pubnet",
      timeout: config.timeout || 30000,
    };
  }

  /**
   * Search resources with semantic + keyword hybrid search
   *
   * @param params - Search parameters
   * @returns Search results
   */
  async search(params: SearchParams): Promise<BazaarSearchResponse> {
    const url = new URL("/discovery/search", this.config.bazaarUrl);
    url.searchParams.set("q", params.query);
    url.searchParams.set("network", params.network || this.config.defaultNetwork);

    if (params.minUptimeRatio !== undefined) {
      url.searchParams.set("minUptimeRatio", params.minUptimeRatio.toString());
    }

    if (params.limit !== undefined) {
      url.searchParams.set("limit", params.limit.toString());
    }

    if (params.offset !== undefined) {
      url.searchParams.set("offset", params.offset.toString());
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = (await response.json().catch(() => ({}))) as Record<string, any>;
        throw new Error(error.error || `Bazaar search failed: ${response.statusText}`);
      }

      return (await response.json()) as BazaarSearchResponse;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * List all resources with optional filters
   *
   * @param filters - Filter parameters
   * @returns Resources list
   */
  async list(filters?: {
    network?: string;
    limit?: number;
    offset?: number;
  }): Promise<BazaarSearchResponse> {
    const url = new URL("/discovery/resources", this.config.bazaarUrl);

    if (filters?.network) {
      url.searchParams.set("network", filters.network);
    }

    if (filters?.limit !== undefined) {
      url.searchParams.set("limit", filters.limit.toString());
    }

    if (filters?.offset !== undefined) {
      url.searchParams.set("offset", filters.offset.toString());
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = (await response.json().catch(() => ({}))) as Record<string, any>;
        throw new Error(error.error || `Bazaar list failed: ${response.statusText}`);
      }

      return (await response.json()) as BazaarSearchResponse;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Get service health status
   *
   * @returns Health status
   */
  async health(): Promise<{
    status: string;
    timestamp: number;
    database: any;
    p2p: any;
  }> {
    const url = new URL("/health", this.config.bazaarUrl);

    const response = await fetch(url.toString());

    if (!response.ok) {
      throw new Error(`Health check failed: ${response.statusText}`);
    }

    return (await response.json()) as any;
  }

  /**
   * Get service statistics
   *
   * @returns Service stats
   */
  async stats(): Promise<{
    p2p: any;
    telemetry: any;
    timestamp: number;
  }> {
    const url = new URL("/stats", this.config.bazaarUrl);

    const response = await fetch(url.toString());

    if (!response.ok) {
      throw new Error(`Stats request failed: ${response.statusText}`);
    }

    return (await response.json()) as any;
  }
}

/**
 * Create Bazaar client
 */
export function createBazaarClient(config: BazaarClientConfig): BazaarClient {
  return new BazaarClient(config);
}

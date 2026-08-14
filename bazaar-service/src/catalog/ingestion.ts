/**
 * Veridex Bazaar Discovery Engine - Auto-Cataloging Ingestion Worker
 * License: Apache-2.0
 *
 * Automatically indexes resources during x402 payment settlement:
 * - Parses Bazaar extension from PaymentPayload
 * - Validates metadata against soft-drop rules
 * - Generates vector embeddings
 * - Stores in PostgreSQL catalog
 * - Returns EXTENSION-RESPONSES header
 */

import pkg from "pg";
const { Pool } = pkg;
import type { Pool as PoolType } from "pg";
import { z } from "zod";
import { isIP } from "node:net";
import { generateResourceEmbedding } from "../search/embeddings.js";
import type { DatabaseConfig } from "../search/types.js";

/**
 * Bazaar extension schema from PaymentPayload
 */
const BazaarExtensionSchema = z.object({
  serviceName: z.string().max(32).optional(),
  description: z.string(),
  tags: z.array(z.string().max(32)).max(5).optional(),
  iconUrl: z.string().url().max(2048).optional(),
  routeTemplate: z.string().optional(),
  mimeType: z.string().max(64).optional().default("application/json"),
  inputSpec: z.record(z.any()),
  outputSpec: z.record(z.any()).optional(),
});

export type BazaarExtension = z.infer<typeof BazaarExtensionSchema>;

/**
 * Resource ingestion request
 */
export interface IngestionRequest {
  resourceUrl: string;
  resourceType: "http" | "mcp";
  toolName?: string;
  payTo: string;
  network: string;
  scheme: string;
  bazaarExtension: BazaarExtension;
  extensions?: Record<string, any>;
  settlementSucceeded?: boolean;
}

/**
 * Ingestion result
 */
export interface IngestionResult {
  status: "success" | "rejected";
  resourceId?: string;
  rejectedReason?: string;
  extensionResponse: string; // Base64-encoded for EXTENSION-RESPONSES header
}

/**
 * Auto-cataloging ingestion worker
 */
export class CatalogIngestionWorker {
  private pool: PoolType;

  constructor(config: DatabaseConfig) {
    this.pool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
      max: config.maxConnections || 20,
    });
  }

  /**
   * Ingest a resource into the catalog
   */
  async ingest(request: IngestionRequest): Promise<IngestionResult> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");

      // Validate Bazaar extension
      const validationResult = this.validateExtension(request.bazaarExtension);
      if (!validationResult.valid) {
        await client.query("ROLLBACK");
        return {
          status: "rejected",
          rejectedReason: validationResult.reason,
          extensionResponse: this.encodeExtensionResponse("rejected", validationResult.reason),
        };
      }

      // Generate vector embedding
      const embedding = await generateResourceEmbedding(
        request.bazaarExtension.description,
        request.bazaarExtension.serviceName,
        request.bazaarExtension.tags
      );

      // Insert or update catalog entry
      const result = await client.query(
        `INSERT INTO catalog_resources (
          resource_url, resource_type, tool_name, service_name, description,
          mime_type, pay_to, network, scheme, tags, icon_url, route_template,
          input_spec, output_spec, extensions, embedding
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        ON CONFLICT ON CONSTRAINT unique_resource_tool_entry
        DO UPDATE SET
          service_name = EXCLUDED.service_name,
          description = EXCLUDED.description,
          mime_type = EXCLUDED.mime_type,
          tags = EXCLUDED.tags,
          icon_url = EXCLUDED.icon_url,
          route_template = EXCLUDED.route_template,
          input_spec = EXCLUDED.input_spec,
          output_spec = EXCLUDED.output_spec,
          extensions = EXCLUDED.extensions,
          embedding = EXCLUDED.embedding,
          updated_at = NOW()
        RETURNING id`,
        [
          request.resourceUrl,
          request.resourceType,
          request.toolName || null,
          request.bazaarExtension.serviceName || null,
          request.bazaarExtension.description,
          request.bazaarExtension.mimeType || "application/json",
          request.payTo,
          request.network,
          request.scheme,
          request.bazaarExtension.tags || [],
          request.bazaarExtension.iconUrl || null,
          request.bazaarExtension.routeTemplate || null,
          JSON.stringify(request.bazaarExtension.inputSpec),
          request.bazaarExtension.outputSpec ? JSON.stringify(request.bazaarExtension.outputSpec) : null,
          request.extensions ? JSON.stringify(request.extensions) : "{}",
          `[${embedding.join(",")}]`,
        ]
      );

      const resourceId = result.rows[0].id;

      if (request.settlementSucceeded) {
        await client.query(
          `INSERT INTO resource_telemetry (resource_id, settlement_count)
           VALUES ($1, 1)
           ON CONFLICT (resource_id) DO UPDATE SET
             settlement_count = resource_telemetry.settlement_count + 1,
             updated_at = now()`,
          [resourceId]
        );
      }

      await client.query("COMMIT");

      console.log(`[Catalog Ingestion] Successfully indexed resource: ${request.resourceUrl}`);

      return {
        status: "success",
        resourceId,
        extensionResponse: this.encodeExtensionResponse("success"),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("[Catalog Ingestion] Error ingesting resource:", error);

      return {
        status: "rejected",
        rejectedReason: error instanceof Error ? error.message : "internal_error",
        extensionResponse: this.encodeExtensionResponse("rejected", "internal_error"),
      };
    } finally {
      client.release();
    }
  }

  /**
   * Validate Bazaar extension metadata (soft-drop rules)
   */
  private validateExtension(extension: BazaarExtension): { valid: boolean; reason?: string } {
    // Validate serviceName (printable ASCII, max 32 chars)
    if (extension.serviceName) {
      if (!/^[\x20-\x7e]+$/.test(extension.serviceName)) {
        return { valid: false, reason: "serviceName contains non-printable characters" };
      }
      if (extension.serviceName.length > 32) {
        return { valid: false, reason: "serviceName exceeds 32 characters" };
      }
    }

    // Validate tags (printable ASCII, max 32 chars each, max 5 tags)
    if (extension.tags) {
      if (extension.tags.length > 5) {
        return { valid: false, reason: "too many tags (max 5)" };
      }
      for (const tag of extension.tags) {
        if (!/^[\x20-\x7e]+$/.test(tag)) {
          return { valid: false, reason: "tag contains non-printable characters" };
        }
        if (tag.length > 32) {
          return { valid: false, reason: "tag exceeds 32 characters" };
        }
      }
    }

    // Validate iconUrl (no IP literals, localhost, decimal/hex IPs)
    if (extension.iconUrl) {
      const url = new URL(extension.iconUrl);

      if (url.protocol !== "https:" && url.protocol !== "http:") {
        return { valid: false, reason: "iconUrl must use http or https" };
      }

      // Reject IP literals
      if (isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0) {
        return { valid: false, reason: "iconUrl contains IP literal" };
      }

      // Reject localhost and loopback
      if (
        ["localhost", "ip6-loopback"].includes(url.hostname.toLowerCase()) ||
        url.hostname.toLowerCase().endsWith(".localhost")
      ) {
        return { valid: false, reason: "iconUrl targets localhost/loopback" };
      }

      // Reject decimal/hex encoded IPs (e.g., 0x7f000001)
      if (/^(0x[0-9a-f]+|\d+)$/i.test(url.hostname)) {
        return { valid: false, reason: "iconUrl contains encoded IP address" };
      }
    }

    // Validate routeTemplate (no path traversal, no scheme injection)
    if (extension.routeTemplate) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(extension.routeTemplate);
      } catch {
        return { valid: false, reason: "routeTemplate contains invalid URL encoding" };
      }

      if (decoded.includes("..")) {
        return { valid: false, reason: "routeTemplate contains path traversal (..)" };
      }

      if (decoded.includes("://")) {
        return { valid: false, reason: "routeTemplate contains URL scheme injection (://)" };
      }
    }

    return { valid: true };
  }

  /**
   * Encode EXTENSION-RESPONSES header (base64)
   */
  private encodeExtensionResponse(status: "success" | "rejected", reason?: string): string {
    const response = {
      bazaar: {
        status,
        ...(reason && { rejectedReason: reason }),
      },
    };

    return Buffer.from(JSON.stringify(response)).toString("base64");
  }

  /**
   * Close database connection pool
   */
  async close(): Promise<void> {
    await this.pool.end();
  }
}

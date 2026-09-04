/**
 * Veridex Bazaar Discovery Engine - Auto-Cataloging Ingestion Worker
 * License: Apache-2.0
 *
 * Automatically indexes resources during x402 payment settlement:
 * - Parses Bazaar extension from PaymentPayload
 * - Validates metadata against soft-drop rules and cryptographic owner signatures
 * - Enforces resource ownership invariants (prevents metadata hijack attacks)
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
import { verifySettlement, type SettlementProofOptions } from "./settlement-proof.js";
import { verifyOwnerSignature } from "./owner-signature.js";
import type { DatabaseConfig } from "../search/types.js";
import {
  catalogDeltaDigest,
  catalogDeltaKey,
  compareCatalogDelta,
  verifyCatalogDelta,
  type CatalogDelta,
} from "../p2p/catalog-delta.js";

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
  ownerSignature: z.string().optional(),
  ownerPublicKey: z.string().optional(),
  signatureTimestamp: z.number().optional(),
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
  /**
   * Hash of the settlement that backs this entry. Required: the catalog
   * confirms it on Horizon rather than trusting the caller that a payment
   * happened. See settlement-proof.ts.
   */
  settlementTx: string;
  settlementProof?: Pick<SettlementProofOptions, "scheme" | "uptoContractId" | "expectedToken" | "expectedMaxAmount" | "expectedActual" | "expectedResultDigest">;
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
  private horizonUrl: string;
  private sorobanRpcUrl: string;

  constructor(config: DatabaseConfig, options: { horizonUrl: string; sorobanRpcUrl: string }) {
    this.horizonUrl = options.horizonUrl;
    this.sorobanRpcUrl = options.sorobanRpcUrl;
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

      // 1. Validate Bazaar extension and cryptographic owner signature if provided
      const validationResult = this.validateExtension(request.bazaarExtension, request);
      if (!validationResult.valid) {
        await client.query("ROLLBACK");
        return {
          status: "rejected",
          rejectedReason: validationResult.reason,
          extensionResponse: this.encodeExtensionResponse("rejected", validationResult.reason),
        };
      }

      // 2. Confirm a real settlement backs this entry on Horizon.
      const settlement = await verifySettlement(request.settlementTx, request.payTo, {
        horizonUrl: this.horizonUrl,
        sorobanRpcUrl: this.sorobanRpcUrl,
        ...request.settlementProof,
      });
      if (!settlement.valid) {
        await client.query("ROLLBACK");
        const reason = settlement.reason ?? "settlement could not be confirmed";
        console.warn(`[Catalog Ingestion] Rejected ${request.resourceUrl}: ${reason}`);
        return {
          status: "rejected",
          rejectedReason: reason,
          extensionResponse: this.encodeExtensionResponse("rejected", reason),
        };
      }

      // 3. Security invariant (VDX-02 Anti-Hijack Guard):
      // An incoming settlement for payTo B must NEVER overwrite an existing catalog
      // entry previously registered to payTo A.
      const existing = await client.query(
        `SELECT id, pay_to FROM catalog_resources
         WHERE resource_url = $1 AND tool_name_key = COALESCE($2, '')`,
        [request.resourceUrl, request.toolName || ""]
      );

      if (existing.rows.length > 0) {
        const existingPayTo = existing.rows[0].pay_to;
        if (existingPayTo !== request.payTo) {
          await client.query("ROLLBACK");
          const reason = `metadata_hijack_detected: resource '${request.resourceUrl}' is already registered to payTo ${existingPayTo}; incoming settlement credited different payTo ${request.payTo}`;
          console.warn(`[Catalog Ingestion] Hijack attempt blocked for ${request.resourceUrl}: ${reason}`);
          return {
            status: "rejected",
            rejectedReason: reason,
            extensionResponse: this.encodeExtensionResponse("rejected", reason),
          };
        }
      }

      // 4. Generate vector embedding
      const embedding = await generateResourceEmbedding(
        request.bazaarExtension.description,
        request.bazaarExtension.serviceName,
        request.bazaarExtension.tags
      );

      // 5. Insert or update catalog entry with strict pay_to constraint
      const result = await client.query(
        `INSERT INTO catalog_resources (
          resource_url, resource_type, tool_name, service_name, description,
          mime_type, pay_to, network, scheme, tags, icon_url, route_template,
          input_spec, output_spec, extensions, embedding, settlement_tx
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
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
          settlement_tx = EXCLUDED.settlement_tx,
          last_seen = NOW(),
          updated_at = NOW()
        WHERE catalog_resources.pay_to = EXCLUDED.pay_to
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
          request.settlementTx,
        ]
      );

      if (!result.rows[0]) {
        await client.query("ROLLBACK");
        const reason = "metadata_hijack_detected: resource update rejected because existing pay_to does not match";
        return {
          status: "rejected",
          rejectedReason: reason,
          extensionResponse: this.encodeExtensionResponse("rejected", reason),
        };
      }

      const resourceId = result.rows[0].id;

      // 6. Update telemetry liveness
      await client.query(
        `INSERT INTO resource_telemetry (resource_id, settlement_count, last_settlement_at, liveness_status)
         VALUES ($1, 1, now(), 'HEALTHY')
         ON CONFLICT (resource_id) DO UPDATE SET
           settlement_count = resource_telemetry.settlement_count + 1,
           last_settlement_at = now(),
           liveness_status = 'HEALTHY',
           updated_at = now()`,
        [resourceId]
      );

      await client.query("COMMIT");

      console.log(`[Catalog Ingestion] Successfully indexed resource: ${request.resourceUrl}`);

      return {
        status: "success",
        resourceId,
        extensionResponse: this.encodeExtensionResponse("success"),
      };
    } catch (error: any) {
      await client.query("ROLLBACK");

      // One settlement binds one catalog entry. Reusing a valid payment to
      // list a second resource trips the unique index, and that is a rejection
      // with a reason rather than an internal error.
      if (error?.code === "23505" && String(error?.constraint).includes("settlement_tx")) {
        const reason = "settlementTx has already been used to list a different resource";
        console.warn(`[Catalog Ingestion] Rejected ${request.resourceUrl}: ${reason}`);
        return {
          status: "rejected",
          rejectedReason: reason,
          extensionResponse: this.encodeExtensionResponse("rejected", reason),
        };
      }

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
   * Applies a signed catalog snapshot after deterministic revision arbitration.
   * Upserts retain the existing Horizon settlement proof; revokes retain a
   * tombstone and soft-drop the matching listing without deleting history.
   */
  async applyCatalogDelta(
    delta: CatalogDelta,
    options: { authorizedSigners?: string[]; nowSeconds?: number } = {},
  ): Promise<{ status: "applied" | "ignored" | "rejected"; reason?: string }> {
    const verification = verifyCatalogDelta(delta, {
      authorizedSigners: options.authorizedSigners,
      nowSeconds: options.nowSeconds,
    });
    if (!verification.valid) return { status: "rejected", reason: verification.error };

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const key = catalogDeltaKey(delta);
      const currentResult = await client.query<{
        revision: number;
        digest: string;
        payload: CatalogDelta;
      }>(
        `SELECT revision, digest, payload FROM catalog_delta_state WHERE catalog_key = $1 FOR UPDATE`,
        [key],
      );
      const current = currentResult.rows[0];
      if (current && compareCatalogDelta(delta, current.payload) <= 0) {
        await client.query("COMMIT");
        return { status: "ignored", reason: "catalog delta is older than or equal to durable state" };
      }

      if (delta.op === "upsert") {
        const state = delta.state;
        if (!state) {
          await client.query("ROLLBACK");
          return { status: "rejected", reason: "upsert catalog delta has no state" };
        }
        const settlement = await verifySettlement(state.settlementTx, delta.payTo, {
          horizonUrl: this.horizonUrl,
          sorobanRpcUrl: this.sorobanRpcUrl,
          scheme: state.scheme,
          uptoContractId: state.uptoContractId,
          expectedToken: state.settlementToken,
          expectedMaxAmount: state.settlementMaxAmount,
          expectedActual: state.settlementActual,
          expectedResultDigest: state.settlementResultDigest,
        });
        if (!settlement.valid) {
          await client.query("ROLLBACK");
          return { status: "rejected", reason: settlement.reason };
        }

        const existing = await client.query<{ id: string; pay_to: string }>(
          `SELECT id, pay_to FROM catalog_resources
           WHERE resource_url = $1 AND tool_name_key = $2 FOR UPDATE`,
          [delta.resourceUrl, delta.toolName || ""],
        );
        if (existing.rows[0] && existing.rows[0].pay_to !== delta.payTo) {
          await client.query("ROLLBACK");
          return { status: "rejected", reason: "catalog delta would change an existing resource payTo" };
        }

        const embedding = await generateResourceEmbedding(state.description, state.serviceName, state.tags);
        await client.query(
          `INSERT INTO catalog_resources (
             resource_url, resource_type, tool_name, service_name, description,
             mime_type, pay_to, network, scheme, tags, icon_url, route_template,
             input_spec, output_spec, extensions, embedding, settlement_tx, soft_dropped
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                     $13, $14, $15, $16, $17, false)
           ON CONFLICT ON CONSTRAINT unique_resource_tool_entry DO UPDATE SET
             service_name = EXCLUDED.service_name,
             description = EXCLUDED.description,
             mime_type = EXCLUDED.mime_type,
             pay_to = EXCLUDED.pay_to,
             network = EXCLUDED.network,
             scheme = EXCLUDED.scheme,
             tags = EXCLUDED.tags,
             icon_url = EXCLUDED.icon_url,
             route_template = EXCLUDED.route_template,
             input_spec = EXCLUDED.input_spec,
             output_spec = EXCLUDED.output_spec,
             extensions = EXCLUDED.extensions,
             embedding = EXCLUDED.embedding,
             settlement_tx = EXCLUDED.settlement_tx,
             soft_dropped = false,
             last_seen = now(),
             updated_at = now()
           WHERE catalog_resources.pay_to = EXCLUDED.pay_to`,
          [
            delta.resourceUrl,
            state.resourceType,
            delta.toolName || null,
            state.serviceName || null,
            state.description,
            state.mimeType,
            delta.payTo,
            delta.network,
            state.scheme,
            state.tags || [],
            state.iconUrl || null,
            state.routeTemplate || null,
            JSON.stringify(state.inputSpec),
            state.outputSpec ? JSON.stringify(state.outputSpec) : null,
            JSON.stringify(state.extensions || {}),
            `[${embedding.join(",")}]`,
            state.settlementTx,
          ],
        );
      } else {
        await client.query(
          `UPDATE catalog_resources SET soft_dropped = true, updated_at = now()
           WHERE resource_url = $1 AND tool_name_key = $2 AND pay_to = $3 AND network = $4`,
          [delta.resourceUrl, delta.toolName || "", delta.payTo, delta.network],
        );
      }

      await client.query(
        `INSERT INTO catalog_delta_state (
           catalog_key, network, pay_to, resource_url, tool_name, revision,
           digest, operation, signer, issued_at, expires_at, payload
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, to_timestamp($10), to_timestamp($11), $12::jsonb)
         ON CONFLICT (catalog_key) DO UPDATE SET
           revision = EXCLUDED.revision,
           digest = EXCLUDED.digest,
           operation = EXCLUDED.operation,
           signer = EXCLUDED.signer,
           issued_at = EXCLUDED.issued_at,
           expires_at = EXCLUDED.expires_at,
           payload = EXCLUDED.payload,
           updated_at = now()`,
        [
          key,
          delta.network,
          delta.payTo,
          delta.resourceUrl,
          delta.toolName || "",
          delta.revision,
          catalogDeltaDigest(delta),
          delta.op,
          delta.signer,
          delta.issuedAt,
          delta.expiresAt,
          JSON.stringify(delta),
        ],
      );
      await client.query("COMMIT");
      return { status: "applied" };
    } catch (error) {
      await client.query("ROLLBACK");
      return { status: "rejected", reason: error instanceof Error ? error.message : String(error) };
    } finally {
      client.release();
    }
  }

  /**
   * Validate Bazaar extension metadata (soft-drop rules and owner signatures)
   */
  private validateExtension(
    extension: BazaarExtension,
    context?: IngestionRequest,
  ): { valid: boolean; reason?: string } {
    // 1. Cryptographic owner signature validation (if present)
    if (extension.ownerSignature && context) {
      const sigResult = verifyOwnerSignature(
        extension.ownerSignature,
        context.resourceUrl,
        context.payTo,
        context.toolName,
        extension.signatureTimestamp,
        extension.ownerPublicKey,
      );
      if (!sigResult.valid) {
        return { valid: false, reason: `invalid_owner_signature: ${sigResult.reason}` };
      }
    }

    // 2. Validate serviceName (printable ASCII, max 32 chars)
    if (extension.serviceName) {
      if (!/^[\x20-\x7e]+$/.test(extension.serviceName)) {
        return { valid: false, reason: "serviceName contains non-printable characters" };
      }
      if (extension.serviceName.length > 32) {
        return { valid: false, reason: "serviceName exceeds 32 characters" };
      }
    }

    // 3. Validate tags (printable ASCII, max 32 chars each, max 5 tags)
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

    // 4. Validate iconUrl (no IP literals, localhost, decimal/hex IPs)
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

    // 5. Validate routeTemplate (no path traversal, no scheme injection)
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

    // 6. Validate inputSpec and outputSpec against schema injection (reject external $ref/$id)
    if (extension.inputSpec && typeof extension.inputSpec === "object") {
      const specResult = this.validateJsonSpec(extension.inputSpec);
      if (!specResult.valid) {
        return { valid: false, reason: `inputSpec validation failed: ${specResult.reason}` };
      }
    }

    if (extension.outputSpec && typeof extension.outputSpec === "object") {
      const specResult = this.validateJsonSpec(extension.outputSpec);
      if (!specResult.valid) {
        return { valid: false, reason: `outputSpec validation failed: ${specResult.reason}` };
      }
    }

    return { valid: true };
  }

  /**
   * Validate JSON Schema specifications against injection attacks (e.g., external $ref/$id)
   */
  private validateJsonSpec(spec: unknown, depth = 0): { valid: boolean; reason?: string } {
    if (depth > 16) {
      return { valid: false, reason: "spec exceeds maximum nesting depth of 16" };
    }
    if (spec === null || typeof spec !== "object") {
      return { valid: true };
    }

    if (Array.isArray(spec)) {
      for (const item of spec) {
        const itemResult = this.validateJsonSpec(item, depth + 1);
        if (!itemResult.valid) return itemResult;
      }
      return { valid: true };
    }

    for (const [key, value] of Object.entries(spec as Record<string, unknown>)) {
      // Reject dangerous JSON Schema keywords referencing external/network resources
      if (key === "$ref" || key === "$id" || key === "$schema") {
        if (typeof value === "string") {
          const lower = value.toLowerCase();
          if (
            lower.startsWith("http://") ||
            lower.startsWith("https://") ||
            lower.startsWith("ftp://") ||
            lower.startsWith("//") ||
            lower.startsWith("file://")
          ) {
            return { valid: false, reason: `external URI reference not allowed in ${key}: ${value}` };
          }
        }
      }

      const valResult = this.validateJsonSpec(value, depth + 1);
      if (!valResult.valid) return valResult;
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

#!/usr/bin/env node
/**
 * Veridex MCP Discovery Server
 * License: Apache-2.0
 *
 * Model Context Protocol (MCP) server exposing Veridex Bazaar discovery
 * and x402 payment tools to compatible clients.
 *
 * Tools:
 * - discover_resources - Search the Bazaar catalog (BM25 + feature-hash lexical ranking)
 * - pay_resource - Execute x402 Stellar payment for resource access
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { validateSafeResourceUrl } from "./security.js";

/**
 * MCP Server configuration
 */
export interface MCPServerConfig {
  // Bazaar service URL
  bazaarUrl: string;

  // Facilitator service URL
  facilitatorUrl: string;

  // Stellar configuration
  stellar: {
    network: "pubnet" | "testnet";
    defaultMaxSpendAmount?: string;
  };
}

/**
 * Get configuration from environment
 */
export function getConfig(): MCPServerConfig {
  const network = process.env.STELLAR_NETWORK || "testnet";
  if (network !== "testnet" && network !== "pubnet") {
    throw new Error("STELLAR_NETWORK must be 'testnet' or 'pubnet'");
  }
  return {
    bazaarUrl: process.env.BAZAAR_URL || "http://localhost:3001",
    facilitatorUrl: process.env.FACILITATOR_URL || "http://localhost:3002",
    stellar: {
      network,
      defaultMaxSpendAmount: process.env.MCP_MAX_SPEND_AMOUNT_STROOPS || "10000000",
    },
  };
}

/**
 * Discover resources tool schema
 */
export const DiscoverResourcesSchema = z.object({
  query: z.string().describe("Search query (ranking fuses full-text match, feature-hash vectors, and telemetry via Reciprocal Rank Fusion)"),
  network: z.string().optional().describe("Network filter (e.g., 'stellar:pubnet')"),
  limit: z.number().optional().describe("Maximum results (default: 20)"),
});

/**
 * Pay resource tool schema
 */
export const PayResourceSchema = z.object({
  resourceUrl: z.string().describe("Resource URL to access"),
  method: z.enum(["GET", "POST", "PUT", "DELETE"]).optional().default("GET"),
  params: z.record(z.any()).optional(),
  maxAmount: z.string().optional().describe("Maximum amount allowed in atomic token units"),
  paymentPayload: z.object({
    x402Version: z.number(),
    resource: z.record(z.any()).optional(),
    accepted: z.object({
      scheme: z.string(),
      network: z.string(),
      asset: z.string(),
      amount: z.string().regex(/^(0|[1-9][0-9]*)$/),
      payTo: z.string(),
      maxTimeoutSeconds: z.number(),
      extra: z.record(z.any()),
    }),
    payload: z.record(z.any()),
    extensions: z.record(z.any()).optional(),
  }).optional().describe("Payment payload signed by the client wallet from the challenge returned by phase one"),
});

/**
 * Veridex MCP Discovery Server
 */
export class VeridexMCPServer {
  private server: Server;
  private config: MCPServerConfig;

  constructor(config: MCPServerConfig) {
    this.config = config;

    this.server = new Server(
      {
        name: "veridex-discovery",
        version: "0.1.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  /**
   * Setup MCP request handlers
   */
  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools: Tool[] = [
        {
          name: "discover_resources",
          description:
            "Search the Veridex Bazaar catalog for x402 resources. Ranking fuses full-text cover-density match, feature-hash vector similarity, and live telemetry via Reciprocal Rank Fusion (RRF). " +
            "Returns ranked results with telemetry (uptime, latency, reliability).",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "Search query (e.g., 'weather API', 'translate text')",
              },
              network: {
                type: "string",
                description: "Network filter (default: 'stellar:pubnet')",
              },
              limit: {
                type: "number",
                description: "Maximum results (default: 20)",
              },
            },
            required: ["query"],
          },
        },
        {
          name: "pay_resource",
          description:
            "Prepare or submit an x402 Stellar payment without giving this MCP server a signing key. " +
            "First call returns a bounded challenge; the client wallet signs it and calls again with paymentPayload.",
          inputSchema: {
            type: "object",
            properties: {
              resourceUrl: {
                type: "string",
                description: "Full URL of the resource to access",
              },
              method: {
                type: "string",
                enum: ["GET", "POST", "PUT", "DELETE"],
                description: "HTTP method (default: GET)",
              },
              params: {
                type: "object",
                description: "Request body for non-GET requests or query parameters for GET",
              },
              maxAmount: {
                type: "string",
                description: "Maximum amount allowed in atomic token units",
              },
              paymentPayload: {
                type: "object",
                description: "Externally signed x402 payment payload returned by the client wallet",
              },
            },
            required: ["resourceUrl"],
          },
        },
      ];

      return { tools };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case "discover_resources":
            return await this.handleDiscoverResources(args);

          case "pay_resource":
            return await this.handlePayResource(args);

          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: false,
                code: "mcp_tool_failed",
                reason,
                retryable: false,
              }),
            },
          ],
          isError: true,
        };
      }
    });
  }

  /**
   * Handle discover_resources tool
   */
  async handleDiscoverResources(args: unknown): Promise<any> {
    const params = DiscoverResourcesSchema.parse(args);

    // Query Bazaar service
    const url = new URL("/discovery/search", this.config.bazaarUrl);
    url.searchParams.set("q", params.query);
    if (params.network) {
      url.searchParams.set("network", params.network);
    }
    if (params.limit) {
      url.searchParams.set("limit", params.limit.toString());
    }

    const response = await fetch(url.toString());

    if (!response.ok) {
      throw new Error(`Bazaar search failed: ${response.statusText}`);
    }

    const results = (await response.json()) as Record<string, any>;

    const resources = Array.isArray(results.results)
      ? results.results.map((resource: any) => ({
          resourceUrl: resource.resourceUrl,
          network: resource.network,
          scheme: resource.scheme,
          payTo: resource.payTo,
          score: resource.compositeScore ?? null,
          telemetry: resource.telemetry ?? null,
          sellerData: {
            trust: "untrusted_seller_data",
            serviceName: resource.serviceName ?? null,
            description: resource.description ?? null,
            tags: resource.tags ?? [],
            inputSpec: resource.inputSpec ?? null,
            outputSpec: resource.outputSpec ?? null,
          },
        }))
      : [];

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            total: results.total ?? resources.length,
            resources,
          }),
        },
      ],
    };
  }

  /**
   * Handle pay_resource tool
   */
  async handlePayResource(args: unknown): Promise<any> {
    const params = PayResourceSchema.parse(args);

    // SSRF Validation: validate the resource URL before making any network calls
    const requestUrl = validateSafeResourceUrl(params.resourceUrl);

    const network = this.config.stellar.network === "pubnet" ? "stellar:pubnet" : "stellar:testnet";

    const requestInit: RequestInit = { method: params.method };
    if (params.params) {
      if (params.method === "GET") {
        for (const [key, value] of Object.entries(params.params)) {
          requestUrl.searchParams.set(key, String(value));
        }
      } else {
        requestInit.headers = { "Content-Type": "application/json" };
        requestInit.body = JSON.stringify(params.params);
      }
    }

    const initialResponse = await fetch(requestUrl, requestInit);
    if (initialResponse.status !== 402) {
      const body = await initialResponse.text();
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: initialResponse.ok,
            status: initialResponse.status,
            sellerResponse: {
              trust: "untrusted_seller_data",
              body,
            },
          }),
        }],
      };
    }

    const paymentRequired = readPaymentRequired(initialResponse);

    // Enforce robust spend ceiling: filter accepts down strictly to authorized requirements
    const effectiveMaxAmount = BigInt(
      params.maxAmount || this.config.stellar.defaultMaxSpendAmount || "10000000"
    );

    const qualifiedRequirements = paymentRequired.accepts.filter(
      (requirement) =>
        requirement.network === network &&
        requirement.scheme === "exact" &&
        /^(0|[1-9][0-9]*)$/.test(requirement.amount) &&
        BigInt(requirement.amount) <= effectiveMaxAmount
    );

    if (qualifiedRequirements.length === 0) {
      throw new Error(
        `Payment challenge requirements exceed maximum authorized spend ceiling of ${effectiveMaxAmount} stroops`
      );
    }

    if (!params.paymentPayload) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: false,
            action: "sign_payment",
            retryable: false,
            signingLocation: "client_wallet",
            paymentRequired: {
              ...paymentRequired,
              accepts: qualifiedRequirements,
            },
          }),
        }],
      };
    }

    const paymentPayload = params.paymentPayload as PaymentPayload;
    if (paymentPayload.x402Version !== paymentRequired.x402Version) {
      throw new Error("Externally signed payment payload uses a different x402 version than the current challenge");
    }
    if (paymentPayload.resource?.url && paymentPayload.resource.url !== paymentRequired.resource.url) {
      throw new Error("Externally signed payment payload is bound to a different resource than the current challenge");
    }
    const accepted = qualifiedRequirements.find((requirement) => paymentTermsEqual(requirement, paymentPayload.accepted));
    if (!accepted) throw new Error("Externally signed payment payload does not match the current bounded challenge");
    if (BigInt(paymentPayload.accepted.amount) > effectiveMaxAmount) throw new Error("Externally signed payment exceeds the authorized spend ceiling");

    const paidResponse = await fetch(requestUrl, {
      ...requestInit,
      headers: {
        ...(requestInit.headers || {}),
        "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(paymentPayload),
      },
    });
    const responseBody = await paidResponse.text();
    if (!paidResponse.ok) throw new Error(`Paid resource request failed (${paidResponse.status}): ${responseBody}`);
    const paymentResponse = paidResponse.headers.get("payment-response");
    if (!paymentResponse) throw new Error("Paid resource response did not include PAYMENT-RESPONSE settlement evidence");
    const result = decodePaymentResponseHeader(paymentResponse);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            resource: params.resourceUrl,
            transaction: result.transaction,
            network: result.network,
            sellerResponse: {
              trust: "untrusted_seller_data",
              contentType: paidResponse.headers.get("content-type"),
              body: responseBody,
            },
          }),
        },
      ],
    };
  }

  /**
   * Start the MCP server
   */
  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    console.error("Veridex MCP Discovery Server running on stdio");
    console.error(`Bazaar: ${this.config.bazaarUrl}`);
    console.error(`Facilitator: ${this.config.facilitatorUrl}`);
    console.error(`Network: ${this.config.stellar.network}`);
  }
}

function readPaymentRequired(response: Response): PaymentRequired {
  const encoded = response.headers.get("payment-required");
  if (!encoded) throw new Error("Resource returned HTTP 402 without PAYMENT-REQUIRED");
  try {
    return decodePaymentRequiredHeader(encoded);
  } catch {
    throw new Error("Resource returned a malformed PAYMENT-REQUIRED header");
  }
}

function paymentTermsEqual(left: PaymentRequirements, right: PaymentRequirements): boolean {
  return left.scheme === right.scheme &&
    left.network === right.network &&
    left.asset === right.asset &&
    left.amount === right.amount &&
    left.payTo === right.payTo &&
    left.maxTimeoutSeconds === right.maxTimeoutSeconds;
}

// Start only when run as a program. Importing this module for tests or to
// embed the server elsewhere must not open a transport.
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = new VeridexMCPServer(getConfig());
  server.start().catch((error) => {
    console.error("Failed to start MCP server:", error);
    process.exit(1);
  });
}

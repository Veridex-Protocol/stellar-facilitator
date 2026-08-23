#!/usr/bin/env node
/**
 * Veridex MCP Discovery Server
 * License: Apache-2.0
 *
 * Model Context Protocol (MCP) server exposing Veridex Bazaar discovery
 * and x402 payment tools to AI agents.
 *
 * Tools:
 * - discover_resources - Search the Bazaar catalog (hybrid keyword + vector ranking)
 * - pay_resource - Execute x402 Stellar payment for resource access
 * - get_escrow_balance - Check escrow account balance (Soroban)
 * - deposit_escrow - Deposit funds into escrow (Soroban)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
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
    clientSecretKey?: string;
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
      clientSecretKey: process.env.STELLAR_CLIENT_SECRET_KEY,
      defaultMaxSpendAmount: process.env.MCP_MAX_SPEND_AMOUNT_STROOPS || "10000000",
    },
  };
}

/**
 * Discover resources tool schema
 */
export const DiscoverResourcesSchema = z.object({
  query: z.string().describe("Search query (keyword; ranking fuses BM25, feature-hash vectors, and telemetry)"),
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
            "Search the Veridex Bazaar catalog for x402 resources. Ranking fuses BM25 keyword match, feature-hash vector similarity, and live telemetry. " +
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
            "Execute x402 Stellar payment to access a resource. " +
            "Creates payment transaction, submits to facilitator, and returns access authorization.",
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
        return {
          content: [
            {
              type: "text",
              text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
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

    // Format results for AI
    const formatted = results.results
      ?.map(
        (r: any) =>
          `• ${r.resourceUrl}\n` +
          `  Service: ${r.serviceName || "N/A"}\n` +
          `  Description: ${r.description}\n` +
          `  Network: ${r.network}\n` +
          `  Score: ${r.compositeScore?.toFixed(3) || "N/A"}\n` +
          `  Uptime: ${((r.telemetry?.uptimeRatio || 0) * 100).toFixed(1)}%\n` +
          `  Avg Latency: ${r.telemetry?.avgResponseTimeMs || "N/A"}ms\n` +
          `  Reliability: ${((r.reliabilityScore || 0) * 100).toFixed(1)}%`
      )
      .join("\n\n");

    return {
      content: [
        {
          type: "text",
          text:
            `Found ${results.total || 0} resources:\n\n${formatted}\n\n` +
            `Results are ranked by keyword match, feature-hash vector similarity, uptime, latency, and reliability signals.`,
        },
      ],
    };
  }

  /**
   * Handle pay_resource tool
   */
  async handlePayResource(args: unknown): Promise<any> {
    const params = PayResourceSchema.parse(args);

    if (!this.config.stellar.clientSecretKey) {
      throw new Error("STELLAR_CLIENT_SECRET_KEY not configured");
    }

    // SSRF Validation: validate the resource URL before making any network calls
    const requestUrl = validateSafeResourceUrl(params.resourceUrl);

    const network = this.config.stellar.network === "pubnet" ? "stellar:pubnet" : "stellar:testnet";
    const signer = createEd25519Signer(this.config.stellar.clientSecretKey, network);
    const coreClient = new x402Client().register("stellar:*", new ExactStellarScheme(signer));
    const httpClient = new x402HTTPClient(coreClient);

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
      return { content: [{ type: "text", text: body || `HTTP ${initialResponse.status}` }] };
    }

    const challengeBody = await initialResponse.json().catch(() => undefined);
    const paymentRequired = httpClient.getPaymentRequiredResponse(
      (name) => initialResponse.headers.get(name),
      challengeBody
    );

    // Enforce robust spend ceiling: filter accepts down strictly to authorized requirements
    const effectiveMaxAmount = BigInt(
      params.maxAmount || this.config.stellar.defaultMaxSpendAmount || "10000000"
    );

    const qualifiedRequirements = paymentRequired.accepts.filter(
      (requirement) =>
        requirement.network === network && BigInt(requirement.amount) <= effectiveMaxAmount
    );

    if (qualifiedRequirements.length === 0) {
      throw new Error(
        `Payment challenge requirements exceed maximum authorized spend ceiling of ${effectiveMaxAmount} stroops`
      );
    }

    // Filter paymentRequired so createPaymentPayload cannot select an expensive alternative requirement
    const cappedPaymentRequired = {
      ...paymentRequired,
      accepts: qualifiedRequirements,
    };

    const paymentPayload = await httpClient.createPaymentPayload(cappedPaymentRequired);

    // Final assert: ensure signed payment payload is strictly within ceiling
    if (BigInt(paymentPayload.accepted.amount) > effectiveMaxAmount) {
      throw new Error(
        `Constructed payment payload amount (${paymentPayload.accepted.amount}) exceeds authorized ceiling (${effectiveMaxAmount})`
      );
    }

    const paidResponse = await fetch(requestUrl, {
      ...requestInit,
      headers: {
        ...(requestInit.headers || {}),
        ...httpClient.encodePaymentSignatureHeader(paymentPayload),
      },
    });
    const responseBody = await paidResponse.text();
    if (!paidResponse.ok) throw new Error(`Paid resource request failed (${paidResponse.status}): ${responseBody}`);
    const result = httpClient.getPaymentSettleResponse((name) => paidResponse.headers.get(name));

    return {
      content: [
        {
          type: "text",
          text:
            `Payment successful.\nResource: ${params.resourceUrl}\n` +
            `Transaction: ${result.transaction}\n\nResponse:\n${responseBody}`,
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

// Start only when run as a program. Importing this module for tests or to
// embed the server elsewhere must not open a transport.
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = new VeridexMCPServer(getConfig());
  server.start().catch((error) => {
    console.error("Failed to start MCP server:", error);
    process.exit(1);
  });
}

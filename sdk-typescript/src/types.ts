/**
 * Veridex TypeScript SDK - Types
 * License: Apache-2.0
 */

/**
 * Bazaar search result
 */
export interface BazaarResource {
  resourceUrl: string;
  serviceName?: string;
  description: string;
  network: string;
  nodeId: string;
  lastSeen: number;
  uptimeRatio?: number;
  avgResponseTimeMs?: number;
  reliabilityScore?: number;
  finalScore?: number;
}

/**
 * Bazaar search response
 */
export interface BazaarSearchResponse {
  results: BazaarResource[];
  total: number;
  queryTimeMs: number;
}

/**
 * x402 payment request
 */
export interface X402PaymentRequest {
  resourceUrl: string;
  amountStroops: string;
  payTo: string;
  asset?: string;
  toolName?: string;
  sessionId?: string;
}

/**
 * x402 payment response
 */
export interface X402PaymentResponse {
  status: "success" | "error";
  transactionHash?: string;
  ledger?: number;
  error?: string;
  errorCode?: string;
}

/**
 * Facilitator supported schemes
 */
export interface FacilitatorScheme {
  x402Version: number;
  scheme: string;
  network: string;
  extra?: Record<string, unknown>;
}

/**
 * SDK configuration
 */
export interface VeridexSDKConfig {
  bazaarUrl: string;
  facilitatorUrl: string;
  stellar: {
    network: "pubnet" | "testnet" | "futurenet";
    clientSecretKey?: string;
  };
}

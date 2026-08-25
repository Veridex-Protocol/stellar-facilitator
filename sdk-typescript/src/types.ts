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
 * x402job/1 recomputable compute receipt claims (#3117)
 */
export interface JobReceiptClaims {
  v: "x402job/1";
  service: string;
  job: string;
  requestDigest: string;
  resultDigest: string;
  settlement: {
    tx: string;
    payer: string;
    asset: string;
    amount: string;
    network: string;
  };
  signer: string;
  issuedAt: number;
}

/**
 * x402job/1 recomputable compute receipt (#3117)
 */
export interface JobReceipt {
  claims: JobReceiptClaims;
  signature: string;
}

/**
 * x402ccd/0 compute-capability descriptor (#3117)
 */
export interface ComputeCapabilityDescriptor {
  ccd: "x402ccd/0";
  service: string;
  baseUrl: string;
  runtime: {
    attested: boolean;
    platform: string;
    note: string;
  };
  receipts: {
    format: string;
    signer: string;
    note: string;
  };
  jobs: Array<{
    id: string;
    method: string;
    path: string;
    price: {
      asset: string;
      amountAtomic: string;
      decimals: number;
      network: string;
      scheme: string;
      payTo: string;
    };
    verification: {
      kind: string;
      detail: string;
    };
  }>;
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
  receipt?: JobReceipt;
  extra?: Record<string, unknown>;
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
 * Smart Account / Passkey custom signer interface (supports C... addresses and custom auth entries)
 */
export interface SmartAccountSigner {
  /** Account address (C... contract ID or G... public key) */
  address: string;

  /** Sign Soroban authorization entry */
  signAuthEntry?: (entryXdr: string) => Promise<{ signedAuthEntry?: string; signatureScVal?: any }>;

  /** Sign transaction XDR */
  signTransaction?: (txXdr: string) => Promise<string>;

  /** Custom authorizeEntry override for smart wallets / passkeys */
  authorizeEntry?: (
    entry: any,
    signer: any,
    expiration: number,
    networkPassphrase?: string
  ) => Promise<any>;
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
    customSigner?: SmartAccountSigner;
  };
}

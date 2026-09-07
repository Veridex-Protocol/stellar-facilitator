import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

export const GATEWAY_NETWORKS = ["stellar:testnet"] as const;
export const GATEWAY_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export type GatewayNetwork = (typeof GATEWAY_NETWORKS)[number];
export type GatewayMethod = (typeof GATEWAY_METHODS)[number];
export type GatewayLifecycle = "draft" | "active" | "paused" | "disabled";
export type PaymentEventStatus = "challenged" | "verified" | "settled" | "rejected" | "failed";

export interface GatewayRouteConfig {
  path: string;
  methods?: GatewayMethod[];
  price?: string;
  name?: string;
  description?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  bazaar?: {
    enabled?: boolean;
    output?: Record<string, unknown>;
  };
  mcp?: Record<string, unknown>;
}

export interface GatewayConfig {
  id: string;
  upstream: string;
  publicBaseUrl: string;
  facilitatorUrl: string;
  payTo: string;
  network: GatewayNetwork;
  asset: string;
  price: string;
  name?: string;
  description?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  routePrefix?: string;
  routes?: GatewayRouteConfig[];
  state?: GatewayLifecycle;
  timeoutMs?: number;
  maxRequestBodyBytes?: number;
  maxResponseBodyBytes?: number;
  maxConcurrentRequests?: number;
  allowHttpForDevelopment?: boolean;
  allowedUpstreamOrigins?: string[];
  expiresAt?: string;
  developerId?: string;
}

export interface VeridexPaymentEvent {
  schemaVersion: "veridex.payment-event/v1";
  paymentId: string;
  resourceId: string;
  resourceUrl: string;
  scheme: "exact" | "upto";
  network: string;
  asset: string;
  payer?: string;
  payTo: string;
  authorizedAmount?: string;
  settledAmount?: string;
  grossAmount?: string;
  facilitatorFee?: string;
  gatewayFee: "0";
  netSellerAmount?: string;
  feeDetermination: "not_charged" | "unknown";
  status: PaymentEventStatus;
  transactionHash?: string;
  ledger?: number;
  requestId?: string;
  gatewayId: string;
  upstreamStatus?: number;
  settlementLatencyMs?: number;
  createdAt: string;
  settledAt?: string;
  failureCode?: string;
}

export interface ProviderOutcomeRecord {
  schemaVersion: "veridex.provider-outcome-record/v1";
  paymentId?: string;
  gatewayId: string;
  resourceId: string;
  requestId: string;
  upstreamStatus?: number;
  usable: boolean;
  providerAtFault: boolean;
  attributable: "provider" | "caller" | "unknown";
  reasonCode: string;
  observedAt: string;
}

export interface GatewayEventStore {
  appendPaymentEvent(event: VeridexPaymentEvent): Promise<void>;
  appendProviderOutcome(outcome: ProviderOutcomeRecord): Promise<void>;
  findSettlement(paymentId: string): Promise<VeridexPaymentEvent | undefined>;
}

export interface GatewayFacilitatorClient {
  verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<{ isValid: boolean; payer?: string; invalidReason?: string; invalidMessage?: string }>;
  settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<{
    success: boolean;
    transaction?: string;
    network?: string;
    payer?: string;
    errorReason?: string;
    errorMessage?: string;
    extra?: Record<string, unknown>;
  }>;
}

export interface GatewayDependencies {
  fetch?: typeof fetch;
  eventStore?: GatewayEventStore;
}
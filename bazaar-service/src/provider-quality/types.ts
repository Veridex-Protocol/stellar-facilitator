/**
 * Provider-quality persistence and wire types.
 * License: Apache-2.0
 */

import { z } from "zod";

export const ProviderObservationSchema = z.object({
  v: z.literal("veridex/provider-outcome/1"),
  resource: z.string().url(),
  payTo: z.string().min(1),
  requestDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/i),
  responseDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/i),
  observedAt: z.number().int().positive(),
  usable: z.boolean(),
  providerAtFault: z.boolean(),
  attributable: z.enum(["provider", "caller", "unknown"]),
  reasonCode: z.string().regex(/^[a-z][a-z0-9_.-]{1,63}$/),
  usageAtomic: z.string().regex(/^(0|[1-9][0-9]*)$/).optional(),
  responseStatus: z.number().int().min(100).max(599).optional(),
  toolName: z.string().max(256).optional(),
  route: z.string().max(256).optional(),
  callId: z.string().max(256).optional(),
  settlementTx: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
  signer: z.string().min(1),
  signature: z.string().min(1),
}).superRefine((value, context) => {
  if (value.providerAtFault && value.attributable !== "provider") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["attributable"],
      message: "providerAtFault requires provider attribution",
    });
  }
  if (!value.providerAtFault && value.attributable === "provider") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["providerAtFault"],
      message: "provider attribution requires providerAtFault",
    });
  }
});

export type ProviderObservation = z.infer<typeof ProviderObservationSchema>;

export const ProviderAggregateSchema = z.object({
  v: z.literal("veridex/provider-aggregate/1"),
  endpoint: z.string().url(),
  payTo: z.string().min(1).optional(),
  state: z.enum(["insufficient_data", "provisional", "published"]),
  faultRateUpperBound: z.number().min(0).max(1),
  faultsObserved: z.number().int().min(0),
  n: z.number().int().min(0),
  window: z.string().min(1).max(64),
  retrievedAt: z.number().int().positive(),
  issuer: z.string().min(1),
  signature: z.string().min(1),
}).superRefine((value, context) => {
  if (value.faultsObserved > value.n) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["faultsObserved"],
      message: "faultsObserved cannot exceed n",
    });
  }
});

export type ProviderAggregate = z.infer<typeof ProviderAggregateSchema>;

export interface ProviderObservationWrite {
  observation: ProviderObservation;
  source?: "in_band" | "independent";
  resourceType?: "http" | "mcp";
  toolName?: string;
  route?: string;
  callId?: string;
  settlementTx?: string;
}

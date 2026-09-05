/**
 * Wilson-bound provider-quality aggregate generation.
 * License: Apache-2.0
 */

import type { ProviderObservationRecord } from "./store.js";
import { createSignedProviderAggregate } from "./crypto.js";
import type { ProviderAggregate } from "./types.js";

export interface ProviderAggregateGenerationConfig {
  provisionalThreshold?: number;
  publishedThreshold?: number;
  windowSeconds?: number;
  window?: string;
  nowSeconds?: number;
}

export function buildProviderAggregate(
  endpoint: string,
  payTo: string | undefined,
  observations: ProviderObservationRecord[],
  issuerSecretKey: string,
  config: ProviderAggregateGenerationConfig = {},
): ProviderAggregate {
  const now = config.nowSeconds ?? Math.floor(Date.now() / 1000);
  const windowSeconds = config.windowSeconds ?? 30 * 24 * 60 * 60;
  const inWindow = observations.filter((observation) =>
    Math.floor(observation.observedAt.getTime() / 1000) >= now - windowSeconds &&
    Math.floor(observation.observedAt.getTime() / 1000) <= now,
  );
  const faultsObserved = inWindow.filter(
    (observation) => observation.providerAtFault && observation.attributable === "provider",
  ).length;
  const n = inWindow.length;
  const state = n >= (config.publishedThreshold ?? 100)
    ? "published"
    : n >= (config.provisionalThreshold ?? 20)
      ? "provisional"
      : "insufficient_data";

  return createSignedProviderAggregate({
    endpoint,
    ...(payTo ? { payTo } : {}),
    state,
    faultRateUpperBound: wilsonUpperBound(faultsObserved, n),
    faultsObserved,
    n,
    window: config.window ?? "30d",
    retrievedAt: now,
  }, issuerSecretKey);
}

export function wilsonUpperBound(faultsObserved: number, n: number, confidenceZ = 1.959963984540054): number {
  if (!Number.isInteger(faultsObserved) || !Number.isInteger(n) || n < 0 || faultsObserved < 0 || faultsObserved > n) {
    throw new Error("faultsObserved must be an integer between zero and n");
  }
  if (n === 0) return 1;
  const phat = faultsObserved / n;
  const z2 = confidenceZ ** 2;
  const denominator = 1 + z2 / n;
  const centre = phat + z2 / (2 * n);
  const spread = confidenceZ * Math.sqrt((phat * (1 - phat) / n) + z2 / (4 * n ** 2));
  return Math.min(1, (centre + spread) / denominator);
}
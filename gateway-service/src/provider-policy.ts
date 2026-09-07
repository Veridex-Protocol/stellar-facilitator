import {
  ProviderAggregateClient,
  SellerPolicyEngine,
  type SellerPolicyDecision,
} from "@veridex/stellar";
import type {
  GatewayConfig,
  GatewayProviderPolicyController,
  GatewayProviderPolicyDecision,
} from "./types.js";

export function createGatewayProviderPolicyController(
  config: GatewayConfig,
  options: { fetchImpl?: typeof fetch; now?: () => number } = {},
): GatewayProviderPolicyController | undefined {
  if (!config.providerPolicy?.enabled || !config.bazaarUrl) return undefined;
  const now = options.now ?? (() => Date.now());
  const client = new ProviderAggregateClient({
    indexerUrl: config.bazaarUrl,
    authorizedIssuers: config.providerPolicy.authorizedIssuers,
    fetchImpl: options.fetchImpl,
    now,
  });
  const engine = new SellerPolicyEngine(Object.fromEntries(Object.entries({
    warnMax: config.providerPolicy.warnMax,
    holdMax: config.providerPolicy.holdMax,
    insufficientData: config.providerPolicy.insufficientData,
    provisional: config.providerPolicy.provisional,
  }).filter(([, value]) => value !== undefined)));
  const decisions = new Map<string, GatewayProviderPolicyDecision>();
  const resources = (config.routes ?? [{ path: "/*" }]).map((route) =>
    new URL((config.routePrefix === "/" ? "" : config.routePrefix ?? "") + route.path.replace(/\*$/, ""), `${config.publicBaseUrl}/`).toString()
  );

  const refresh = async () => {
    await Promise.all(resources.map(async (resourceUrl) => {
      const lookup = await client.get(resourceUrl, config.payTo);
      decisions.set(resourceUrl, withTimestamp(engine.evaluate(resourceUrl, lookup), now()));
    }));
  };
  void refresh();
  const interval = setInterval(() => void refresh(), config.providerPolicy.refreshIntervalMs ?? 60_000);
  interval.unref?.();

  return {
    decision(resourceUrl) {
      return decisions.get(resourceUrl) ?? {
        action: "sell",
        reason: "provider policy aggregate is not available yet",
        warning: "provider policy refresh is pending; preserving payment availability",
        evaluatedAt: new Date(now()).toISOString(),
      };
    },
    stop() {
      clearInterval(interval);
    },
  };
}

function withTimestamp(
  decision: SellerPolicyDecision,
  now: number,
): GatewayProviderPolicyDecision {
  return { ...decision, evaluatedAt: new Date(now).toISOString() };
}
import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import {
  applyProviderOutcomeHeaders,
  computeSha256Digest,
  createProviderOutcome,
  type ProviderOutcome,
} from "@veridex/stellar";
import { Hono, type Context } from "hono";
import { assertPublicAddress, validateGatewayConfig } from "./config.js";
import { GatewayMetrics } from "./metrics.js";
import { InMemoryGatewayEventStore } from "./store.js";
import type {
  GatewayConfig,
  GatewayDependencies,
  GatewayEventStore,
  GatewayMethod,
  GatewayPortalSnapshotV1,
  GatewayRouteConfig,
  ProviderOutcomeRecord,
  VeridexPaymentEvent,
} from "./types.js";

const HOP_BY_HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te",
  "trailer", "transfer-encoding", "upgrade", "host", "authorization",
]);
const RESPONSE_HEADERS = ["content-type", "content-language", "cache-control", "etag", "last-modified"];
const METHODS: GatewayMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const inFlightSettlements = new Map<string, Promise<SettleResponse>>();

type GatewayEnv = { Variables: { requestId: string } };
type GatewayApp = Hono<GatewayEnv>;
type GatewayContext = Context<GatewayEnv>;

export async function createGatewayApp(
  input: GatewayConfig,
  dependencies: GatewayDependencies = {},
): Promise<GatewayApp> {
  const config = validateGatewayConfig(input);
  const eventStore = dependencies.eventStore ?? new InMemoryGatewayEventStore();
  const fetchImplementation = dependencies.fetch ?? fetch;
  const resolveHostname = dependencies.resolveHostname ?? defaultResolveHostname;
  const metrics = new GatewayMetrics();
  await assertSafeDns(config, resolveHostname);

  const resourceServer = new x402ResourceServer(
    new HTTPFacilitatorClient({ url: config.facilitatorUrl }),
  ).register(config.network, new ExactStellarScheme());
  await resourceServer.initialize();

  const app = new Hono<GatewayEnv>();
  const routes = config.routes ?? [{ path: "/*" }];
  let activeRequests = 0;
  const rateWindows = new Map<string, { startedAt: number; count: number }>();

  app.use("*", async (context, next) => {
    const incoming = context.req.header("X-Request-Id")?.trim();
    const requestId = incoming && /^[A-Za-z0-9._:-]{1,128}$/.test(incoming)
      ? incoming
      : randomUUID();
    context.set("requestId", requestId);
    context.header("X-Request-Id", requestId);
    await next();
  });

  app.get("/health", (context) => context.json({
    status: config.state === "active" ? "ok" : config.state,
    gatewayId: config.id,
    network: config.network,
  }));
  app.get("/metrics", (context) => context.text(
    metrics.render(config.state === "active"),
    200,
    { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
  ));

  if (dependencies.managementToken) {
    app.use("/v1/*", async (context, next) => {
      if (context.req.header("Authorization") !== `Bearer ${dependencies.managementToken}`) {
        return context.json({
          code: "unauthorized",
          reason: "Gateway management authorization is required.",
          retryable: false,
        }, 401);
      }
      await next();
    });
    app.get(`/v1/gateways/${config.id}`, async (context) => {
      return context.json(await portalSnapshot(config, routes, eventStore));
    });
    app.get(`/v1/gateways/${config.id}/events`, async (context) => context.json({
      schemaVersion: "veridex.gateway-events/v1",
      gatewayId: config.id,
      events: await eventStore.listPaymentEvents(config.id),
    }));
    app.get(`/v1/gateways/${config.id}/earnings`, async (context) => context.json(
      earningsSnapshot(config, await eventStore.listPaymentEvents(config.id)),
    ));
  }

  app.use("*", async (context, next) => {
    if (context.req.path === "/health" || context.req.path === "/metrics" || context.req.path.startsWith("/v1/")) {
      return next();
    }
    metrics.increment("veridex_gateway_requests_total");
    const refusal = requestRefusal(config, context, activeRequests, rateWindows);
    if (refusal) return context.json(refusal.body, refusal.status);
    activeRequests += 1;
    try {
      await next();
    } finally {
      activeRequests -= 1;
    }
  });

  for (const route of routes) {
    for (const method of route.methods ?? METHODS) {
      app.on(method, joinPath(config.routePrefix ?? "/", route.path), async (context) => {
        return handleProtectedRequest({
          config,
          route,
          context,
          resourceServer,
          eventStore,
          metrics,
          fetchImplementation,
          resolveHostname,
          providerOutcomeSecretKey: dependencies.providerOutcomeSecretKey,
          providerObserverToken: dependencies.providerObserverToken,
        });
      });
    }
  }

  return app;
}

interface RequestHandlerOptions {
  config: GatewayConfig;
  route: GatewayRouteConfig;
  context: GatewayContext;
  resourceServer: x402ResourceServer;
  eventStore: GatewayEventStore;
  metrics: GatewayMetrics;
  fetchImplementation: typeof fetch;
  resolveHostname: (hostname: string) => Promise<string[]>;
  providerOutcomeSecretKey?: string;
  providerObserverToken?: string;
}

async function handleProtectedRequest(options: RequestHandlerOptions): Promise<Response> {
  const { config, route, context, resourceServer, eventStore, metrics } = options;
  const requestId = context.get("requestId");
  const resourceUrl = publicResourceUrl(config, context.req.path, context.req.url);
  const resourceId = stableId(
    `${config.publicBaseUrl}|${route.routeTemplate ?? route.path}|exact|${config.network}`,
  );
  const extensions = route.bazaar?.enabled === false
    ? undefined
    : declareDiscoveryExtension({ output: route.bazaar?.output ?? { example: {} } });
  const requirements = await resourceServer.buildPaymentRequirementsFromOptions([{
    scheme: "exact",
    network: config.network,
    price: { asset: config.asset, amount: route.price ?? config.price },
    payTo: config.payTo,
    maxTimeoutSeconds: 120,
  }], { request: context.req.raw });
  const paymentHeader = context.req.header("PAYMENT-SIGNATURE") ?? context.req.header("X-PAYMENT");
  let paymentPayload: PaymentPayload | undefined;

  try {
    paymentPayload = paymentHeader ? decodePaymentSignatureHeader(paymentHeader) : undefined;
  } catch {
    return paymentRequiredResponse(
      resourceServer,
      requirements,
      config,
      route,
      resourceUrl,
      extensions,
      "Invalid payment signature header",
    );
  }

  const paymentRequired = await resourceServer.createPaymentRequiredResponse(
    requirements,
    resourceInfo(config, route, resourceUrl),
    paymentPayload ? undefined : "Payment required",
    extensions,
    { request: context.req.raw },
    paymentPayload,
  );
  if (!paymentPayload) {
    metrics.increment("veridex_gateway_402_total");
    await eventStore.appendPaymentEvent(paymentEvent({
      config,
      route,
      paymentId: requestId,
      resourceId,
      resourceUrl,
      requestId,
      status: "challenged",
    }));
    return encodedPaymentRequired(paymentRequired);
  }

  let body: ArrayBuffer | undefined;
  try {
    assertUnambiguousFraming(context.req.raw);
    body = context.req.method === "GET" || context.req.method === "HEAD"
      ? undefined
      : await readBoundedBody(context.req.raw, config.maxRequestBodyBytes ?? 1024 * 1024);
  } catch (error) {
    return context.json({
      code: error instanceof GatewayHttpError ? error.code : "invalid_request",
      reason: "The upstream request is not safe to forward.",
      retryable: false,
    }, 413);
  }

  const matchingRequirements = resourceServer.findMatchingRequirements(
    paymentRequired.accepts,
    paymentPayload,
  );
  const extensionValidation = resourceServer.validateExtensions(paymentRequired, paymentPayload);
  const paymentId = stableId(`${config.id}:${JSON.stringify(paymentPayload)}`);
  if (!matchingRequirements || !extensionValidation.valid) {
    metrics.increment("veridex_gateway_402_total");
    const failureCode = !matchingRequirements
      ? "payment_requirements_mismatch"
      : extensionValidation.valid
        ? "extension_validation_failed"
        : extensionValidation.invalidReason;
    await eventStore.appendPaymentEvent(paymentEvent({
      config,
      route,
      paymentId,
      resourceId,
      resourceUrl,
      requestId,
      status: "rejected",
      failureCode,
    }));
    return encodedPaymentRequired(await resourceServer.createPaymentRequiredResponse(
      requirements,
      resourceInfo(config, route, resourceUrl),
      failureCode,
      extensions,
      { request: context.req.raw },
      paymentPayload,
    ));
  }

  let settlement = await eventStore.findSettlement(paymentId);
  let settleResult: SettleResponse;
  if (settlement) {
    settleResult = eventToSettlement(settlement);
  } else {
    try {
      metrics.increment("veridex_gateway_verifications_total");
      const verifyResult = await resourceServer.verifyPayment(
        paymentPayload,
        matchingRequirements,
        extensions,
        { request: context.req.raw },
      );
      if (!verifyResult.isValid) {
        await eventStore.appendPaymentEvent(paymentEvent({
          config,
          route,
          paymentId,
          resourceId,
          resourceUrl,
          requestId,
          status: "rejected",
          payer: verifyResult.payer,
          failureCode: verifyResult.invalidReason,
        }));
        return encodedPaymentRequired(await resourceServer.createPaymentRequiredResponse(
          requirements,
          resourceInfo(config, route, resourceUrl),
          verifyResult.invalidReason ?? "Payment verification failed",
          extensions,
          { request: context.req.raw },
          paymentPayload,
        ));
      }
      await eventStore.appendPaymentEvent(paymentEvent({
        config,
        route,
        paymentId,
        resourceId,
        resourceUrl,
        requestId,
        status: "verified",
        payer: verifyResult.payer,
      }));

      const settlementStartedAt = Date.now();
      settleResult = await settleOnce(paymentId, () => resourceServer.settlePayment(
        paymentPayload!,
        matchingRequirements,
        extensions,
        { request: context.req.raw },
      ));
      if (!settleResult.success) {
        metrics.increment("veridex_gateway_settlement_failures_total");
        await eventStore.appendPaymentEvent(paymentEvent({
          config,
          route,
          paymentId,
          resourceId,
          resourceUrl,
          requestId,
          status: "failed",
          payer: verifyResult.payer,
          failureCode: settleResult.errorReason,
        }));
        return context.json({
          code: "settlement_failed",
          reason: settleResult.errorMessage ?? "The facilitator could not settle the payment.",
          retryable: false,
        }, 402);
      }
      metrics.increment("veridex_gateway_settlements_total");
      settlement = paymentEvent({
        config,
        route,
        paymentId,
        resourceId,
        resourceUrl,
        requestId,
        status: "settled",
        payer: settleResult.payer ?? verifyResult.payer,
        transactionHash: settleResult.transaction,
        settlementLatencyMs: Date.now() - settlementStartedAt,
        settledAt: new Date().toISOString(),
      });
      await eventStore.appendPaymentEvent(settlement);
    } catch (error) {
      metrics.increment("veridex_gateway_settlement_failures_total");
      await eventStore.appendPaymentEvent(paymentEvent({
        config,
        route,
        paymentId,
        resourceId,
        resourceUrl,
        requestId,
        status: "failed",
        failureCode: "facilitator_unavailable",
      }));
      return context.json({
        code: "facilitator_unavailable",
        reason: publicMessage(error),
        retryable: true,
      }, 503);
    }
  }

  return forwardSettledRequest({
    ...options,
    paymentId,
    resourceId,
    resourceUrl,
    requestId,
    settleResult,
    body,
  });
}

async function forwardSettledRequest(
  options: RequestHandlerOptions & {
    paymentId: string;
    resourceId: string;
    resourceUrl: string;
    requestId: string;
    settleResult: SettleResponse;
    body?: ArrayBuffer;
  },
): Promise<Response> {
  const startedAt = Date.now();
  options.metrics.increment("veridex_gateway_upstream_requests_total");
  try {
    await assertSafeDns(options.config, options.resolveHostname);
    const upstreamResponse = await forwardRequest(
      options.config,
      options.context.req.raw,
      options.fetchImplementation,
      options.paymentId,
      options.body,
    );
    options.metrics.increment("veridex_gateway_bytes_in", options.body?.byteLength ?? 0);
    const responseBody = new Uint8Array(await readBoundedBody(
      upstreamResponse,
      options.config.maxResponseBodyBytes ?? 5 * 1024 * 1024,
    ));
    options.metrics.increment("veridex_gateway_bytes_out", responseBody.byteLength);
    options.metrics.observe("veridex_gateway_upstream_latency", (Date.now() - startedAt) / 1_000);
    const record = classifyProviderOutcome(upstreamResponse.status, {
      paymentId: options.paymentId,
      gatewayId: options.config.id,
      resourceId: options.resourceId,
      requestId: options.requestId,
    });
    await options.eventStore.appendProviderOutcome(record);
    if (record.providerAtFault) options.metrics.increment("veridex_gateway_provider_faults_total");

    const headers = filterResponseHeaders(upstreamResponse.headers);
    headers.set("PAYMENT-RESPONSE", encodePaymentResponseHeader(options.settleResult));
    headers.set("X-Veridex-Gateway-Id", options.config.id);
    headers.set("X-Veridex-Resource-Id", options.resourceId);
    headers.set("Server-Timing", `veridex-gateway;dur=${Date.now() - startedAt}`);
    const signedOutcome = createSignedOutcome(options, responseBody, record);
    if (signedOutcome) {
      applyProviderOutcomeHeaders(signedOutcome, (name, value) => headers.set(name, value), "exact");
      void reportProviderOutcome(options, signedOutcome);
    }
    return new Response(responseBody, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers,
    });
  } catch (error) {
    options.metrics.increment("veridex_gateway_upstream_failures_total");
    options.metrics.increment("veridex_gateway_provider_faults_total");
    const code = error instanceof GatewayHttpError
      ? error.code
      : isTimeout(error)
        ? "upstream_timeout"
        : "upstream_unreachable";
    await options.eventStore.appendProviderOutcome({
      schemaVersion: "veridex.provider-outcome-record/v1",
      paymentId: options.paymentId,
      gatewayId: options.config.id,
      resourceId: options.resourceId,
      requestId: options.requestId,
      usable: false,
      providerAtFault: true,
      attributable: "provider",
      reasonCode: code,
      observedAt: new Date().toISOString(),
    });
    const response = Response.json({
      code,
      reason: code === "upstream_timeout"
        ? "Upstream request timed out after settlement."
        : "Upstream request failed after settlement.",
      retryable: code !== "body_limit_exceeded",
      payment: { status: "settled", transactionHash: options.settleResult.transaction },
    }, { status: code === "upstream_timeout" ? 504 : 502 });
    response.headers.set("PAYMENT-RESPONSE", encodePaymentResponseHeader(options.settleResult));
    return response;
  }
}

async function forwardRequest(
  config: GatewayConfig,
  request: Request,
  fetchImplementation: typeof fetch,
  paymentId: string,
  body?: ArrayBuffer,
): Promise<Response> {
  const incoming = new URL(request.url);
  const upstream = new URL(config.upstream);
  const routePrefix = config.routePrefix ?? "/";
  const relativePath = routePrefix === "/"
    ? incoming.pathname
    : incoming.pathname.slice(routePrefix.length) || "/";
  upstream.pathname = joinPath(upstream.pathname || "/", relativePath);
  upstream.search = incoming.search;

  const headers = filterRequestHeaders(request.headers);
  headers.set("X-Veridex-Gateway-Id", config.id);
  headers.set("X-Request-Id", request.headers.get("X-Request-Id") ?? randomUUID());
  headers.set("Idempotency-Key", paymentId);
  return fetchImplementation(upstream, {
    method: request.method,
    headers,
    body,
    redirect: "error",
    signal: AbortSignal.timeout(config.timeoutMs ?? 30_000),
  });
}

async function readBoundedBody(
  message: Request | Response,
  maximumBytes: number,
): Promise<ArrayBuffer> {
  const declaredLength = Number(message.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new GatewayHttpError("body_limit_exceeded", "declared body exceeds configured limit");
  }
  if (!message.body) return new ArrayBuffer(0);
  const reader = message.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new GatewayHttpError("body_limit_exceeded", "streamed body exceeds configured limit");
    }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result.buffer;
}

function assertUnambiguousFraming(request: Request): void {
  if (request.headers.has("transfer-encoding") && request.headers.has("content-length")) {
    throw new GatewayHttpError("invalid_request", "ambiguous request framing");
  }
}

function paymentRequiredResponse(
  server: x402ResourceServer,
  requirements: PaymentRequirements[],
  config: GatewayConfig,
  route: GatewayRouteConfig,
  resourceUrl: string,
  extensions: Record<string, unknown> | undefined,
  error: string,
): Promise<Response> {
  return server.createPaymentRequiredResponse(
    requirements,
    resourceInfo(config, route, resourceUrl),
    error,
    extensions,
  ).then(encodedPaymentRequired);
}

function encodedPaymentRequired(
  paymentRequired: Awaited<ReturnType<x402ResourceServer["createPaymentRequiredResponse"]>>,
): Response {
  return Response.json(paymentRequired, {
    status: 402,
    headers: {
      "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired),
      "Cache-Control": "no-store",
    },
  });
}

function resourceInfo(config: GatewayConfig, route: GatewayRouteConfig, resourceUrl: string) {
  return {
    url: resourceUrl,
    serviceName: route.name ?? config.name ?? "Veridex Gateway",
    description: route.description ?? config.description ?? "HTTPS API protected by Stellar x402.",
    mimeType: "application/json",
    tags: route.tags ?? config.tags ?? ["gateway", "stellar"],
  };
}

function paymentEvent(input: {
  config: GatewayConfig;
  route: GatewayRouteConfig;
  paymentId: string;
  resourceId: string;
  resourceUrl: string;
  requestId: string;
  status: VeridexPaymentEvent["status"];
  payer?: string;
  transactionHash?: string;
  settlementLatencyMs?: number;
  settledAt?: string;
  failureCode?: string;
}): VeridexPaymentEvent {
  const amount = input.route.price ?? input.config.price;
  return {
    schemaVersion: "veridex.payment-event/v1",
    paymentId: input.paymentId,
    resourceId: input.resourceId,
    resourceUrl: input.resourceUrl,
    scheme: "exact",
    network: input.config.network,
    asset: input.config.asset,
    payer: input.payer,
    payTo: input.config.payTo,
    authorizedAmount: amount,
    settledAmount: input.status === "settled" ? amount : undefined,
    grossAmount: input.status === "settled" ? amount : undefined,
    facilitatorFee: undefined,
    gatewayFee: "0",
    netSellerAmount: input.status === "settled" ? amount : undefined,
    feeDetermination: "not_charged",
    status: input.status,
    transactionHash: input.transactionHash,
    requestId: input.requestId,
    gatewayId: input.config.id,
    settlementLatencyMs: input.settlementLatencyMs,
    createdAt: new Date().toISOString(),
    settledAt: input.settledAt,
    failureCode: input.failureCode,
  };
}

function createSignedOutcome(
  options: RequestHandlerOptions & { resourceUrl: string; requestId: string },
  responseBody: Uint8Array,
  record: ProviderOutcomeRecord,
): ProviderOutcome | undefined {
  if (!options.providerOutcomeSecretKey) return undefined;
  return createProviderOutcome({
    resource: options.resourceUrl,
    payTo: options.config.payTo,
    requestDigest: computeSha256Digest({
      method: options.context.req.method,
      url: options.resourceUrl,
    }),
    responseDigest: computeSha256Digest(responseBody),
    observedAt: Math.floor(Date.now() / 1_000),
    usable: record.usable,
    providerAtFault: record.providerAtFault,
    attributable: record.attributable,
    reasonCode: record.reasonCode,
    responseStatus: record.upstreamStatus,
    route: options.route.routeTemplate ?? options.route.path,
    callId: options.requestId,
  }, options.providerOutcomeSecretKey);
}

async function reportProviderOutcome(
  options: RequestHandlerOptions,
  outcome: ProviderOutcome,
): Promise<void> {
  if (!options.config.bazaarUrl || !options.providerObserverToken) return;
  try {
    await options.fetchImplementation(
      new URL("/provider-quality/observations", options.config.bazaarUrl),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${options.providerObserverToken}`,
        },
        body: JSON.stringify(outcome),
        signal: AbortSignal.timeout(2_000),
      },
    );
  } catch {
    // Provider-quality reporting is deliberately outside the payment path.
  }
}

function classifyProviderOutcome(
  upstreamStatus: number,
  context: Pick<ProviderOutcomeRecord, "gatewayId" | "resourceId" | "requestId" | "paymentId">,
): ProviderOutcomeRecord {
  const usable = upstreamStatus >= 200 && upstreamStatus < 400;
  const callerFault = [400, 401, 403, 404, 409, 422, 429].includes(upstreamStatus);
  return {
    schemaVersion: "veridex.provider-outcome-record/v1",
    ...context,
    upstreamStatus,
    usable,
    providerAtFault: !usable && !callerFault,
    attributable: usable ? "unknown" : callerFault ? "caller" : "provider",
    reasonCode: usable ? "ok" : callerFault ? `upstream_${upstreamStatus}` : "upstream_failure",
    observedAt: new Date().toISOString(),
  };
}

async function settleOnce(
  paymentId: string,
  settle: () => Promise<SettleResponse>,
): Promise<SettleResponse> {
  const existing = inFlightSettlements.get(paymentId);
  if (existing) return existing;
  const pending = settle().finally(() => inFlightSettlements.delete(paymentId));
  inFlightSettlements.set(paymentId, pending);
  return pending;
}

function eventToSettlement(event: VeridexPaymentEvent): SettleResponse {
  return {
    success: true,
    transaction: event.transactionHash ?? "",
    network: event.network as `${string}:${string}`,
    payer: event.payer ?? "",
  };
}

function requestRefusal(
  config: GatewayConfig,
  context: GatewayContext,
  activeRequests: number,
  windows: Map<string, { startedAt: number; count: number }>,
): {
  status: 410 | 429 | 503;
  body: { code: string; reason: string; retryable: boolean };
} | undefined {
  if (config.state !== "active") {
    return {
      status: 503,
      body: { code: "gateway_disabled", reason: `Gateway is ${config.state}.`, retryable: false },
    };
  }
  if (config.expiresAt && Date.parse(config.expiresAt) <= Date.now()) {
    return {
      status: 410,
      body: { code: "gateway_disabled", reason: "Gateway has expired.", retryable: false },
    };
  }
  if (activeRequests >= (config.maxConcurrentRequests ?? 100)) {
    return {
      status: 429,
      body: { code: "rate_limited", reason: "Gateway concurrency limit reached.", retryable: true },
    };
  }
  const key = context.req.header("X-Forwarded-For")?.split(",")[0]?.trim() || "unknown";
  const limit = config.rateLimit ?? { windowMs: 60_000, max: 120 };
  const now = Date.now();
  let window = windows.get(key);
  if (!window || now - window.startedAt >= limit.windowMs) {
    window = { startedAt: now, count: 0 };
    windows.set(key, window);
  }
  window.count += 1;
  if (window.count > limit.max) {
    return {
      status: 429,
      body: { code: "rate_limited", reason: "Gateway request rate exceeded.", retryable: true },
    };
  }
  return undefined;
}

async function portalSnapshot(
  config: GatewayConfig,
  routes: GatewayRouteConfig[],
  store: GatewayEventStore,
): Promise<GatewayPortalSnapshotV1> {
  return {
    schemaVersion: "veridex.portal.stellar-gateway/v1",
    gateway: {
      id: config.id,
      developerId: config.developerId,
      state: config.state ?? "active",
      upstreamOrigin: new URL(config.upstream).origin,
      publicBaseUrl: config.publicBaseUrl,
      expiresAt: config.expiresAt,
    },
    resources: routes.map((route) => ({
      id: stableId(`${config.publicBaseUrl}|${route.routeTemplate ?? route.path}|exact|${config.network}`),
      path: route.path,
      routeTemplate: route.routeTemplate,
      scheme: "exact",
      network: config.network,
      asset: config.asset,
      amount: route.price ?? config.price,
      payTo: config.payTo,
      bazaar: route.bazaar?.enabled === false ? "disabled" : "declared",
      mcp: route.mcp ? "declared" : "disabled",
    })),
    payments: await store.listPaymentEvents(config.id),
    providerOutcomes: await store.listProviderOutcomes(config.id),
    generatedAt: new Date().toISOString(),
  };
}

function earningsSnapshot(config: GatewayConfig, events: VeridexPaymentEvent[]) {
  const settlements = events.filter((event) => event.status === "settled");
  const grossAtomic = settlements.reduce(
    (sum, event) => sum + BigInt(event.grossAmount ?? "0"),
    0n,
  );
  return {
    schemaVersion: "veridex.gateway-earnings/v1",
    gatewayId: config.id,
    network: config.network,
    asset: config.asset,
    grossAmount: grossAtomic.toString(),
    facilitatorFee: null,
    gatewayFee: "0",
    netSellerAmount: grossAtomic.toString(),
    feeDetermination: "gateway_not_charged_facilitator_unknown",
    settlementCount: settlements.length,
  };
}

async function assertSafeDns(
  config: GatewayConfig,
  resolver: (hostname: string) => Promise<string[]>,
): Promise<void> {
  const upstream = new URL(config.upstream);
  const hostname = upstream.hostname;
  const addresses = await resolver(hostname);
  if (addresses.length === 0) throw new Error("upstream hostname did not resolve");
  const developmentOriginAllowed = config.allowHttpForDevelopment === true &&
    config.allowedUpstreamOrigins?.some((entry) => new URL(entry).origin === upstream.origin);
  if (developmentOriginAllowed) return;
  for (const address of addresses) assertPublicAddress(address);
}

async function defaultResolveHostname(hostname: string): Promise<string[]> {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((result) => result.address);
}

function filterRequestHeaders(input: Headers): Headers {
  const output = new Headers();
  input.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(lower) ||
      lower.startsWith("x-forwarded-") ||
      lower.startsWith("payment-") ||
      lower === "cookie" ||
      lower === "set-cookie" ||
      lower === "x-payment"
    ) return;
    output.set(name, value);
  });
  return output;
}

function filterResponseHeaders(input: Headers): Headers {
  const output = new Headers();
  for (const name of RESPONSE_HEADERS) {
    const value = input.get(name);
    if (value) output.set(name, value);
  }
  return output;
}

function publicResourceUrl(config: GatewayConfig, path: string, _rawUrl: string): string {
  return new URL(path, `${config.publicBaseUrl}/`).toString();
}

function joinPath(left: string, right: string): string {
  const prefix = left === "/" ? "" : left.replace(/\/$/, "");
  const suffix = right.startsWith("/") ? right : `/${right}`;
  return `${prefix}${suffix}` || "/";
}

function stableId(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function publicMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The payment facilitator is unavailable.";
}

function isTimeout(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
}

class GatewayHttpError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}
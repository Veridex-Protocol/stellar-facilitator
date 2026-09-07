import { createHash, randomUUID } from "node:crypto";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { Hono } from "hono";
import { validateGatewayConfig } from "./config.js";
import { InMemoryGatewayEventStore } from "./store.js";
import type {
  GatewayConfig,
  GatewayDependencies,
  GatewayEventStore,
  GatewayMethod,
  GatewayRouteConfig,
  ProviderOutcomeRecord,
} from "./types.js";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "authorization",
]);

const RESPONSE_HEADERS = ["content-type", "content-language", "cache-control", "etag", "last-modified"];
const METHODS: GatewayMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

export function createGatewayApp(input: GatewayConfig, dependencies: GatewayDependencies = {}): Hono {
  const config = validateGatewayConfig(input);
  const eventStore = dependencies.eventStore ?? new InMemoryGatewayEventStore();
  const fetchImplementation = dependencies.fetch ?? fetch;
  const facilitator = new HTTPFacilitatorClient({ url: config.facilitatorUrl });
  const resourceServer = new x402ResourceServer(facilitator).register(
    config.network,
    new ExactStellarScheme(),
  );
  const app = new Hono();
  const routes = config.routes ?? [{ path: "/*" }];
  let activeRequests = 0;

  app.use("*", async (context, next) => {
    const incoming = context.req.header("X-Request-Id")?.trim();
    const requestId = incoming && /^[A-Za-z0-9._:-]{1,128}$/.test(incoming) ? incoming : randomUUID();
    context.set("requestId", requestId);
    context.header("X-Request-Id", requestId);
    await next();
  });

  app.get("/health", (context) => context.json({
    status: config.state === "active" ? "ok" : config.state,
    gatewayId: config.id,
    network: config.network,
  }));

  app.use("*", async (context, next) => {
    if (context.req.path === "/health") return next();
    if (config.state !== "active") {
      return context.json({ code: "gateway_disabled", reason: `Gateway is ${config.state}.`, retryable: false }, 503);
    }
    if (config.expiresAt && Date.parse(config.expiresAt) <= Date.now()) {
      return context.json({ code: "gateway_disabled", reason: "Gateway has expired.", retryable: false }, 410);
    }
    if (activeRequests >= (config.maxConcurrentRequests ?? 100)) {
      return context.json({ code: "rate_limited", reason: "Gateway concurrency limit reached.", retryable: true }, 429);
    }
    activeRequests += 1;
    try {
      await next();
    } finally {
      activeRequests -= 1;
    }
  });

  app.use(
    paymentMiddleware(buildPaymentRoutes(config, routes), resourceServer, undefined, undefined, false),
  );

  for (const route of routes) {
    for (const method of route.methods ?? METHODS) {
      const publicPath = joinPath(config.routePrefix ?? "/", route.path);
      app.on(method, publicPath, async (context) => {
        const requestId = context.get("requestId") as string;
        const resourceUrl = publicResourceUrl(config, context.req.path, context.req.url);
        const resourceId = stableId(`${resourceUrl}|exact|${config.network}`);
        const startedAt = Date.now();

        try {
          const upstreamResponse = await forwardRequest(config, context.req.raw, fetchImplementation);
          const responseBody = new Uint8Array(await readBoundedBody(upstreamResponse, config.maxResponseBodyBytes ?? 5 * 1024 * 1024));
          const outcome = classifyProviderOutcome(upstreamResponse.status, {
            gatewayId: config.id,
            resourceId,
            requestId,
          });
          await eventStore.appendProviderOutcome(outcome);

          const response = new Response(responseBody, {
            status: upstreamResponse.status,
            statusText: upstreamResponse.statusText,
            headers: filterResponseHeaders(upstreamResponse.headers),
          });
          response.headers.set("X-Veridex-Gateway-Id", config.id);
          response.headers.set("X-Veridex-Resource-Id", resourceId);
          response.headers.set("Server-Timing", `veridex-gateway;dur=${Date.now() - startedAt}`);
          return response;
        } catch (error) {
          const timeout = error instanceof DOMException && error.name === "TimeoutError";
          const outcome: ProviderOutcomeRecord = {
            schemaVersion: "veridex.provider-outcome-record/v1",
            gatewayId: config.id,
            resourceId,
            requestId,
            usable: false,
            providerAtFault: true,
            attributable: "provider",
            reasonCode: timeout ? "upstream_timeout" : "upstream_unreachable",
            observedAt: new Date().toISOString(),
          };
          await eventStore.appendProviderOutcome(outcome);
          return context.json({
            code: timeout ? "upstream_timeout" : "upstream_unreachable",
            reason: timeout ? "Upstream request timed out." : "Upstream request failed.",
            retryable: true,
          }, timeout ? 504 : 502);
        }
      });
    }
  }

  return app;
}

function buildPaymentRoutes(config: GatewayConfig, routes: GatewayRouteConfig[]) {
  return Object.fromEntries(routes.flatMap((route) => {
    const path = joinPath(config.routePrefix ?? "/", route.path);
    return (route.methods ?? METHODS).map((method) => [
      `${method} ${path}`,
      {
        accepts: [{
          scheme: "exact" as const,
          network: config.network,
          price: { asset: config.asset, amount: route.price ?? config.price },
          payTo: config.payTo,
          maxTimeoutSeconds: 120,
        }],
        resource: `${config.publicBaseUrl}${path.replace(/\*$/, "")}`,
        serviceName: route.name ?? config.name ?? "Veridex Gateway",
        description: route.description ?? config.description ?? "HTTPS API protected by Stellar x402.",
        mimeType: "application/json",
        tags: route.tags ?? config.tags ?? ["gateway", "stellar"],
        extensions: route.bazaar?.enabled === false
          ? undefined
          : declareDiscoveryExtension({ output: route.bazaar?.output ?? { example: {} } }),
      },
    ]);
  }));
}

async function forwardRequest(config: GatewayConfig, request: Request, fetchImplementation: typeof fetch): Promise<Response> {
  const incoming = new URL(request.url);
  const upstream = new URL(config.upstream);
  const routePrefix = config.routePrefix ?? "/";
  const relativePath = routePrefix === "/" ? incoming.pathname : incoming.pathname.slice(routePrefix.length) || "/";
  upstream.pathname = joinPath(upstream.pathname || "/", relativePath);
  upstream.search = incoming.search;

  const headers = filterRequestHeaders(request.headers);
  headers.set("X-Veridex-Gateway-Id", config.id);
  headers.set("X-Request-Id", request.headers.get("X-Request-Id") ?? randomUUID());
  const body = request.method === "GET" || request.method === "HEAD"
    ? undefined
    : await readBoundedBody(request, config.maxRequestBodyBytes ?? 1024 * 1024);

  return fetchImplementation(upstream, {
    method: request.method,
    headers,
    body,
    redirect: "error",
    signal: AbortSignal.timeout(config.timeoutMs ?? 30_000),
  });
}

async function readBoundedBody(message: Request | Response, maximumBytes: number): Promise<ArrayBuffer> {
  const declaredLength = Number(message.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error("body_limit_exceeded");
  }
  const bytes = await message.arrayBuffer();
  if (bytes.byteLength > maximumBytes) throw new Error("body_limit_exceeded");
  return bytes;
}

function filterRequestHeaders(input: Headers): Headers {
  const output = new Headers();
  input.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || lower.startsWith("x-forwarded-") || lower.startsWith("payment-")) return;
    if (lower === "cookie" || lower === "set-cookie") return;
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

function classifyProviderOutcome(
  upstreamStatus: number,
  context: Pick<ProviderOutcomeRecord, "gatewayId" | "resourceId" | "requestId">,
): ProviderOutcomeRecord {
  const usable = upstreamStatus >= 200 && upstreamStatus < 400;
  const callerFault = upstreamStatus === 400 || upstreamStatus === 401 || upstreamStatus === 403 || upstreamStatus === 404 || upstreamStatus === 429;
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

function publicResourceUrl(config: GatewayConfig, path: string, rawUrl: string): string {
  const resource = new URL(path, `${config.publicBaseUrl}/`);
  resource.search = new URL(rawUrl).search;
  return resource.toString();
}

function joinPath(left: string, right: string): string {
  const prefix = left === "/" ? "" : left.replace(/\/$/, "");
  const suffix = right.startsWith("/") ? right : `/${right}`;
  return `${prefix}${suffix}` || "/";
}

function stableId(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
/**
 * Veridex Bazaar Service - Rate Limiting & Proxy Protection
 * License: Apache-2.0
 */

import type { Context, MiddlewareHandler, Next } from "hono";

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** Number of trusted reverse proxies in front of this service (default from TRUSTED_PROXY_COUNT or 0). */
  trustedProxyCount?: number;
  /** Derives the bucket key; defaults to the secure client IP. */
  keyOf?: (c: Context) => string;
  /** Called when a request is rejected, for the outcome log. */
  onRejected?: (c: Context, key: string) => void;
}

interface Window {
  count: number;
  resetAt: number;
}

/**
 * Derives a secure client IP for rate-limiting.
 *
 * If TRUSTED_PROXY_COUNT is configured > 0, reads the client IP from X-Forwarded-For
 * taking the untrusted boundary into account. If no trusted proxy is configured (0),
 * direct client-provided X-Forwarded-For is untrusted and ignored to prevent spoofing (VDX-07).
 *
 * @param c - Request context
 * @param trustedProxyCount - Configured trusted proxy count
 * @returns A bucket key for this client
 */
export function getClientIp(c: Context, trustedProxyCount?: number): string {
  const trustedProxies =
    trustedProxyCount ?? parseInt(process.env.TRUSTED_PROXY_COUNT || "0", 10);
  const socketAddress = (c.env as any)?.incoming?.socket?.remoteAddress ?? "unknown";

  if (trustedProxies > 0) {
    const forwarded = c.req.header("x-forwarded-for");
    if (forwarded) {
      const parts = forwarded.split(",").map((s) => s.trim()).filter(Boolean);
      const index = Math.max(0, parts.length - trustedProxies);
      return parts[index] || parts[0] || socketAddress;
    }
    const realIp = c.req.header("x-real-ip");
    if (realIp) return realIp.trim();
  }

  // If no trusted reverse proxy is configured, use the underlying socket address
  if (socketAddress !== "unknown") {
    return socketAddress;
  }

  const realIp = c.req.header("x-real-ip");
  if (realIp) return realIp.trim();

  return "unknown";
}

/**
 * Creates a fixed-window rate-limiting middleware.
 *
 * @param options - Window size, ceiling, and hooks
 * @returns A Hono middleware
 */
export function rateLimit(options: RateLimitOptions): MiddlewareHandler {
  const windows = new Map<string, Window>();
  const keyOf = options.keyOf ?? ((c) => getClientIp(c, options.trustedProxyCount));

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, window] of windows) {
      if (window.resetAt <= now) windows.delete(key);
    }
  }, options.windowMs);
  sweep.unref?.();

  return async (c: Context, next: Next) => {
    const key = keyOf(c);
    const now = Date.now();
    let window = windows.get(key);

    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + options.windowMs };
      windows.set(key, window);
    }

    window.count++;

    const remaining = Math.max(0, options.max - window.count);
    const resetSeconds = Math.ceil((window.resetAt - now) / 1000);
    c.header("RateLimit-Limit", String(options.max));
    c.header("RateLimit-Remaining", String(remaining));
    c.header("RateLimit-Reset", String(resetSeconds));

    if (window.count > options.max) {
      c.header("Retry-After", String(resetSeconds));
      options.onRejected?.(c, key);
      return c.json(
        {
          error: "rate_limited",
          message: `Too many requests to this Bazaar service. The limit is ${options.max} per ${Math.round(
            options.windowMs / 1000,
          )}s; retry in ${resetSeconds}s.`,
        },
        429,
      );
    }

    await next();
  };
}

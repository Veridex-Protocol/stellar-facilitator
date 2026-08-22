/**
 * Veridex Facilitator Service - Rate Limiting
 * License: Apache-2.0
 *
 * The facilitator pays real network fees out of its own account on every
 * settlement, so an unlimited `/settle` is an unlimited withdrawal from it. Cap
 * how fast anyone can make that happen.
 *
 * A fixed-window counter in process memory, deliberately: it is a few dozen
 * lines with no dependency and no supply-chain surface, and a single-process
 * facilitator has nowhere to share state anyway. A multi-instance deployment
 * should put a real limiter in front of this at the edge — this one then still
 * serves as the per-instance backstop.
 */

import type { Context, MiddlewareHandler, Next } from "hono";

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** Derives the bucket key; defaults to the client IP. */
  keyOf?: (c: Context) => string;
  /** Called when a request is rejected, for the outcome log. */
  onRejected?: (c: Context, key: string) => void;
}

interface Window {
  count: number;
  resetAt: number;
}

/**
 * Reads the client IP from proxy headers, falling back to the socket address.
 *
 * @param c - Request context
 * @returns A bucket key for this client
 */
function clientKey(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return (
    c.req.header("x-real-ip") ??
    (c.env as any)?.incoming?.socket?.remoteAddress ??
    "unknown"
  );
}

/**
 * Creates a fixed-window rate-limiting middleware.
 *
 * @param options - Window size, ceiling, and hooks
 * @returns A Hono middleware
 */
export function rateLimit(options: RateLimitOptions): MiddlewareHandler {
  const windows = new Map<string, Window>();
  const keyOf = options.keyOf ?? clientKey;

  // Windows are only created on request, so a periodic sweep is enough to keep
  // the map from growing with the client population over a long uptime.
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
          message: `Too many requests to this facilitator. The limit is ${options.max} per ${Math.round(
            options.windowMs / 1000,
          )}s; retry in ${resetSeconds}s.`,
        },
        429,
      );
    }

    await next();
  };
}

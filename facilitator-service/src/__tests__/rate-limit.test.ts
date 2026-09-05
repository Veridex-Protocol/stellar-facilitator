/**
 * Veridex Facilitator - Rate Limiting & Anti-Spoofing Tests
 * License: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { rateLimit, getClientIp } from "../rate-limit.js";

describe("Rate Limiting & Client IP Resolution (VDX-07)", () => {
  it("ignores spoofed X-Forwarded-For when no trusted proxies are configured", () => {
    const mockContext = (headers: Record<string, string>, socketIp = "198.51.100.5") =>
      ({
        req: {
          header: (name: string) => headers[name.toLowerCase()],
        },
        env: {
          incoming: {
            socket: {
              remoteAddress: socketIp,
            },
          },
        },
      } as any);

    // Attacker sends random X-Forwarded-For to evade rate limits
    const spoofedContext = mockContext({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }, "198.51.100.5");
    const ip = getClientIp(spoofedContext, 0);

    // Must resolve to the true socket IP, NOT the attacker's spoofed header
    expect(ip).toBe("198.51.100.5");
  });

  it("extracts correct client IP when trusted proxies are configured", () => {
    const mockContext = (headers: Record<string, string>, socketIp = "10.0.0.1") =>
      ({
        req: {
          header: (name: string) => headers[name.toLowerCase()],
        },
        env: {
          incoming: {
            socket: {
              remoteAddress: socketIp,
            },
          },
        },
      } as any);

    // 1 reverse proxy in front (e.g. Cloudflare / Nginx)
    // Client (203.0.113.195) -> Proxy -> Service
    // If client sent a spoofed header, proxy appended real client IP: "spoofed.ip, 203.0.113.195"
    const context = mockContext({ "x-forwarded-for": "1.1.1.1, 203.0.113.195" }, "10.0.0.1");
    const ip = getClientIp(context, 1);
    expect(ip).toBe("203.0.113.195");
  });

  it("enforces rate limits and returns 429 when max is exceeded", async () => {
    const app = new Hono();
    app.use(
      "*",
      rateLimit({
        windowMs: 60000,
        max: 3,
        keyOf: () => "test-client",
      })
    );
    app.get("/test", (c) => c.text("ok"));

    const res1 = await app.request("http://localhost/test");
    expect(res1.status).toBe(200);

    const res2 = await app.request("http://localhost/test");
    expect(res2.status).toBe(200);

    const res3 = await app.request("http://localhost/test");
    expect(res3.status).toBe(200);

    // 4th request exceeds max=3
    const res4 = await app.request("http://localhost/test");
    expect(res4.status).toBe(429);
    const body = await res4.json() as { error?: string };
    expect(body.error).toBe("rate_limited");
  });
});

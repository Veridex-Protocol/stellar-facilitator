/**
 * Veridex Bazaar - Rate Limiting & Anti-Spoofing Tests
 * License: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { rateLimit, getClientIp } from "../rate-limit.js";

describe("Bazaar Rate Limiting & Client IP Resolution (VDX-07)", () => {
  it("ignores spoofed X-Forwarded-For when no trusted proxies are configured", () => {
    const mockContext = (headers: Record<string, string>, socketIp = "198.51.100.99") =>
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

    const spoofedContext = mockContext({ "x-forwarded-for": "10.10.10.10, 11.11.11.11" }, "198.51.100.99");
    const ip = getClientIp(spoofedContext, 0);

    expect(ip).toBe("198.51.100.99");
  });

  it("enforces rate limits and returns 429 when max is exceeded", async () => {
    const app = new Hono();
    app.use(
      "*",
      rateLimit({
        windowMs: 60000,
        max: 2,
        keyOf: () => "bazaar-client",
      })
    );
    app.get("/discovery/search", (c) => c.text("ok"));

    const res1 = await app.request("http://localhost/discovery/search");
    expect(res1.status).toBe(200);

    const res2 = await app.request("http://localhost/discovery/search");
    expect(res2.status).toBe(200);

    const res3 = await app.request("http://localhost/discovery/search");
    expect(res3.status).toBe(429);
    const body = await res3.json();
    expect(body.error).toBe("rate_limited");
  });
});

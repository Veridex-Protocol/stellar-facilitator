/**
 * Veridex MCP Server - Security & SSRF Protection
 * License: Apache-2.0
 *
 * Implements strict URL validation, anti-SSRF protections, and spending ceiling
 * enforcement for agent tool calls.
 */

import { isIP } from "node:net";

export interface UrlValidationOptions {
  allowLocal?: boolean;
}

/**
 * Validates a resource URL to prevent SSRF and internal network scanning attacks.
 *
 * Blocks:
 * - Non-HTTP/HTTPS protocols
 * - Loopback and localhost addresses (127.0.0.0/8, ::1, localhost)
 * - Cloud metadata endpoints (169.254.169.254, metadata.google.internal, instance-data)
 * - Private RFC-1918 subnets (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
 * - IPv6 Unique Local / Link Local (fc00::/7, fe80::/10)
 * - Encoded integer/hexadecimal IP representations
 *
 * @param urlStr - The candidate resource URL string
 * @param options - Validation options
 * @returns Parsed safe URL instance
 * @throws {Error} If the URL violates SSRF safety rules
 */
export function validateSafeResourceUrl(
  urlStr: string,
  options: UrlValidationOptions = {},
): URL {
  if (!urlStr || typeof urlStr !== "string") {
    throw new Error("Invalid resource URL: URL must be a non-empty string");
  }

  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new Error(`Malformed resource URL: '${urlStr}'`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported protocol '${parsed.protocol}'. Resource URL must use http or https`);
  }

  // Allow explicit local bypass only when configured for test harnesses
  const allowLocal =
    options.allowLocal ??
    (process.env.MCP_ALLOW_LOCAL_URLS === "true" || process.env.NODE_ENV === "test");

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (allowLocal) {
    return parsed;
  }

  // 1. Block localhost and loopback domains
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname === "::1" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".lan") ||
    hostname.endsWith(".localdomain")
  ) {
    throw new Error(`SSRF Blocked: Resource URL targets local/internal host '${hostname}'`);
  }

  // 2. Block Cloud Instance Metadata endpoints
  if (
    hostname === "169.254.169.254" ||
    hostname === "metadata.google.internal" ||
    hostname === "instance-data"
  ) {
    throw new Error(`SSRF Blocked: Resource URL targets cloud instance metadata service`);
  }

  // 3. Block decimal/hex integer encoded IPs (e.g., 0x7f000001, 2130706433)
  if (/^(0x[0-9a-f]+|\d+)$/i.test(hostname)) {
    throw new Error(`SSRF Blocked: Resource URL contains encoded integer IP address`);
  }

  // 4. IP Literal checking
  const ipVersion = isIP(hostname);
  if (ipVersion === 4) {
    const parts = hostname.split(".").map((p) => parseInt(p, 10));
    const [b0, b1] = parts;

    // Loopback (127.0.0.0/8)
    if (b0 === 127) throw new Error("SSRF Blocked: Loopback IPv4 address");
    // Link-local / Cloud metadata (169.254.0.0/16)
    if (b0 === 169 && b1 === 254) throw new Error("SSRF Blocked: Link-local IPv4 address");
    // RFC 1918 Private: 10.0.0.0/8
    if (b0 === 10) throw new Error("SSRF Blocked: Private IPv4 subnet (10.0.0.0/8)");
    // RFC 1918 Private: 172.16.0.0/12
    if (b0 === 172 && b1 >= 16 && b1 <= 31) throw new Error("SSRF Blocked: Private IPv4 subnet (172.16.0.0/12)");
    // RFC 1918 Private: 192.168.0.0/16
    if (b0 === 192 && b1 === 168) throw new Error("SSRF Blocked: Private IPv4 subnet (192.168.0.0/16)");
    // Current network (0.0.0.0/8)
    if (b0 === 0) throw new Error("SSRF Blocked: Invalid source IPv4 address");
  } else if (ipVersion === 6) {
    // Loopback (::1)
    if (hostname === "::1" || hostname === "0:0:0:0:0:0:0:1") {
      throw new Error("SSRF Blocked: Loopback IPv6 address");
    }
    // Unique local (fc00::/7)
    if (/^f[cd][0-9a-f]{2}:/i.test(hostname)) {
      throw new Error("SSRF Blocked: Unique local IPv6 address");
    }
    // Link-local (fe80::/10)
    if (/^fe[89ab][0-9a-f]:/i.test(hostname)) {
      throw new Error("SSRF Blocked: Link-local IPv6 address");
    }
  }

  return parsed;
}

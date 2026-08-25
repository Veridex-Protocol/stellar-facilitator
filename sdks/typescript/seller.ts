/**
 * Veridex SDK - TypeScript Seller Helpers
 * License: Apache-2.0
 *
 * Helper functions for resource servers to declare Bazaar discovery metadata
 */

/**
 * Bazaar discovery metadata
 */
export interface BazaarMetadata {
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
  routeTemplate?: string;
  mimeType?: string;
  inputSpec: Record<string, any>;
  outputSpec?: Record<string, any>;
}

/**
 * Validation result
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Create Bazaar discovery metadata with automatic validation
 *
 * @param description - Service description
 * @param params - Metadata parameters
 * @returns Validated Bazaar metadata
 */
export function createBazaarMetadata(
  description: string,
  params: {
    serviceName?: string;
    tags?: string[];
    iconUrl?: string;
    routeTemplate?: string;
    mimeType?: string;
    inputSpec: Record<string, any>;
    outputSpec?: Record<string, any>;
  }
): BazaarMetadata {
  const metadata: BazaarMetadata = {
    serviceName: params.serviceName,
    tags: params.tags ? sanitizeTags(params.tags) : undefined,
    iconUrl: params.iconUrl,
    routeTemplate: params.routeTemplate,
    mimeType: params.mimeType || "application/json",
    inputSpec: params.inputSpec,
    outputSpec: params.outputSpec,
  };

  return metadata;
}

/**
 * Validate service name (printable ASCII, max 32 chars)
 *
 * @param serviceName - Service name to validate
 * @returns true if valid
 */
export function isValidServiceName(serviceName: string): boolean {
  if (serviceName.length > 32) {
    return false;
  }

  // Check for printable ASCII (0x20-0x7E)
  return /^[\x20-\x7e]+$/.test(serviceName);
}

/**
 * Sanitize tags array (printable ASCII, max 32 chars, max 5 tags, deduplicated)
 *
 * @param tags - Tags array
 * @returns Sanitized tags
 */
export function sanitizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const sanitized: string[] = [];

  for (const tag of tags) {
    // Skip if already seen (case-insensitive)
    const normalized = tag.toLowerCase();
    if (seen.has(normalized)) {
      continue;
    }

    // Validate printable ASCII and length
    if (/^[\x20-\x7e]+$/.test(tag) && tag.length <= 32) {
      sanitized.push(tag);
      seen.add(normalized);
    }

    // Max 5 tags
    if (sanitized.length >= 5) {
      break;
    }
  }

  return sanitized;
}

/**
 * Validate icon URL (no IP literals, localhost, decimal/hex IPs)
 *
 * @param iconUrl - Icon URL to validate
 * @returns true if valid
 */
export function isValidIconUrl(iconUrl: string): boolean {
  try {
    const url = new URL(iconUrl);

    // Reject IP literals
    if (/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)) {
      return false;
    }

    // Reject localhost and loopback
    if (["localhost", "ip6-loopback"].includes(url.hostname.toLowerCase())) {
      return false;
    }

    // Reject decimal/hex encoded IPs
    if (/^(0x[0-9a-f]+|\d+)$/i.test(url.hostname)) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Validate route template (no path traversal, no scheme injection)
 *
 * @param routeTemplate - Route template to validate
 * @returns true if valid
 */
export function isValidRouteTemplate(routeTemplate: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(routeTemplate);
  } catch {
    return false;
  }

  // Reject path traversal
  if (decoded.includes("..")) {
    return false;
  }

  // Reject URL scheme injection
  if (decoded.includes("://")) {
    return false;
  }

  return true;
}

/**
 * Validate complete Bazaar metadata
 *
 * @param metadata - Metadata to validate
 * @returns Validation result
 */
export function validateBazaarMetadata(metadata: BazaarMetadata): ValidationResult {
  const errors: string[] = [];

  // Validate serviceName
  if (metadata.serviceName && !isValidServiceName(metadata.serviceName)) {
    errors.push("serviceName must be printable ASCII and max 32 characters");
  }

  // Validate tags
  if (metadata.tags) {
    if (metadata.tags.length > 5) {
      errors.push("maximum 5 tags allowed");
    }
    for (const tag of metadata.tags) {
      if (!/^[\x20-\x7e]+$/.test(tag) || tag.length > 32) {
        errors.push(`invalid tag: ${tag}`);
      }
    }
  }

  // Validate iconUrl
  if (metadata.iconUrl && !isValidIconUrl(metadata.iconUrl)) {
    errors.push("iconUrl must not contain IP literals, localhost, or encoded IPs");
  }

  // Validate routeTemplate
  if (metadata.routeTemplate && !isValidRouteTemplate(metadata.routeTemplate)) {
    errors.push("routeTemplate must not contain path traversal (..) or scheme injection (://)");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

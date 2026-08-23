# Veridex Stellar x402 SDK - Multi-Language Helpers

**Version:** 0.1.0  
**License:** Apache-2.0  
**Languages:** TypeScript, Python, Go

---

## Overview

Multi-language SDK helpers for resource servers (sellers) to declare Bazaar discovery metadata and for buyers to interact with the x402 payment protocol on Stellar.

All SDKs implement the same validation rules and soft-drop sanitization logic to ensure compliance with the Bazaar catalog integrity requirements.

---

## TypeScript SDK

**Location:** `typescript/seller.ts`  
**Package:** `@veridex/stellar-sdk`  
**Installation:**

```bash
npm install @veridex/stellar-sdk
```

**Usage:**

```typescript
import {
  createBazaarMetadata,
  validateBazaarMetadata,
  sanitizeTags,
} from "@veridex/stellar-sdk";

const metadata = createBazaarMetadata("Weather API with real-time data", {
  serviceName: "OpenWeather Pro",
  tags: ["weather", "api", "real-time", "forecasts"],
  iconUrl: "https://example.com/icon.png",
  routeTemplate: "/api/weather/:city",
  inputSpec: {
    type: "object",
    properties: {
      city: { type: "string" },
      units: { type: "string", enum: ["metric", "imperial"] },
    },
    required: ["city"],
  },
  outputSpec: {
    type: "object",
    properties: {
      temperature: { type: "number" },
      conditions: { type: "string" },
    },
  },
});

const validation = validateBazaarMetadata(metadata);
if (!validation.valid) {
  console.error("Validation errors:", validation.errors);
}
```

---

## Python SDK

**Location:** `python/seller.py`  
**Package:** `veridex-stellar-sdk`  
**Installation:**

```bash
pip install veridex-stellar-sdk
```

**Usage:**

```python
from veridex_sdk.seller import (
    create_bazaar_metadata,
    validate_bazaar_metadata,
    sanitize_tags,
)

metadata = create_bazaar_metadata(
    description="Weather API with real-time data",
    input_spec={
        "type": "object",
        "properties": {
            "city": {"type": "string"},
            "units": {"type": "string", "enum": ["metric", "imperial"]},
        },
        "required": ["city"],
    },
    service_name="OpenWeather Pro",
    tags=["weather", "api", "real-time", "forecasts"],
    icon_url="https://example.com/icon.png",
    route_template="/api/weather/:city",
)

validation = validate_bazaar_metadata(metadata)
if not validation["valid"]:
    print("Validation errors:", validation["errors"])
```

---

## Go SDK

**Location:** `go/seller.go`  
**Package:** `github.com/veridex-protocol/veridex/stellar-sdk`  
**Installation:**

```bash
go get github.com/veridex-protocol/veridex/stellar-sdk
```

**Usage:**

```go
package main

import (
    "fmt"
    veridex "github.com/veridex-protocol/veridex/stellar-sdk"
)

func main() {
    metadata := veridex.CreateBazaarMetadata(
        "Weather API with real-time data",
        map[string]interface{}{
            "type": "object",
            "properties": map[string]interface{}{
                "city": map[string]string{"type": "string"},
                "units": map[string]interface{}{
                    "type": "string",
                    "enum": []string{"metric", "imperial"},
                },
            },
            "required": []string{"city"},
        },
        "OpenWeather Pro",
        []string{"weather", "api", "real-time", "forecasts"},
        "https://example.com/icon.png",
        "/api/weather/:city",
        "application/json",
        nil,
    )

    validation := veridex.ValidateBazaarMetadata(metadata)
    if !validation.Valid {
        fmt.Println("Validation errors:", validation.Errors)
    }
}
```

---

## Validation Rules

All SDKs enforce the following soft-drop validation rules:

### Service Name
- **Max Length:** 32 characters
- **Allowed Characters:** Printable ASCII only (`0x20-0x7E`)
- **Control Characters:** Rejected

### Tags
- **Max Count:** 5 tags
- **Max Length per Tag:** 32 characters
- **Allowed Characters:** Printable ASCII only
- **Deduplication:** Case-insensitive

### Icon URL
- **SSRF Protection:** Rejects IP literals (`192.168.1.1`, `::1`)
- **Loopback Protection:** Rejects `localhost`, `ip6-loopback`
- **Encoded IP Protection:** Rejects `0x7f000001`, `2130706433`
- **Schemes:** Must be `http://` or `https://`

### Route Template
- **Path Traversal:** Rejects `..` sequences
- **Scheme Injection:** Rejects `://` in decoded form
- **URL Encoding:** Must be valid percent-encoded

---

## API Reference

### Common Functions (All Languages)

#### `createBazaarMetadata()`
Creates a Bazaar metadata object with automatic sanitization.

**Parameters:**
- `description` (string): Service description
- `inputSpec` (object): JSON Schema for input parameters
- `serviceName` (string, optional): Service name
- `tags` (array, optional): Tags array
- `iconUrl` (string, optional): Icon URL
- `routeTemplate` (string, optional): Route template pattern
- `mimeType` (string, optional): Response MIME type (default: `application/json`)
- `outputSpec` (object, optional): JSON Schema for output

**Returns:** Metadata object

---

#### `validateBazaarMetadata()`
Validates metadata against all soft-drop rules.

**Parameters:**
- `metadata` (object): Metadata to validate

**Returns:** Validation result with `valid` (boolean) and `errors` (array)

---

#### `sanitizeTags()`
Sanitizes tags array (deduplication, ASCII validation, length limits).

**Parameters:**
- `tags` (array): Tags to sanitize

**Returns:** Sanitized tags array (max 5 items)

---

#### `isValidServiceName()`
Validates service name.

**Parameters:**
- `serviceName` (string): Service name

**Returns:** `true` if valid, `false` otherwise

---

#### `isValidIconUrl()`
Validates icon URL (SSRF protection).

**Parameters:**
- `iconUrl` (string): Icon URL

**Returns:** `true` if valid, `false` otherwise

---

#### `isValidRouteTemplate()`
Validates route template (path traversal protection).

**Parameters:**
- `routeTemplate` (string): Route template

**Returns:** `true` if valid, `false` otherwise

---

## Testing

Each SDK includes validation tests covering:
- ✅ Printable ASCII enforcement
- ✅ Length limit validation
- ✅ SSRF prevention (IP literals, localhost)
- ✅ Path traversal prevention
- ✅ Tag deduplication
- ✅ Control character rejection

---

## Contributing

Contributions welcome! Please ensure:
1. All validation rules remain synchronized across languages
2. Tests pass for all SDKs
3. Apache-2.0 license headers present
4. No dependencies added (keep SDKs lightweight)

---

## License

Apache License 2.0 - See [LICENSE](../../../LICENSE) for details

---

## Support

**Repository:** https://github.com/veridex-protocol/veridex  
**Issues:** https://github.com/veridex-protocol/veridex/issues  
**Email:** omoebun52@gmail.com

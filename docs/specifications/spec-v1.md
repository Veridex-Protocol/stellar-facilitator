# Veridex x402 Facilitator with Bazaar (Discovery) Support on Stellar
## Comprehensive Architecture Specification, Gap Analysis & RFP Implementation Plan

**Document Version:** 1.0.0  
**Target Networks:** `stellar:testnet`, `stellar:pubnet`  
**License:** Apache License 2.0 (OSI Approved)  
**Core Framework Component:** Veridex Agent Fabric (`veridex/` workspace)  
**Primary Deliverables:** Offchain Facilitator Service, Bazaar Discovery Index, Agent MCP Discovery Server, Upstream Stellar `upto` Payment Scheme, Multi-Language SDK Helpers, Conformance Test Suite, Security Review Readiness Report  

---

## Executive Summary & RFP Scope Deconstruction

This specification defines the complete architecture, gap analysis, smart contract design, and engineering implementation strategy to fulfill the **x402 Facilitator with Bazaar (Discovery) Support RFP** using the **Veridex** codebase as core infrastructure.

### Strategic Objectives & Core Outcomes

The RFP establishes three mandatory outcomes for the Stellar ecosystem:

1. **A Production-Ready, Non-Custodial Facilitator on `stellar:testnet` and `stellar:pubnet`**:
   Exposing standard wire endpoints (`/verify`, `/settle`, `/supported`), validating Soroban authorization entries strictly, sponsoring transaction network fees (`areFeesSponsored: true`), and remaining non-custodial across all settlement flows.

2. **Permissive OSI-Approved Licensing (Apache-2.0)**:
   Ensuring that the entire codebase and its transitive dependency graph are 100% permissively licensed. The ecosystem must not depend on a single hosted operator or be constrained by copyleft/AGPL dependencies (such as the OpenZeppelin Relayer).

3. **A Working Stellar Bazaar Discovery Layer**:
  Building a native, high-performance Bazaar discovery engine for Stellar. **This capability represents the highest-value deliverable in the RFP scope and carries the largest share of the budget allocation.** It enables MCP clients to dynamically discover, rank, search, and pay for x402-protected HTTP endpoints and MCP tools without pre-existing integration boilerplate.

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                VERIDEX X402 STELLAR STACK                               │
│                                                                                         │
│   ┌────────────────────────┐  ┌─────────────────────────┐  ┌────────────────────────┐   │
│   │  Facilitator Service   │  │  Bazaar Discovery Engine│  │  MCP Discovery Server  │   │
│   │  - POST /verify        │  │  - GET /discovery/res   │  │  - discover_resources  │   │
│   │  - POST /settle        │  │  - GET /discovery/search│  │  - pay_resource        │   │
│   │  - GET /supported      │  │  - Hybrid BM25+pgvector │  │  - 402 Loop Handling   │   │
│   └───────────┬────────────┘  └────────────┬────────────┘  └───────────┬────────────┘   │
└───────────────┼────────────────────────────┼───────────────────────────┼────────────────┘
                │                            │                           │
                ▼                            ▼                           ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                           UPSTREAM X402 FOUNDATION CORE & MECHANISMS                    │
│                                                                                         │
│   ┌────────────────────────┐  ┌─────────────────────────┐  ┌────────────────────────┐   │
│   │ @x402/stellar (Exact)  │  │ scheme_upto_stellar.md  │  │ Soroban upto_escrow.rs │   │
│   │ (Apache-2.0 Base)      │  │ (Upstream Spec)         │  │ (Smart Contract)       │   │
│   └────────────────────────┘  └─────────────────────────┘  └────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 1. Veridex Infrastructure Architectural Audit

A deep audit of the `veridex/` workspace confirms that Veridex already possesses production-grade foundational components for the x402 protocol, Bazaar metadata extraction, and Stellar exact payments.

### 1.1 Veridex Workspace Component Map

```
veridex/
├── x402/                                        # Canonical x402 Monorepo (Apache-2.0)
│   ├── typescript/packages/
│   │   ├── core/                                # Core protocol primitives & HTTP 402 parsing
│   │   ├── extensions/src/bazaar/               # Bazaar Discovery Extension Subsystem
│   │   │   ├── facilitator.ts                  # Schema validation, soft-drop rules, route templates
│   │   │   ├── facilitatorClient.ts            # Client query & filtering helpers
│   │   │   ├── server.ts                       # HTTP server declaration enricher
│   │   │   ├── mcp/resourceService.ts          # MCP tool discovery schemas
│   │   │   └── types.ts                        # Bazaar type definitions
│   │   └── mechanisms/stellar/src/              # Stellar Payment Mechanism
│   │       ├── exact/client/scheme.ts           # Exact Stellar payload builder & auth signer
│   │       └── exact/facilitator/scheme.ts      # ExactStellarScheme verification & settlement
├── packages/
│   ├── stellar-facilitator/                     # Veridex Stellar Facilitator Package
│   │   └── ARCHITECTURE.md                      # Facilitator architecture blueprint
│   ├── bazaar-service/                          # Dedicated Discovery Service Package
│   ├── sdk/src/chains/stellar/                  # Veridex SDK Passkey & Wallet Modules
│   │   ├── StellarPasskeySigner.ts             # Soroban auth entry passkey signer
│   │   └── VeridexStellarWalletModule.ts       # Veridex wallet interface for Stellar
│   └── agentic-payments/                        # Agentic Payment Automation Suite
```

### 1.2 Analysis of Exposed Veridex Code & Logic

#### 1.2.1 Facilitator Verification & Settlement Core
Veridex's Stellar mechanism [`ExactStellarScheme`](https://github.com/x402-foundation/x402/blob/main/typescript/packages/mechanisms/stellar/src/exact/facilitator/scheme.ts#L85-L146) implements the `SchemeNetworkFacilitator` interface:

```typescript
// Excerpt from x402/typescript/packages/mechanisms/stellar/src/exact/facilitator/scheme.ts
export class ExactStellarScheme implements SchemeNetworkFacilitator {
  readonly scheme = "exact";
  readonly caipFamily = STELLAR_WILDCARD_CAIP2;

  public readonly signingAddresses: ReadonlySet<string>;
  public readonly areFeesSponsored: boolean;
  public readonly rpcConfig?: RpcConfig;
  public readonly maxTransactionFeeStroops: number;
  public readonly feeBumpSigner?: FacilitatorStellarSigner;

  constructor(
    signers: FacilitatorStellarSigner[],
    options: { rpcConfig?: RpcConfig; areFeesSponsored?: boolean; feeBumpSigner?: FacilitatorStellarSigner } = {}
  ) {
    this.signerMap = new Map(signers.map(s => [s.address, s]));
    this.areFeesSponsored = options.areFeesSponsored ?? true;
    this.feeBumpSigner = options.feeBumpSigner;
  }
}
```

Key features present in `ExactStellarScheme`:
- **Soroban Auth Entry Signature Inspection**: Uses [`gatherAuthEntrySignatureStatus`](https://github.com/x402-foundation/x402/blob/main/typescript/packages/mechanisms/stellar/src/shared.ts) to verify that Soroban auth entries are signed correctly.
- **Simulation-Based Fee & Resource Estimation**: Invokes Soroban RPC `simulateTransaction` to verify transaction validity, compute exact CPU/memory instruction limits, and enforce `maxTransactionFeeStroops`.
- **Fee Bump Sponsorship**: Decouples fee payment from sequence numbers by wrapping inner transactions in a `FeeBumpTransaction` signed by `feeBumpSigner`.
- **Signer Rotation**: Uses round-robin selection across a pool of channel accounts (`roundRobinSelectSigner`) to support concurrent transactions.

#### 1.2.2 Bazaar Extension & Integrity Engine
Veridex's Bazaar implementation [`facilitator.ts`](https://github.com/x402-foundation/x402/blob/main/typescript/packages/extensions/src/bazaar/facilitator.ts#L1-L120) enforces validation rules to prevent catalog poisoning:

```typescript
// Excerpt from x402/typescript/packages/extensions/src/bazaar/facilitator.ts
export function isValidRouteTemplate(value: string | undefined): value is string {
  if (!value) return false;
  if (!ROUTE_TEMPLATE_REGEX.test(value)) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return false;
  }
  if (decoded.includes("..")) return false; // Rejects path traversal
  if (decoded.includes("://")) return false; // Rejects URL injection
  return true;
}
```

Metadata soft-drop protections in Veridex include:
- **`serviceName`**: Constrained to printable ASCII (`^[\x20-\x7e]+$`), length $\le 32$ chars, zero control characters.
- **`tags`**: Max 5 array items, max 32 chars each, printable ASCII, case-insensitively deduplicated.
- **`iconUrl`**: Parsed via absolute `http://` / `https://` URL rules, rejecting IP literals (v4/v6), loopback hostnames (`localhost`, `ip6-loopback`), decimal/hex IP encodings (`2130706433`, `0x7f000001`), and userinfo credentials (`user@`).
- **`EXTENSION-RESPONSES` Header**: Encodes cataloging result (`success`, `processing`, `rejected` with `rejectedReason`) in base64.

---

## 2. Comprehensive Gap Analysis & RFP Compliance Matrix

| Requirement | RFP Section | Veridex Support | Existing Code Evidence | Required Gap Remediation |
|---|---|---|---|---|
| **Facilitator Endpoints** | 3.1 | Full | `ExactStellarScheme` in [`scheme.ts`](https://github.com/x402-foundation/x402/blob/main/typescript/packages/mechanisms/stellar/src/exact/facilitator/scheme.ts#L85) | Package as standalone Hono/Fastify HTTP server |
| **Auth Entry Validation** | 3.1 | Full | `gatherAuthEntrySignatureStatus` in [`shared.ts`](https://github.com/x402-foundation/x402/blob/main/typescript/packages/mechanisms/stellar/src/shared.ts) | Add `__check_auth` custom account simulation validation |
| **Fee Sponsorship** | 3.1 | Full | `feeBumpSigner` in `ExactStellarScheme` | Expose `areFeesSponsored: true` in `/supported` |
| **Bazaar Catalog Browsing** | 3.2 | Partial | `listResources` in [`facilitatorClient.ts`](https://github.com/x402-foundation/x402/blob/main/typescript/packages/extensions/src/bazaar/facilitatorClient.ts) | Build persistent PostgreSQL store with filtering |
| **Bazaar Search** | 3.2 | Partial | In-memory filter in [`facilitatorClient.ts`](https://github.com/x402-foundation/x402/blob/main/typescript/packages/extensions/src/bazaar/facilitatorClient.ts) | **Build PostgreSQL + pgvector RRF natural language search** |
| **Auto Cataloging & Soft Drop** | 3.2 | Full | `extractDiscoveryInfo`, `isValidRouteTemplate` in [`facilitator.ts`](https://github.com/x402-foundation/x402/blob/main/typescript/packages/extensions/src/bazaar/facilitator.ts) | Wire automatic DB catalog ingestion pipeline |
| **MCP Tool Cataloging** | 3.2 | Full | MCP resource types in [`resourceService.ts`](https://github.com/x402-foundation/x402/blob/main/typescript/packages/extensions/src/bazaar/mcp/resourceService.ts) | Index compound unique key `(resource.url, input.toolName)` |
| **MCP Server for Agents** | 3.3 | Partial | Resource definitions in [`resourceService.ts`](https://github.com/x402-foundation/x402/blob/main/typescript/packages/extensions/src/bazaar/mcp/resourceService.ts) | **Build standalone MCP server (`discover_resources`, `pay_resource`)** |
| **Stellar `exact` Scheme** | 3.4 | Full | `@x402/mechanisms/stellar` | Maintain alignment with wire spec |
| **Stellar `upto` Scheme** | 3.4 | None | `upto` exists for EVM in `x402/typescript/packages/mechanisms/evm/src/upto` | **Author `scheme_upto_stellar.md` & build Soroban contract `upto_escrow.rs`** |
| **Channel Accounts** | 3.5 | Partial | `roundRobinSelectSigner` in [`scheme.ts`](https://github.com/x402-foundation/x402/blob/main/typescript/packages/mechanisms/stellar/src/exact/facilitator/scheme.ts#L45) | Build automated channel account pool manager |
| **Licensing** | 3.6 | Full | `@x402/*` packages (Apache-2.0) | **Audit & eliminate any OpenZeppelin AGPL dependencies** |
| **Conformance & Audit** | 3.6 | Partial | E2E framework in `x402/e2e` | Run canonical test suite & prepare security audit package |

---

## 3. Stellar Bazaar Discovery Engine Specification

The Bazaar Discovery Engine represents the highest-value deliverable. It indexes x402-enabled endpoints and MCP tools automatically during payment settlement and exposes high-performance browsing and natural language search APIs.

```
                                  BAZAAR INGESTION & SEARCH ARCHITECTURE

┌──────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                        AUTOMATIC INGESTION WORKER                                        │
│                                                                                                          │
│   PaymentPayload ──► Bazaar Extension ──► Soft-Drop Sanitizer ──► Text Embedding ──► PostgreSQL + pgvector│
│                      (schema check)       (serviceName, tags,     (1536-dim model)   (catalog_resources)    │
│                                           iconUrl, routeTemplate)                                        │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                       NATURAL LANGUAGE SEARCH PIPELINE                                   │
│                                                                                                          │
│   GET /discovery/search?query="weather data under 0.01 USDC"                                            │
│                              │                                                                           │
│               ┌──────────────┴──────────────┐                                                            │
│               ▼                             ▼                                                            │
│       BM25 Keyword Search          Vector Cosine Distance                                                │
│       (Full-Text Index)            (pgvector IVFFLAT Index)                                              │
│               │                             │                                                            │
│               └──────────────┬──────────────┘                                                            │
│                              ▼                                                                           │
│                Reciprocal Rank Fusion (RRF)                                                              │
│                              │                                                                           │
│                              ▼                                                                           │
│           Paginated JSON Response + partialResults Flag                                                  │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Database DDL Schema (`@veridex/bazaar-service`)

```sql
-- Enable necessary PostgreSQL extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- Primary catalog table for HTTP endpoints and MCP tools
CREATE TABLE catalog_resources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    resource_url TEXT NOT NULL,
    resource_type VARCHAR(16) NOT NULL CHECK (resource_type IN ('http', 'mcp')),
    tool_name VARCHAR(64), -- NULL for HTTP resources, populated for MCP tools
    service_name VARCHAR(32),
    description TEXT NOT NULL,
    mime_type VARCHAR(64) DEFAULT 'application/json',
    pay_to VARCHAR(56) NOT NULL, -- Stellar G-address
    network VARCHAR(64) NOT NULL, -- e.g. stellar:pubnet, stellar:testnet
    scheme VARCHAR(32) NOT NULL,  -- e.g. exact, upto
    tags TEXT[] DEFAULT '{}',
    icon_url VARCHAR(2048),
    route_template TEXT,
    input_spec JSONB NOT NULL,
    output_spec JSONB,
    extensions JSONB NOT NULL DEFAULT '{}',
    embedding vector(1536), -- Vector embedding generated via text-embedding-3-small
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Compound uniqueness constraint: (resource_url, COALESCE(tool_name, ''))
    CONSTRAINT unique_resource_tool_entry UNIQUE (resource_url, tool_name)
);

-- Performance Indexes
CREATE INDEX idx_resources_embedding ON catalog_resources USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX idx_resources_trgm ON catalog_resources USING gin (description gin_trgm_ops);
CREATE INDEX idx_resources_filter ON catalog_resources (resource_type, pay_to, network, scheme);
CREATE INDEX idx_resources_tags ON catalog_resources USING gin (tags);
```

### 3.2 Hybrid Natural Language Search Query

To fulfill Section 3.2's search quality requirement, the facilitator implements **Reciprocal Rank Fusion (RRF)** combining BM25 keyword matching with vector cosine distance:

```sql
WITH keyword_search AS (
    SELECT id, 
           RANK() OVER (ORDER BY ts_rank_cd(to_tsvector('english', description || ' ' || COALESCE(service_name, '')), plainto_tsquery('english', $1)) DESC) AS rank
    FROM catalog_resources
    WHERE to_tsvector('english', description || ' ' || COALESCE(service_name, '')) @@ plainto_tsquery('english', $1)
    LIMIT 50
),
vector_search AS (
    SELECT id, 
           RANK() OVER (ORDER BY embedding <=> $2::vector) AS rank
    FROM catalog_resources
    ORDER BY embedding <=> $2::vector
    LIMIT 50
)
SELECT r.id, r.resource_url, r.resource_type, r.tool_name, r.service_name, 
       r.description, r.pay_to, r.network, r.scheme, r.tags, r.icon_url, 
       r.route_template, r.input_spec, r.output_spec,
       COALESCE(1.0 / (60 + k.rank), 0.0) + COALESCE(1.0 / (60 + v.rank), 0.0) AS rrf_score
FROM catalog_resources r
LEFT JOIN keyword_search k ON r.id = k.id
LEFT JOIN vector_search v ON r.id = v.id
WHERE k.id IS NOT NULL OR v.id IS NOT NULL
ORDER BY rrf_score DESC
LIMIT $3 OFFSET $4;
```

---

## 4. Stellar `upto` Settlement Scheme Specification

Section 3.4 mandates authoring `scheme_upto_stellar.md` and implementing a Soroban smart contract (`upto_escrow.rs`) enforcing the 5 core `upto` properties natively on Stellar.

### 4.1 The 5 Core Properties of Stellar `upto`

1. **Maximum Cap Enforcement ($A \le M$)**: The buyer authorizes up to maximum amount $M$; the facilitator settles the actual usage amount $A$, enforcing $A \le M$.
2. **Recipient Binding**: The payment $A$ can only be delivered to the exact `payTo` account declared in the initial authorization.
3. **Single Settlement Lock**: The payment authorization can be consumed exactly once. Replay attempts are rejected on-chain.
4. **Unspent Refundability**: The remaining balance $(M - A)$ is never locked or escrowed; buyer funds remain unencumbered.
5. **Expired Refundability**: If unsettled prior to `signatureExpirationLedger`, the authorization expires without requiring any manual claim transaction.

---

### 4.2 Complete Soroban Smart Contract Implementation (`upto_escrow.rs`)

Below is the complete Rust implementation for the Soroban `upto` settlement contract:

```rust
//! Soroban Upto Escrow & Settlement Contract for x402
//! Package: contracts/upto-settlement/src/lib.rs
//! License: Apache-2.0

#![no_std]
use soroban_sdk::{
    contract, contracterror, contractimpl, symbol_short, token, Address, BytesN, Env, Symbol,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum UptoError {
    AlreadyInitialized = 1,
    AuthorizationExpired = 2,
    AmountExceedsMaxCap = 3,
    InvalidAmount = 4,
    NonceAlreadyUsed = 5,
    UnauthorizedFacilitator = 6,
}

const STORAGE_KEY_ADMIN: Symbol = symbol_short!("ADMIN");

#[contract]
pub struct UptoEscrowContract;

#[contractimpl]
impl UptoEscrowContract {
    /// Initializes the contract with an admin address.
    pub fn initialize(env: Env, admin: Address) -> Result<(), UptoError> {
        if env.storage().instance().has(&STORAGE_KEY_ADMIN) {
            return Err(UptoError::AlreadyInitialized);
        }
        env.storage().instance().set(&STORAGE_KEY_ADMIN, &admin);
        Ok(())
    }

    /// Settles an authorized `upto` payment.
    ///
    /// # Arguments
    /// * `buyer` - The account authorizing the payment (signs auth entry)
    /// * `recipient` - The designated payTo recipient
    /// * `token` - The SEP-41 token contract address (e.g. USDC)
    /// * `max_amount` - The maximum authorized spending cap (M)
    /// * `actual_amount` - The actual metered usage amount to settle (A)
    /// * `nonce` - Unique payment authorization identifier
    /// * `deadline_ledger` - Expiration ledger sequence number
    pub fn settle_upto(
        env: Env,
        buyer: Address,
        recipient: Address,
        token: Address,
        max_amount: i128,
        actual_amount: i128,
        nonce: i128,
        deadline_ledger: u32,
    ) -> Result<(), UptoError> {
        // 1. Enforce Buyer Authorization (Soroban Auth Entry Signature)
        buyer.require_auth();

        // 2. Validate Ledger Expiration Deadline
        if env.ledger().sequence() > deadline_ledger {
            return Err(UptoError::AuthorizationExpired);
        }

        // 3. Validate Amount Bounds: 0 < actual_amount <= max_amount
        if actual_amount <= 0 {
            return Err(UptoError::InvalidAmount);
        }
        if actual_amount > max_amount {
            return Err(UptoError::AmountExceedsMaxCap);
        }

        // 4. Single Settlement Check (Replay Prevention)
        let nonce_key = (buyer.clone(), nonce);
        if env.storage().persistent().has(&nonce_key) {
            return Err(UptoError::NonceAlreadyUsed);
        }

        // Mark Nonce as Consumed (TTL aligned with ledger expiration)
        env.storage().persistent().set(&nonce_key, &true);

        // 5. Execute On-Chain Transfer of Actual Amount
        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&buyer, &recipient, &actual_amount);

        // 6. Emit Audit Event
        env.events().publish(
            (symbol_short!("settle"), buyer, recipient),
            (token, actual_amount, max_amount, nonce),
        );

        Ok(())
    }
}
```

---

## 5. MCP Discovery Server Specification

Section 3.3 requires an MCP server through which compatible clients can discover resources and execute 402 payments.

### 5.1 MCP Server Package Architecture (`@veridex/mcp-discovery-server`)

The server connects to MCP clients via Stdio or Streamable HTTP / SSE transports:

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export class VeridexMcpDiscoveryServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      { name: "veridex-mcp-discovery", version: "1.0.0" },
      { capabilities: { tools: {} } }
    );
    this.setupToolHandlers();
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "discover_resources",
          description: "Search the Stellar Bazaar for x402 paid APIs and MCP tools using natural language.",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "Free-text search query" },
              type: { type: "string", enum: ["http", "mcp"] },
              network: { type: "string", default: "stellar:pubnet" }
            },
            required: ["query"]
          }
        },
        {
          name: "pay_resource",
          description: "Execute an HTTP call to an x402-protected endpoint, automatically handling the 402 payment challenge and settlement.",
          inputSchema: {
            type: "object",
            properties: {
              url: { type: "string", description: "Target resource URL" },
              method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE"], default: "GET" },
              params: { type: "object", description: "Request query parameters or body" },
              maxAmount: { type: "string", description: "Maximum authorized asset payment amount in stroops" }
            },
            required: ["url"]
          }
        }
      ]
    }));
  }
}
```

---

## 6. Multi-Language SDK & Helper Libraries

Section 3.2 and 3.5 require seller metadata helpers and buyer discovery/payment libraries across TypeScript, Python, and Go.

### 6.1 TypeScript Helper Implementation

```typescript
// Package: @veridex/sdk/seller
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";

export function createBazaarSellerMetadata(params: {
  serviceName: string;
  tags: string[];
  iconUrl?: string;
  routeTemplate?: string;
}) {
  return declareDiscoveryExtension({
    serviceName: params.serviceName,
    tags: params.tags,
    iconUrl: params.iconUrl,
    routeTemplate: params.routeTemplate
  });
}
```

### 6.2 Python Helper Implementation

```python
# Package: veridex_sdk/seller.py
import re
from typing import List, Optional, Dict, Any

class BazaarSellerHelper:
    @staticmethod
    def create_discovery_metadata(
        service_name: str,
        tags: List[str],
        icon_url: Optional[str] = None,
        route_template: Optional[str] = None
    ) -> Dict[str, Any]:
        # Enforce printable ASCII & soft-drop constraints
        sanitized_name = service_name if re.match(r"^[\x20-\x7e]+$", service_name) and len(service_name) <= 32 else None
        sanitized_tags = [t for t in tags if re.match(r"^[\x20-\x7e]+$", t) and len(t) <= 32][:5]
        
        return {
            "serviceName": sanitized_name,
            "tags": sanitized_tags,
            "iconUrl": icon_url,
            "routeTemplate": route_template
        }
```

### 6.3 Go Helper Implementation

```go
// Package: veridex/seller
package seller

import (
	"regexp"
)

type BazaarMetadata struct {
	ServiceName   string   `json:"serviceName,omitempty"`
	Tags          []string `json:"tags,omitempty"`
	IconURL       string   `json:"iconUrl,omitempty"`
	RouteTemplate string   `json:"routeTemplate,omitempty"`
}

var printableASCII = regexp.MustCompile(`^[\x20-\x7e]+$`)

func CreateDiscoveryMetadata(serviceName string, tags []string, iconURL string, routeTemplate string) BazaarMetadata {
	var validName string
	if len(serviceName) <= 32 && printableASCII.MatchString(serviceName) {
		validName = serviceName
	}

	var validTags []string
	for _, t := range tags {
		if len(t) <= 32 && printableASCII.MatchString(t) {
			validTags = append(validTags, t)
			if len(validTags) == 5 {
				break
			}
		}
	}

	return BazaarMetadata{
		ServiceName:   validName,
		Tags:          validTags,
		IconURL:       iconURL,
		RouteTemplate: routeTemplate,
	}
}
```

---

## 7. Stellar Operational & Throughput Architecture

### 7.1 Sequence Bottlenecks & Channel Account Pool

Agent traffic is bursty. On Stellar, submitting multiple transactions concurrently from a single account results in sequence number collisions. The facilitator avoids this by maintaining a **Channel Account Pool**:

```
                               CHANNEL ACCOUNT POOL MANAGEMENT

┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                   FACILITATOR POOL MANAGER                              │
│                                                                                         │
│     Channel #1 (GA1...) ──► Idle ──► Selected for Tx A ──► Sequence N+1 ──► Submitted   │
│     Channel #2 (GB2...) ──► Idle ──► Selected for Tx B ──► Sequence M+1 ──► Submitted   │
│     Channel #3 (GC3...) ──► Busy (Awaiting Ledger Close) ──► Returned to Idle Pool    │
│     ...                                                                                 │
│     Channel #50 (GZ50..) ──► Auto-Replenish XLM Balance when < 5.0 XLM                   │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

Implementation logic in `@veridex/stellar-facilitator`:
- Pool maintains 50 pre-funded channel keypairs.
- Round-robin selection leases an idle channel account per settlement transaction.
- Inner transactions are signed by the leased channel keypair (managing sequence numbers).
- Outer transactions are wrapped in a `FeeBumpTransaction` signed by the facilitator fee account (sponsoring network fees).

---

## 8. Licensing, Security, and Audit Readiness

### 8.1 License Continuity & AGPL Elimination

Section 3.6 strictly prohibits AGPL dependencies. Veridex guarantees compliance through:
1. **Direct Dependency Audit**: All core dependencies (`@x402/core`, `@x402/stellar`, `@stellar/stellar-sdk`) operate under the permissive **Apache License 2.0**.
2. **AGPL Removal**: Complete removal of legacy OpenZeppelin Relayer components.
3. **CI License Guard**: Automated CI step utilizing `license-checker` to fail builds if copyleft licenses (`AGPL-3.0`, `GPL-3.0`, `GPL-2.0`) are detected in transitive node modules.

### 8.2 Threat Model & Mitigation Matrix

| Threat Vector | Risk Description | Mitigation Mechanism in Veridex |
|---|---|---|
| **Catalog Poisoning (TPA)** | Malicious client submits hostile metadata or forged `routeTemplate` to hijack catalog traffic | Strict soft-drop validation in [`facilitator.ts`](https://github.com/x402-foundation/x402/blob/main/typescript/packages/extensions/src/bazaar/facilitator.ts): percent-decodes before path traversal (`..`) & scheme checks (`://`) |
| **SSRF via `iconUrl`** | Hostile seller submits local IP or loopback URL to scan facilitator internal networks | `isValidIconUrl` rejects IP literals (v4/v6), `localhost`, decimal/hex IP encodings, and loopback hostnames |
| **Auth Entry Replay** | Attacker intercepts and resubmits signed Soroban auth entry | Ledger-bounded expiration (`signatureExpirationLedger` window) + contract nonce tracking in `upto_escrow.rs` |
| **Confused Deputy** | Agent tricked into calling unapproved privileged resource | Strict recipient binding (`payTo` validation) and spending caps enforced in MCP proxy |

---

## 9. Phased Implementation Roadmap & Deliverable Schedule

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                PHASED IMPLEMENTATION TIMELINE                            │
│                                                                                         │
│  PHASE 1: Bazaar Engine & Search Index (Weeks 1 - 3) [LARGEST BUDGET ALLOCATION]        │
│  - PostgreSQL + pgvector schema, RRF Hybrid Search Engine, Auto-Cataloging worker      │
│                                                                                         │
│  PHASE 2: Facilitator Core & Stellar Parity (Weeks 3 - 4)                               │
│  - Standalone Hono server, Channel Account Pool manager, Fee bump sponsorship           │
│                                                                                         │
│  PHASE 3: Upstream Stellar `upto` Scheme & Soroban Escrow (Weeks 5 - 6)                │
│  - Author scheme_upto_stellar.md, compile & test upto_escrow.rs on Soroban testnet      │
│                                                                                         │
│  PHASE 4: Agent MCP Discovery Server & Multi-Language SDKs (Weeks 7 - 8)                │
│  - Build @veridex/mcp-discovery-server, TS/Python/Go seller & buyer SDK helpers        │
│                                                                                         │
│  PHASE 5: Conformance, E2E Verification & Security Audit (Weeks 9 - 10)                 │
│  - Stock x402 client verification, mainnet/testnet deployment, third-party audit       │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 10. Implementation Checklist

1. Base all Stellar transaction handling on @x402/stellar and @stellar/stellar-sdk (Apache-2.0). Ensure zero AGPL dependencies exist in package.json.
2. Implement @veridex/bazaar-service using PostgreSQL + pgvector. Enforce soft-drop rules in x402/typescript/packages/extensions/src/bazaar/facilitator.ts (isValidServiceName, sanitizeTags, isValidIconUrl, isValidRouteTemplate).
3. Build GET /discovery/resources and GET /discovery/search with RRF hybrid search (BM25 + cosine similarity). Return EXTENSION-RESPONSES base64 headers on /verify and /settle.
4. Author scheme_upto_stellar.md and build the Soroban upto_escrow.rs smart contract enforcing single settlement and max cap.
5. Create @veridex/mcp-discovery-server exposing discover_resources and pay_resource tools to MCP clients.
6. Verify wire-level conformance using an unmodified canonical x402 client on stellar:testnet and stellar:pubnet with extra.areFeesSponsored = true.

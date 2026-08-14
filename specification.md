# Veridex x402 Facilitator with P2P Federated Bazaar Discovery & Telemetry-Ranked Search on Stellar
## Proposal & Comprehensive Architecture Specification (v2.0.0)

**Document Version:** 2.0.0  
**Status:** Proposal for Maintainers & Technical Steering Committee  
**Target Networks:** `stellar:testnet`, `stellar:pubnet`  
**License:** Apache License 2.0 (OSI Approved)  
**New v2 Features:** P2P Libp2p Federated Relayer Mesh, Active Node Heartbeat Ping Protocol, Telemetry-Enriched Composite Quality Ranking, Distributed Multi-Facilitator Catalog Gossip, Real-Time Liveness Circuit Breakers  

---

## Executive Summary & Proposal Overview

This document presents **Version 2.0 of the Architecture Specification & Grant Proposal** for the **x402 Facilitator with Bazaar (Discovery) Support RFP** on Stellar. 

While v1.0 established a solid foundation with standard REST endpoints, Soroban auth entry validation, and passive database cataloging, **Version 2.0 introduces a paradigm shift in x402 discovery: a P2P Federated Relayer Mesh with Active Node Heartbeats and Telemetry-Enriched Dynamic Ranking.**

### Core v2 Innovations Offered to Maintainers

1. **Active P2P Node Discovery & Heartbeat Protocol (`/x402/bazaar/v1/announce`)**:
   Resource servers and micro-facilitators no longer rely exclusively on passive payment-triggered indexing. They actively join a `js-libp2p` GossipSub mesh, broadcasting signed liveness pings and metadata announcements upon startup.

2. **Telemetry-Enriched Composite Ranking Algorithm**:
   Search results are no longer ranked purely by static text matching. The search engine computes a multi-dimensional composite score combining natural-language semantic vector similarity (BM25 + `pgvector`), real-time ping latency, peer uptime history, and verified settlement success rates.

3. **Decentralized Multi-Facilitator Catalog Mesh**:
   Fulfills Section 3.2's mandate to avoid turning Stellar discovery into a "walled garden." Independent facilitators gossip verified catalog blocks peer-to-peer, keeping catalog listings synchronized across the ecosystem without centralized database lock-in.

4. **Liveness Circuit Breakers & Auto-Pruning**:
   Dead, offline, or unresponsive endpoints are automatically demoted and soft-dropped after missing consecutive heartbeat windows, protecting AI agents from attempting calls to broken APIs.

```
                                  VERIDEX V2 P2P BAZAAR ARCHITECTURE

┌──────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                       P2P FEDERATED RELAYER MESH                                         │
│                                                                                                          │
│   ┌────────────────────────┐         GossipSub Announce / Heartbeat         ┌────────────────────────┐   │
│   │ Resource Server / Node ├───────────────────────────────────────────────►│ Veridex Relayer Peer A │   │
│   └────────────────────────┘                                                └───────────┬────────────┘   │
│                                                                                         │                │
│                                                                             Libp2p Mesh │ GossipSync     │
│                                                                                         ▼                │
│   ┌────────────────────────┐         Telemetry & Settlement Proofs          ┌────────────────────────┐   │
│   │   AI Agent / Buyer     ├───────────────────────────────────────────────►│ Veridex Relayer Peer B │   │
│   └────────────────────────┘                                                └───────────┬────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────────────┼────────────────┘
                                                                                          │
                                                                                          ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                 TELEMETRY-ENRICHED SEARCH ENGINE                                         │
│                                                                                                          │
│         Composite Score = w1(Vector Similarity) + w2(BM25 Text) + w3(Node Uptime) +                      │
│                           w4(Low Latency) + w5(SuccessRate)                                              │
│                                                                                                          │
│   - Real-Time Liveness Circuit Breakers    - Automatic Unresponsive Node Pruning                         │
│   - PostgreSQL + pgvector Catalog Store    - MCP Discovery Server Interface                              │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 1. Veridex Infrastructure Baseline & Audit

Veridex provides an ideal production base. Its existing codebase already supplies core x402 primitives, Stellar exact settlement logic, JSON Schema Draft 2020-12 extension validation, and soft-drop catalog rules.

### 1.1 Existing Veridex Code References

- **Exact Facilitator Mechanism**: [`ExactStellarScheme`](https://github.com/x402-foundation/x402/blob/main/typescript/packages/mechanisms/stellar/src/exact/facilitator/scheme.ts#L85-L146) implements Soroban simulation, auth entry validation, round-robin channel account rotation, and `FeeBumpTransaction` fee sponsorship.
- **Soroban Auth Entry Signature Inspection**: [`gatherAuthEntrySignatureStatus`](https://github.com/x402-foundation/x402/blob/main/typescript/packages/mechanisms/stellar/src/shared.ts) inspects and verifies Soroban authorization signatures.
- **Bazaar Extension Parser & Integrity Engine**: [`facilitator.ts`](https://github.com/x402-foundation/x402/blob/main/typescript/packages/extensions/src/bazaar/facilitator.ts#L1-L120) implements [`isValidRouteTemplate`](https://github.com/x402-foundation/x402/blob/main/typescript/packages/extensions/src/bazaar/facilitator.ts#L53), printable ASCII checks, and soft-drop rules for `serviceName`, `tags`, and `iconUrl` SSRF/IP/loopback protections.
- **Client Query Helpers**: [`facilitatorClient.ts`](https://github.com/x402-foundation/x402/blob/main/typescript/packages/extensions/src/bazaar/facilitatorClient.ts) exports catalog query and list primitives.

---

## 2. Requirement & Gap Mapping Matrix (v1 vs v2)

| RFP Requirement | RFP Section | Veridex v1 Baseline | Veridex v2 Proposal | Implementation Mechanism |
|---|---|---|---|---|
| **Facilitator Endpoints** | 3.1 | Standard `/verify`, `/settle`, `/supported` | Standard REST + **WebSocket P2P Telemetry Channel** | Fastify/Hono HTTP + `ws` WebSocket |
| **Auth Entry Validation** | 3.1 | `gatherAuthEntrySignatureStatus` | Enhanced with custom `__check_auth` simulation | Soroban RPC RPC simulateTransaction |
| **Fee Sponsorship** | 3.1 | `feeBumpSigner` in `ExactStellarScheme` | Sponsored via `FeeBumpTransaction` | Advertises `areFeesSponsored: true` |
| **Bazaar Catalog Browsing** | 3.2 | In-memory filtering | **PostgreSQL Persistent Store + P2P Mesh Sync** | Federated Libp2p GossipSub |
| **Bazaar Search Quality** | 3.2 | In-memory text match | **Hybrid BM25/Vector Search + Live Telemetry Scoring** | `pgvector` RRF + Telemetry Engine |
| **Auto Cataloging** | 3.2 | Passive indexing via `PaymentPayload` | **Dual-Path: Passive Indexing + Active P2P Announce** | `/x402/bazaar/v1/announce` topic |
| **Node Liveness & Health** | 3.2 | None (Static entries) | **Active Heartbeat Ping + Pruning Circuit Breakers** | 30s Heartbeat pings & auto-demotion |
| **MCP Server for Agents** | 3.3 | Basic schemas | **Standalone MCP Server (`discover_resources`, `pay_resource`)** | Model Context Protocol Stdio/HTTP |
| **Stellar `upto` Scheme** | 3.4 | EVM `upto` only | **Author `scheme_upto_stellar.md` & `upto_escrow.rs`** | Soroban Rust Smart Contract |
| **Interoperability** | 3.2 & 3.6 | Single-facilitator catalog | **P2P Multi-Facilitator Federated Mesh** | Libp2p Kademlia DHT + GossipSub |
| **Licensing** | 3.6 | Apache-2.0 core | **100% Permissive Apache-2.0 across full P2P stack** | Zero AGPL dependencies |

---

## 3. Detailed P2P Federated Bazaar Discovery Engine

### 3.1 P2P Node Announcement & Heartbeat Protocol

Resource servers and peer facilitators communicate over a dedicated `js-libp2p` topic `/x402/bazaar/v1/announce`.

#### 3.1.1 Heartbeat Payload Specification (JSON Schema)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "nodeId": { "type": "string", "description": "Peer ID or Stellar G-address" },
    "resourceUrl": { "type": "string", "format": "uri" },
    "toolName": { "type": "string" },
    "timestamp": { "type": "integer", "description": "Epoch timestamp in milliseconds" },
    "sequence": { "type": "integer" },
    "telemetry": {
      "type": "object",
      "properties": {
        "avgResponseTimeMs": { "type": "number" },
        "uptime30d": { "type": "number", "minimum": 0, "maximum": 100 },
        "successfulSettlements": { "type": "integer" }
      },
      "required": ["avgResponseTimeMs", "uptime30d"]
    },
    "signature": { "type": "string", "description": "Ed25519 signature over (resourceUrl + timestamp + sequence)" }
  },
  "required": ["nodeId", "resourceUrl", "timestamp", "sequence", "telemetry", "signature"]
}
```

### 3.2 Telemetry-Enriched Composite Ranking Engine

To solve search relevance and prevent recommending dead APIs to AI agents, the Bazaar search engine calculates a **Composite Quality Score ($\Phi$)**:

$$\Phi = w_1 \cdot S_{\text{semantic}} + w_2 \cdot S_{\text{bm25}} + w_3 \cdot S_{\text{uptime}} + w_4 \cdot S_{\text{latency}} + w_5 \cdot S_{\text{reliability}}$$

Where:
- $S_{\text{semantic}}$: Cosine similarity score from `pgvector` embeddings ($\in [0, 1]$).
- $S_{\text{bm25}}$: Normalized full-text BM25 keyword match score ($\in [0, 1]$).
- $S_{\text{uptime}}$: Measured 30-day node heartbeat uptime ratio ($\frac{\text{successful pings}}{\text{expected pings}}$).
- $S_{\text{latency}}$: Exponential penalty function for response latency:
  $$S_{\text{latency}} = \exp\left(-\frac{\text{Latency}_{\text{ms}}}{500}\right)$$
- $S_{\text{reliability}}$: Logarithmic scale of successfully settled x402 payments ($\min(1.0, \frac{\log_{10}(\text{Settlements} + 1)}{3})$).
- Recommended Weighting Vector: $w = [0.35, 0.25, 0.15, 0.15, 0.10]$.

```sql
-- PostgreSQL Query Executing Composite Telemetry Ranking
WITH vector_search AS (
    SELECT id, (1 - (embedding <=> $2::vector)) AS vec_score
    FROM catalog_resources
    ORDER BY embedding <=> $2::vector
    LIMIT 50
),
text_search AS (
    SELECT id, ts_rank_cd(to_tsvector('english', description || ' ' || COALESCE(service_name, '')), plainto_tsquery('english', $1)) AS text_score
    FROM catalog_resources
    WHERE to_tsvector('english', description || ' ' || COALESCE(service_name, '')) @@ plainto_tsquery('english', $1)
    LIMIT 50
)
SELECT r.id, r.resource_url, r.service_name, r.description, r.pay_to, r.network, r.scheme,
       t.avg_response_time_ms, t.uptime_ratio, t.settlement_count,
       (
         0.35 * COALESCE(v.vec_score, 0.0) +
         0.25 * LEAST(1.0, COALESCE(k.text_score, 0.0)) +
         0.15 * COALESCE(t.uptime_ratio, 0.5) +
         0.15 * EXP(-COALESCE(t.avg_response_time_ms, 1000.0) / 500.0) +
         0.10 * LEAST(1.0, LN(COALESCE(t.settlement_count, 0) + 1) / 3.0)
       ) AS composite_rank
FROM catalog_resources r
LEFT JOIN vector_search v ON r.id = v.id
LEFT JOIN text_search k ON r.id = k.id
LEFT JOIN resource_telemetry t ON r.id = t.resource_id
WHERE v.id IS NOT NULL OR k.id IS NOT NULL
ORDER BY composite_rank DESC
LIMIT $3 OFFSET $4;
```

---

### 3.3 Liveness Circuit Breaker & Auto-Pruning Logic

```typescript
export class LivenessCircuitBreaker {
  private static readonly MAX_MISSED_HEARTBEATS = 3;
  private static readonly HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds

  public evaluateNodeStatus(lastSeenTimestampMs: number): "HEALTHY" | "DEGRADED" | "OFFLINE" {
    const elapsed = Date.now() - lastSeenTimestampMs;
    const missedPings = Math.floor(elapsed / LivenessCircuitBreaker.HEARTBEAT_INTERVAL_MS);

    if (missedPings < 1) return "HEALTHY";
    if (missedPings <= LivenessCircuitBreaker.MAX_MISSED_HEARTBEATS) return "DEGRADED";
    return "OFFLINE";
  }

  public getSearchMultiplier(status: "HEALTHY" | "DEGRADED" | "OFFLINE"): number {
    switch (status) {
      case "HEALTHY": return 1.0;
      case "DEGRADED": return 0.3; // Penalize search ranking by 70%
      case "OFFLINE": return 0.0;  // Filter out from search results
    }
  }
}
```

---

## 4. Stellar `upto` Settlement Scheme Specification

Section 3.4 requires authoring `scheme_upto_stellar.md` and implementing a Soroban smart contract (`upto_escrow.rs`) enforcing the 5 core `upto` properties natively on Stellar.

### 4.1 Soroban Smart Contract (`upto_escrow.rs`)

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
    pub fn initialize(env: Env, admin: Address) -> Result<(), UptoError> {
        if env.storage().instance().has(&STORAGE_KEY_ADMIN) {
            return Err(UptoError::AlreadyInitialized);
        }
        env.storage().instance().set(&STORAGE_KEY_ADMIN, &admin);
        Ok(())
    }

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

        // Mark Nonce as Consumed
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

## 5. Agent-Facing MCP Discovery Server Specification

Section 3.3 requires exposing an MCP server allowing AI agents to discover resources and execute 402 payments autonomously.

### 5.1 MCP Server Package Architecture (`@veridex/mcp-discovery-server`)

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export class VeridexMcpDiscoveryServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      { name: "veridex-mcp-discovery", version: "2.0.0" },
      { capabilities: { tools: {} } }
    );
    this.setupToolHandlers();
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "discover_resources",
          description: "Search the Stellar Bazaar for live, telemetry-ranked x402 paid APIs and MCP tools.",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "Natural language search query" },
              type: { type: "string", enum: ["http", "mcp"] },
              minUptimeRatio: { type: "number", default: 0.90 },
              network: { type: "string", default: "stellar:pubnet" }
            },
            required: ["query"]
          }
        },
        {
          name: "pay_resource",
          description: "Execute an HTTP call to an x402 endpoint, handling the 402 payment challenge and settlement.",
          inputSchema: {
            type: "object",
            properties: {
              url: { type: "string", description: "Target resource URL" },
              method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE"], default: "GET" },
              params: { type: "object", description: "Request body or query params" },
              maxAmount: { type: "string", description: "Maximum authorized spending cap in stroops" }
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

import "regexp"

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

## 7. Operational Scalability & Channel Accounts

The facilitator manages a pool of **50 pre-funded Channel Accounts**:
- Each channel account leases its own sequence number for inner transactions.
- Facilitator fee key signs the outer `FeeBumpTransaction` sponsoring XLM network fees.
- Round-robin leasing decouples sequence numbers, enabling ~50 parallel settlement transactions per Stellar ledger (~5 seconds).

---

## 8. Licensing, Threat Model, and Audit Readiness

### 8.1 License Continuity & AGPL Elimination

All v2 packages operate strictly under the **Apache License 2.0**. CI automates dependency checks with `license-checker` to fail builds if AGPL/GPL dependencies are introduced.

### 8.2 Threat Model & Mitigation

| Vector | Description | Mitigation in Veridex v2 |
|---|---|---|
| **Catalog Poisoning (TPA)** | Hostile node broadcasts bad route template | Soft-drop validation in [`facilitator.ts`](https://github.com/x402-foundation/x402/blob/main/typescript/packages/extensions/src/bazaar/facilitator.ts): percent-decodes before traversal (`..`) & scheme (`://`) checks |
| **Heartbeat Sybil Attack** | Attacker spams P2P mesh with fake node pings | Heartbeat messages require valid Ed25519 signature matching registered node key |
| **SSRF via `iconUrl`** | Malicious image URL pointing to loopback interface | `isValidIconUrl` rejects IP literals, `localhost`, decimal/hex IPs (`0x7f000001`) |
| **Auth Entry Replay** | Resubmitting intercepted signature | Ledger-bounded expiration (`signatureExpirationLedger`) + Soroban contract nonce tracking |

---

## 9. Phased Implementation Roadmap & Deliverables

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                             PHASED V2 IMPLEMENTATION TIMELINE                            │
│                                                                                         │
│  PHASE 1: Bazaar Engine & P2P Mesh (Weeks 1 - 3) [LARGEST BUDGET ALLOCATION]            │
│  - PostgreSQL + pgvector schema, GossipSub P2P announce, Telemetry Composite Ranking    │
│                                                                                         │
│  PHASE 2: Facilitator Core & Channel Pool (Weeks 3 - 4)                                 │
│  - Standalone REST + WebSocket Hono server, 50 Channel account manager, Fee sponsoring │
│                                                                                         │
│  PHASE 3: Upstream Stellar `upto` Scheme & Soroban Contract (Weeks 5 - 6)                │
│  - Author scheme_upto_stellar.md, compile & test upto_escrow.rs on Soroban testnet      │
│                                                                                         │
│  PHASE 4: Agent MCP Discovery Server & Multi-Language SDKs (Weeks 7 - 8)                │
│  - Standalone MCP server, TS/Python/Go seller & buyer SDK helpers                       │
│                                                                                         │
│  PHASE 5: Conformance, E2E Verification & Security Review (Weeks 9 - 10)               │
│  - Unmodified canonical client verification, mainnet/testnet deployment, audit report   │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 10. Actionable Engineering Team Prompt

```text
You are assigned to build the @veridex/stellar-bazaar-facilitator v2 suite fulfilling the Stellar x402 Bazaar RFP.

Follow this blueprint strictly:
1. Base all Stellar transaction handling on @x402/stellar and @stellar/stellar-sdk (Apache-2.0). Ensure zero AGPL dependencies exist in package.json.
2. Implement @veridex/bazaar-service using PostgreSQL + pgvector and a js-libp2p GossipSub P2P mesh topic /x402/bazaar/v1/announce.
3. Enforce soft-drop rules in x402/typescript/packages/extensions/src/bazaar/facilitator.ts (isValidServiceName, sanitizeTags, isValidIconUrl, isValidRouteTemplate).
4. Implement GET /discovery/search with composite quality scoring combining vector similarity, BM25 text match, 30-day node ping uptime, and response latency.
5. Author scheme_upto_stellar.md and build the Soroban upto_escrow.rs smart contract enforcing single settlement and max cap.
6. Create @veridex/mcp-discovery-server exposing discover_resources and pay_resource tools for AI agents.
7. Verify wire-level conformance using an unmodified canonical x402 client on stellar:testnet and stellar:pubnet with extra.areFeesSponsored = true.
```

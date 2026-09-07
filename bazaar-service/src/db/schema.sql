-- Veridex Bazaar Discovery Engine - PostgreSQL + pgvector Schema
-- License: Apache-2.0
-- Version: 2.0.0
--
-- This schema implements the P2P federated catalog with telemetry-enriched ranking.
-- Uses pgvector with 384-dimensional feature-hash embeddings (see search/embeddings.ts:
-- lexical, not semantic - a learned model is future work).

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Primary catalog table for HTTP endpoints and MCP tools
-- Stores all discovered resources with metadata and vector embeddings
CREATE TABLE IF NOT EXISTS catalog_resources (
    -- Primary key and unique identification
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    resource_url TEXT NOT NULL,
    validation_url TEXT NOT NULL,
    tool_name TEXT,  -- NULL for HTTP resources, populated for MCP tools
    tool_name_key TEXT GENERATED ALWAYS AS (COALESCE(tool_name, '')) STORED,
    resource_type TEXT NOT NULL DEFAULT 'http' CHECK (resource_type IN ('http', 'mcp')),

    -- Resource metadata (validated via soft-drop rules)
    service_name VARCHAR(32) CHECK (service_name ~ '^[\x20-\x7e]+$'),  -- Printable ASCII only
    description TEXT,
    mime_type VARCHAR(64) NOT NULL DEFAULT 'application/json',
    tags TEXT[] DEFAULT '{}',  -- Max 5 tags, each max 32 chars
    icon_url TEXT,  -- Validated against SSRF/IP literal attacks
    route_template TEXT,  -- Validated against path traversal
    input_spec JSONB NOT NULL DEFAULT '{}'::jsonb,
    output_spec JSONB,
    extensions JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Payment and network configuration
    pay_to TEXT NOT NULL,  -- Stellar G-address
    network TEXT NOT NULL DEFAULT 'stellar:pubnet',  -- e.g., stellar:pubnet, stellar:testnet
    scheme TEXT NOT NULL DEFAULT 'exact',  -- e.g., exact, upto
    asset TEXT,
    amount TEXT,

    -- Telemetry and status
    last_seen TIMESTAMPTZ DEFAULT now(),  -- Last heartbeat or settlement
    soft_dropped BOOLEAN DEFAULT false,  -- True if validation fails
    last_verified_at TIMESTAMPTZ,
    verification_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (verification_status IN ('pending', 'verified', 'quarantined')),
    verification_reason TEXT,

    -- Feature-hash embedding (384 dimensions), generated from
    -- service_name + description + tags. Lexical, not semantic.
    embedding vector(384),

    -- Settlement that backs this entry.
    -- The catalog confirms this transaction on Horizon before listing anything
    -- (see catalog/settlement-proof.ts). UNIQUE so one payment cannot be
    -- reused to list a second resource.
    settlement_tx TEXT UNIQUE,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Compound uniqueness constraint: each (resource_url, tool_name) pair is unique
    -- tool_name can be NULL for HTTP resources
    CONSTRAINT unique_resource_tool_entry UNIQUE (resource_url, tool_name_key)
);

-- Real-time telemetry metrics for each resource
-- Updated via P2P heartbeat messages and settlement events
CREATE TABLE IF NOT EXISTS resource_telemetry (
    resource_id UUID PRIMARY KEY REFERENCES catalog_resources(id) ON DELETE CASCADE,

    -- Performance metrics
    avg_response_time_ms DOUBLE PRECISION DEFAULT 1000.0,  -- Exponential moving average
    uptime_ratio DOUBLE PRECISION DEFAULT 1.0,  -- 30-day uptime (0.0 to 1.0)
    settlement_count BIGINT DEFAULT 0,  -- Successful x402 settlements
    failed_settlement_count BIGINT DEFAULT 0,  -- Failed settlements

    -- Liveness tracking
    last_heartbeat_at TIMESTAMPTZ DEFAULT now(),  -- Last P2P heartbeat received
    -- Last confirmed settlement. A payment that settled and was served is a
    -- stronger liveness proof than a heartbeat, and it is the only signal a
    -- seller who does not run a P2P node ever produces. Without this, every
    -- auto-catalogued resource is pruned to OFFLINE within minutes and
    -- disappears from discovery.
    last_settlement_at TIMESTAMPTZ,
    heartbeat_sequence BIGINT DEFAULT 0,  -- Monotonic sequence number

    -- Node identity
    node_id TEXT,  -- Libp2p PeerID or Stellar G-address
    liveness_status TEXT NOT NULL DEFAULT 'HEALTHY'
        CHECK (liveness_status IN ('HEALTHY', 'DEGRADED', 'OFFLINE')),

    -- Status metadata
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Audit log for P2P heartbeat messages
-- Stores all received heartbeats with Ed25519 signatures for verification
CREATE TABLE IF NOT EXISTS node_heartbeats (
    id SERIAL PRIMARY KEY,

    -- Node and resource identification
    node_id TEXT NOT NULL,
    resource_url TEXT NOT NULL,
    tool_name TEXT,  -- Optional for MCP tools

    -- Heartbeat metadata
    timestamp BIGINT NOT NULL,  -- Unix timestamp in milliseconds
    sequence BIGINT NOT NULL,  -- Monotonic sequence per node

    -- Telemetry snapshot at heartbeat time
    avg_response_time_ms DOUBLE PRECISION,
    uptime_30d DOUBLE PRECISION,
    successful_settlements BIGINT,

    -- Ed25519 signature verification
    -- Signature is over: "${resourceUrl}:${timestamp}:${sequence}"
    signature TEXT NOT NULL,

    -- Timestamp when message was received
    received_at TIMESTAMPTZ DEFAULT now(),

    -- Unique constraint for replay protection
    CONSTRAINT unique_node_sequence UNIQUE (node_id, sequence)
);

-- Provider-quality observations are separate from heartbeat/liveness telemetry.
-- Store digests and signed claims, never raw request or response bodies.
CREATE TABLE IF NOT EXISTS provider_observations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    resource TEXT NOT NULL,
    pay_to TEXT NOT NULL,
    request_digest TEXT NOT NULL CHECK (request_digest ~ '^sha256:[0-9a-fA-F]{64}$'),
    response_digest TEXT NOT NULL CHECK (response_digest ~ '^sha256:[0-9a-fA-F]{64}$'),
    observed_at TIMESTAMPTZ NOT NULL,
    usable BOOLEAN NOT NULL,
    provider_at_fault BOOLEAN NOT NULL,
    attributable TEXT NOT NULL CHECK (attributable IN ('provider', 'caller', 'unknown')),
    reason_code TEXT NOT NULL,
    usage_atomic TEXT,
    response_status INTEGER,
    tool_name TEXT,
    route TEXT,
    call_id TEXT,
    settlement_tx TEXT,
    signer TEXT NOT NULL,
    signature TEXT NOT NULL,
    observation_source TEXT NOT NULL DEFAULT 'in_band'
        CHECK (observation_source IN ('in_band', 'independent')),
    outcome JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT provider_observations_unique_signature UNIQUE (signer, signature)
);

CREATE INDEX IF NOT EXISTS idx_provider_observations_resource_time
    ON provider_observations (resource, pay_to, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_provider_observations_settlement
    ON provider_observations (settlement_tx) WHERE settlement_tx IS NOT NULL;

CREATE TABLE IF NOT EXISTS provider_observation_disagreements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    resource TEXT NOT NULL,
    pay_to TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    in_band_observation_id UUID NOT NULL REFERENCES provider_observations(id),
    independent_observation_id UUID NOT NULL REFERENCES provider_observations(id),
    fields TEXT[] NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT provider_observation_disagreement_pair UNIQUE (in_band_observation_id, independent_observation_id)
);

CREATE INDEX IF NOT EXISTS idx_provider_disagreements_resource_time
    ON provider_observation_disagreements (resource, pay_to, created_at DESC);

CREATE TABLE IF NOT EXISTS provider_quality_aggregates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    endpoint TEXT NOT NULL,
    pay_to TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL CHECK (state IN ('insufficient_data', 'provisional', 'published')),
    fault_rate_upper_bound DOUBLE PRECISION NOT NULL CHECK (fault_rate_upper_bound BETWEEN 0 AND 1),
    faults_observed BIGINT NOT NULL CHECK (faults_observed >= 0),
    observation_count BIGINT NOT NULL CHECK (observation_count >= faults_observed),
    aggregation_window TEXT NOT NULL,
    retrieved_at TIMESTAMPTZ NOT NULL,
    issuer TEXT NOT NULL,
    signature TEXT NOT NULL,
    aggregate JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT provider_quality_aggregates_unique_signature UNIQUE (endpoint, pay_to, issuer, signature)
);

CREATE INDEX IF NOT EXISTS idx_provider_quality_latest
    ON provider_quality_aggregates (endpoint, pay_to, retrieved_at DESC);

-- Durable signed catalog snapshots and revoke tombstones. Arrival order is not
-- authoritative; revision and digest ordering are enforced by the ingestion
-- transaction.
CREATE TABLE IF NOT EXISTS catalog_delta_state (
    catalog_key TEXT PRIMARY KEY,
    network TEXT NOT NULL,
    pay_to TEXT NOT NULL,
    resource_url TEXT NOT NULL,
    tool_name TEXT NOT NULL DEFAULT '',
    revision BIGINT NOT NULL CHECK (revision >= 0),
    digest TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('upsert', 'revoke')),
    signer TEXT NOT NULL,
    issued_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    payload JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_catalog_delta_resource
    ON catalog_delta_state (resource_url, tool_name, network, pay_to);

-- Performance indexes for catalog search

-- 1. IVFFlat index for vector similarity search (pgvector)
-- Lists parameter controls accuracy vs speed tradeoff
CREATE INDEX IF NOT EXISTS idx_catalog_embedding
    ON catalog_resources
    USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

-- 2. GIN index for full-text search (BM25 ranking)
CREATE INDEX IF NOT EXISTS idx_catalog_text
    ON catalog_resources
    USING gin (to_tsvector('english', coalesce(service_name,'') || ' ' || coalesce(description,'')));

-- 3. GIN index for array tag searches
CREATE INDEX IF NOT EXISTS idx_catalog_tags
    ON catalog_resources
    USING gin (tags);

-- 4. B-tree composite index for filtering
CREATE INDEX IF NOT EXISTS idx_catalog_filter
    ON catalog_resources (network, soft_dropped, last_seen DESC);

CREATE INDEX IF NOT EXISTS idx_catalog_revalidation_due
    ON catalog_resources (last_verified_at ASC NULLS FIRST)
    WHERE resource_type = 'http' AND soft_dropped = false;

-- 5. Index for telemetry joins
CREATE INDEX IF NOT EXISTS idx_telemetry_heartbeat
    ON resource_telemetry (last_heartbeat_at DESC);

-- 6. Index for heartbeat audit queries
CREATE INDEX IF NOT EXISTS idx_heartbeats_resource
    ON node_heartbeats (resource_url, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_heartbeats_node
    ON node_heartbeats (node_id, timestamp DESC);

-- Auto-update timestamp trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_catalog_resources_updated_at
    BEFORE UPDATE ON catalog_resources
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_resource_telemetry_updated_at
    BEFORE UPDATE ON resource_telemetry
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Comments for documentation
COMMENT ON TABLE catalog_resources IS 'Primary catalog of x402-protected resources discovered via P2P mesh and settlement events';
COMMENT ON COLUMN catalog_resources.embedding IS '384-dimensional feature-hash embedding (lexical, not semantic; see search/embeddings.ts)';
COMMENT ON COLUMN catalog_resources.soft_dropped IS 'True if resource failed soft-drop validation rules';
COMMENT ON COLUMN catalog_resources.last_verified_at IS 'Last successful live HTTP 402 payment-term validation';
COMMENT ON TABLE resource_telemetry IS 'Real-time performance and liveness metrics for each cataloged resource';
COMMENT ON TABLE node_heartbeats IS 'Audit log of P2P heartbeat messages with Ed25519 signature verification';

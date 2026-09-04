-- Veridex Bazaar - provider-quality observations and signed aggregate history
-- License: Apache-2.0

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
    outcome JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT provider_observations_unique_signature UNIQUE (signer, signature)
);

CREATE INDEX IF NOT EXISTS idx_provider_observations_resource_time
    ON provider_observations (resource, pay_to, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_provider_observations_settlement
    ON provider_observations (settlement_tx) WHERE settlement_tx IS NOT NULL;

CREATE TABLE IF NOT EXISTS provider_quality_aggregates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    endpoint TEXT NOT NULL,
    pay_to TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL CHECK (state IN ('insufficient_data', 'provisional', 'published')),
    fault_rate_upper_bound DOUBLE PRECISION NOT NULL CHECK (fault_rate_upper_bound BETWEEN 0 AND 1),
    faults_observed BIGINT NOT NULL CHECK (faults_observed >= 0),
    observation_count BIGINT NOT NULL CHECK (observation_count >= faults_observed),
    window TEXT NOT NULL,
    retrieved_at TIMESTAMPTZ NOT NULL,
    issuer TEXT NOT NULL,
    signature TEXT NOT NULL,
    aggregate JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT provider_quality_aggregates_unique_signature UNIQUE (endpoint, pay_to, issuer, signature)
);

CREATE INDEX IF NOT EXISTS idx_provider_quality_latest
    ON provider_quality_aggregates (endpoint, pay_to, retrieved_at DESC);
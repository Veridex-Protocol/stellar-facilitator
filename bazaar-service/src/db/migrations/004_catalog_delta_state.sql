-- Veridex Bazaar - durable signed catalog delta state
-- License: Apache-2.0

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
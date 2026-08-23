-- Veridex Bazaar - treat a settlement as a liveness signal
-- License: Apache-2.0
--
-- Liveness was derived from P2P heartbeats alone, so a resource catalogued
-- automatically from a settled payment was marked OFFLINE within
-- HEARTBEAT_INTERVAL_MS * MAX_MISSED_HEARTBEATS and dropped out of
-- /discovery/search -- unless its seller also ran a libp2p node. That defeats
-- automatic cataloging, which is meant to need no action from the seller.

ALTER TABLE resource_telemetry ADD COLUMN IF NOT EXISTS last_settlement_at TIMESTAMPTZ;

-- Existing rows with settlements behind them were catalogued from a payment;
-- seed them so the next prune does not immediately take them offline.
UPDATE resource_telemetry t
SET last_settlement_at = r.updated_at
FROM catalog_resources r
WHERE t.resource_id = r.id
  AND t.last_settlement_at IS NULL
  AND r.settlement_tx IS NOT NULL;

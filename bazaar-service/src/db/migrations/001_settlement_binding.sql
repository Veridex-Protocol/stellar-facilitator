-- Veridex Bazaar - bind catalog entries to a confirmed settlement
-- License: Apache-2.0
--
-- Adds the settlement_tx column and its uniqueness guarantee. Entries created
-- before this migration have no settlement behind them: they were listed on a
-- caller's assertion that a payment happened. They are soft-dropped rather than
-- deleted, so an operator can inspect them, and they stop appearing in search.

ALTER TABLE catalog_resources ADD COLUMN IF NOT EXISTS settlement_tx TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'catalog_resources_settlement_tx_key'
  ) THEN
    ALTER TABLE catalog_resources
      ADD CONSTRAINT catalog_resources_settlement_tx_key UNIQUE (settlement_tx);
  END IF;
END $$;

UPDATE catalog_resources SET soft_dropped = true WHERE settlement_tx IS NULL;

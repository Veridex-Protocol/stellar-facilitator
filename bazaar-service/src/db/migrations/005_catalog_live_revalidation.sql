-- Veridex Bazaar - live payment-term verification state

ALTER TABLE catalog_resources
  ADD COLUMN IF NOT EXISTS validation_url TEXT,
  ADD COLUMN IF NOT EXISTS asset TEXT,
  ADD COLUMN IF NOT EXISTS amount TEXT,
  ADD COLUMN IF NOT EXISTS last_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS verification_reason TEXT;

UPDATE catalog_resources
SET validation_url = resource_url
WHERE validation_url IS NULL;

ALTER TABLE catalog_resources
  ALTER COLUMN validation_url SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'catalog_resources_verification_status_check'
  ) THEN
    ALTER TABLE catalog_resources
      ADD CONSTRAINT catalog_resources_verification_status_check
      CHECK (verification_status IN ('pending', 'verified', 'quarantined'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_catalog_revalidation_due
  ON catalog_resources (last_verified_at ASC NULLS FIRST)
  WHERE resource_type = 'http' AND soft_dropped = false;
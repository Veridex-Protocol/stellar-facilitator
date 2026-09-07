-- Veridex Bazaar - distinguish in-band outcomes from independent attestations

ALTER TABLE provider_observations
  ADD COLUMN IF NOT EXISTS observation_source TEXT NOT NULL DEFAULT 'in_band';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'provider_observations_source_check'
  ) THEN
    ALTER TABLE provider_observations
      ADD CONSTRAINT provider_observations_source_check
      CHECK (observation_source IN ('in_band', 'independent'));
  END IF;
END $$;

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
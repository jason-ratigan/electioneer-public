ALTER TABLE candidates
  ADD COLUMN canonical_key TEXT UNIQUE CHECK (canonical_key IS NULL OR canonical_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$');

ALTER TABLE geography_versions
  ADD CONSTRAINT geography_versions_valid_geometry_check CHECK (geom IS NULL OR ST_IsValid(geom));

ALTER TABLE result_batches
  ALTER COLUMN reported_at DROP NOT NULL,
  DROP CONSTRAINT result_batches_status_check,
  ADD CONSTRAINT result_batches_status_check CHECK (status IN (
    'unofficial_partial',
    'unofficial_complete',
    'certified',
    'correction',
    'recount',
    'research_dataset'
  ));

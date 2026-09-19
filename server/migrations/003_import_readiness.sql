ALTER TABLE source_artifacts
  ADD COLUMN parent_artifact_id BIGINT REFERENCES source_artifacts(id);

CREATE INDEX source_artifacts_parent_idx ON source_artifacts (parent_artifact_id);

ALTER TABLE candidate_source_ids
  DROP CONSTRAINT candidate_source_ids_pkey,
  ADD COLUMN identifier_namespace TEXT NOT NULL DEFAULT 'global',
  ADD PRIMARY KEY (source_id, identifier_namespace, source_identifier);

ALTER TABLE geography_source_ids
  DROP CONSTRAINT geography_source_ids_pkey,
  ADD COLUMN identifier_namespace TEXT NOT NULL DEFAULT 'global',
  ADD PRIMARY KEY (source_id, identifier_namespace, source_identifier);

ALTER TABLE election_source_ids
  DROP CONSTRAINT election_source_ids_pkey,
  ADD COLUMN identifier_namespace TEXT NOT NULL DEFAULT 'global',
  ADD PRIMARY KEY (source_id, identifier_namespace, source_identifier);

ALTER TABLE contest_source_ids
  DROP CONSTRAINT contest_source_ids_pkey,
  ADD COLUMN identifier_namespace TEXT NOT NULL DEFAULT 'global',
  ADD PRIMARY KEY (source_id, identifier_namespace, source_identifier);

ALTER TABLE contest_choice_source_ids
  DROP CONSTRAINT contest_choice_source_ids_pkey,
  ADD COLUMN identifier_namespace TEXT NOT NULL DEFAULT 'global',
  ADD PRIMARY KEY (source_id, identifier_namespace, source_identifier);

ALTER TABLE vote_totals
  DROP COLUMN is_suppressed,
  ADD COLUMN vote_status TEXT NOT NULL DEFAULT 'reported' CHECK (vote_status IN ('reported', 'suppressed', 'not_reported')),
  ADD CONSTRAINT vote_totals_value_status_check CHECK (
    (vote_status = 'reported' AND votes IS NOT NULL AND votes >= 0)
    OR (vote_status IN ('suppressed', 'not_reported') AND votes IS NULL)
  );

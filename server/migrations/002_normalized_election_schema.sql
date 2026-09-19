DROP TABLE IF EXISTS observations;
DROP TABLE IF EXISTS races;
DROP TABLE IF EXISTS ingest_runs;

CREATE TABLE data_sources (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  homepage_url TEXT,
  license TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO data_sources (slug, name, homepage_url, enabled) VALUES
  ('openelections', 'OpenElections', 'https://openelections.net/', TRUE),
  ('vest', 'Voting and Election Science Team', 'https://election.lab.ufl.edu/', TRUE),
  ('state', 'State election offices', NULL, TRUE),
  ('ap', 'AP Elections', 'https://developer.ap.org/ap-elections-api/', FALSE)
ON CONFLICT (slug) DO NOTHING;

CREATE TABLE source_artifacts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id BIGINT NOT NULL REFERENCES data_sources(id),
  uri TEXT NOT NULL,
  retrieved_at TIMESTAMPTZ NOT NULL,
  published_at TIMESTAMPTZ,
  sha256 TEXT CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  byte_size BIGINT CHECK (byte_size IS NULL OR byte_size >= 0),
  content_type TEXT,
  source_version TEXT,
  license TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB
);

CREATE UNIQUE INDEX source_artifacts_checksum_idx
  ON source_artifacts (source_id, sha256)
  WHERE sha256 IS NOT NULL;

CREATE TABLE parties (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  abbreviation TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  UNIQUE (name)
);

CREATE TABLE candidates (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  canonical_name TEXT NOT NULL,
  given_name TEXT,
  middle_name TEXT,
  family_name TEXT,
  suffix TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE candidate_source_ids (
  candidate_id BIGINT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  source_id BIGINT NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  source_identifier TEXT NOT NULL,
  PRIMARY KEY (source_id, source_identifier),
  UNIQUE (candidate_id, source_id, source_identifier)
);

CREATE TABLE geographies (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  geography_type TEXT NOT NULL CHECK (geography_type IN (
    'nation', 'state', 'county', 'county_equivalent', 'municipality',
    'congressional_district', 'state_senate_district', 'state_house_district',
    'precinct', 'split_precinct', 'reporting_unit', 'other'
  )),
  name TEXT NOT NULL,
  abbreviation TEXT,
  state_fips TEXT CHECK (state_fips IS NULL OR state_fips ~ '^[0-9]{2}$'),
  county_fips TEXT CHECK (county_fips IS NULL OR county_fips ~ '^[0-9]{3}$'),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE NULLS NOT DISTINCT (geography_type, state_fips, county_fips, name)
);

CREATE INDEX geographies_type_idx ON geographies (geography_type);
CREATE INDEX geographies_fips_idx ON geographies (state_fips, county_fips);

CREATE TABLE geography_source_ids (
  geography_id BIGINT NOT NULL REFERENCES geographies(id) ON DELETE CASCADE,
  source_id BIGINT NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  source_identifier TEXT NOT NULL,
  PRIMARY KEY (source_id, source_identifier),
  UNIQUE (geography_id, source_id, source_identifier)
);

CREATE TABLE geography_versions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  geography_id BIGINT NOT NULL REFERENCES geographies(id) ON DELETE CASCADE,
  source_artifact_id BIGINT REFERENCES source_artifacts(id),
  valid_from DATE NOT NULL,
  valid_to DATE,
  geom GEOMETRY(MULTIPOLYGON, 4326),
  is_estimated BOOLEAN NOT NULL DEFAULT FALSE,
  methodology TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  UNIQUE NULLS NOT DISTINCT (geography_id, valid_from, valid_to)
);

CREATE INDEX geography_versions_geom_idx ON geography_versions USING GIST (geom);
CREATE INDEX geography_versions_validity_idx ON geography_versions (geography_id, valid_from, valid_to);

CREATE TABLE geography_relationships (
  parent_geography_id BIGINT NOT NULL REFERENCES geographies(id) ON DELETE CASCADE,
  child_geography_id BIGINT NOT NULL REFERENCES geographies(id) ON DELETE CASCADE,
  relationship_type TEXT NOT NULL DEFAULT 'contains' CHECK (relationship_type IN ('contains', 'overlaps', 'reports_to', 'crosswalk')),
  valid_from DATE NOT NULL,
  valid_to DATE,
  allocation_fraction NUMERIC(12, 10) CHECK (allocation_fraction IS NULL OR allocation_fraction BETWEEN 0 AND 1),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  PRIMARY KEY (parent_geography_id, child_geography_id, relationship_type, valid_from),
  CHECK (parent_geography_id <> child_geography_id),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);

CREATE INDEX geography_relationships_child_idx ON geography_relationships (child_geography_id, valid_from, valid_to);

CREATE TABLE offices (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  office_level TEXT NOT NULL CHECK (office_level IN ('federal', 'state', 'local', 'party', 'other')),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB
);

INSERT INTO offices (slug, name, office_level) VALUES
  ('president', 'President', 'federal'),
  ('us_senate', 'U.S. Senate', 'federal'),
  ('us_house', 'U.S. House', 'federal'),
  ('governor', 'Governor', 'state')
ON CONFLICT (slug) DO NOTHING;

CREATE TABLE election_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  cycle INTEGER NOT NULL CHECK (cycle >= 1788),
  stage TEXT NOT NULL CHECK (stage IN ('primary', 'general', 'runoff', 'special', 'recall', 'other')),
  primary_format TEXT,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  scope_geography_id BIGINT NOT NULL REFERENCES geographies(id),
  preceding_election_id BIGINT REFERENCES election_events(id),
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  CHECK (end_date >= start_date)
);

CREATE INDEX election_events_date_stage_idx ON election_events (start_date DESC, stage);

CREATE TABLE election_source_ids (
  election_id BIGINT NOT NULL REFERENCES election_events(id) ON DELETE CASCADE,
  source_id BIGINT NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  source_identifier TEXT NOT NULL,
  PRIMARY KEY (source_id, source_identifier),
  UNIQUE (election_id, source_id, source_identifier)
);

CREATE TABLE contests (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  election_id BIGINT NOT NULL REFERENCES election_events(id) ON DELETE CASCADE,
  office_id BIGINT REFERENCES offices(id),
  district_geography_id BIGINT NOT NULL REFERENCES geographies(id),
  primary_party_id BIGINT REFERENCES parties(id),
  preceding_contest_id BIGINT REFERENCES contests(id),
  contest_type TEXT NOT NULL DEFAULT 'candidate' CHECK (contest_type IN ('candidate', 'ballot_measure', 'retention', 'party', 'other')),
  name TEXT NOT NULL,
  district_label TEXT,
  vote_variation TEXT NOT NULL DEFAULT 'plurality',
  number_elected SMALLINT NOT NULL DEFAULT 1 CHECK (number_elected > 0),
  votes_allowed SMALLINT NOT NULL DEFAULT 1 CHECK (votes_allowed > 0),
  runoff_slots SMALLINT CHECK (runoff_slots IS NULL OR runoff_slots > 0),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  UNIQUE NULLS NOT DISTINCT (election_id, name, district_geography_id, primary_party_id)
);

CREATE INDEX contests_election_idx ON contests (election_id);
CREATE INDEX contests_district_idx ON contests (district_geography_id);

CREATE TABLE contest_source_ids (
  contest_id BIGINT NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  source_id BIGINT NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  source_identifier TEXT NOT NULL,
  PRIMARY KEY (source_id, source_identifier),
  UNIQUE (contest_id, source_id, source_identifier)
);

CREATE TABLE contest_choices (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contest_id BIGINT NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  ballot_name TEXT NOT NULL,
  choice_type TEXT NOT NULL DEFAULT 'candidate' CHECK (choice_type IN ('candidate', 'ticket', 'write_in', 'other')),
  party_id BIGINT REFERENCES parties(id),
  is_write_in BOOLEAN NOT NULL DEFAULT FALSE,
  ballot_order INTEGER CHECK (ballot_order IS NULL OR ballot_order > 0),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  UNIQUE NULLS NOT DISTINCT (contest_id, ballot_name, party_id)
);

CREATE TABLE contest_choice_candidates (
  contest_choice_id BIGINT NOT NULL REFERENCES contest_choices(id) ON DELETE CASCADE,
  candidate_id BIGINT NOT NULL REFERENCES candidates(id),
  office_id BIGINT REFERENCES offices(id),
  ticket_position SMALLINT NOT NULL DEFAULT 1 CHECK (ticket_position > 0),
  PRIMARY KEY (contest_choice_id, candidate_id),
  UNIQUE (contest_choice_id, ticket_position)
);

CREATE TABLE contest_choice_source_ids (
  contest_choice_id BIGINT NOT NULL REFERENCES contest_choices(id) ON DELETE CASCADE,
  source_id BIGINT NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  source_identifier TEXT NOT NULL,
  PRIMARY KEY (source_id, source_identifier),
  UNIQUE (contest_choice_id, source_id, source_identifier)
);

CREATE TABLE ingestion_runs (
  id UUID PRIMARY KEY,
  source_id BIGINT NOT NULL REFERENCES data_sources(id),
  source_artifact_id BIGINT REFERENCES source_artifacts(id),
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'completed_with_warnings')),
  rows_read BIGINT NOT NULL DEFAULT 0 CHECK (rows_read >= 0),
  rows_added BIGINT NOT NULL DEFAULT 0 CHECK (rows_added >= 0),
  rows_updated BIGINT NOT NULL DEFAULT 0 CHECK (rows_updated >= 0),
  warning_count INTEGER NOT NULL DEFAULT 0 CHECK (warning_count >= 0),
  parser_name TEXT,
  parser_version TEXT,
  message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB
);

CREATE INDEX ingestion_runs_started_idx ON ingestion_runs (started_at DESC);

CREATE TABLE result_batches (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id BIGINT NOT NULL REFERENCES data_sources(id),
  source_artifact_id BIGINT REFERENCES source_artifacts(id),
  ingestion_run_id UUID REFERENCES ingestion_runs(id),
  reported_at TIMESTAMPTZ NOT NULL,
  retrieved_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('unofficial_partial', 'unofficial_complete', 'certified', 'correction', 'recount')),
  supersedes_batch_id BIGINT REFERENCES result_batches(id),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  UNIQUE NULLS NOT DISTINCT (source_id, source_artifact_id, reported_at)
);

CREATE TABLE result_snapshots (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id BIGINT NOT NULL REFERENCES result_batches(id) ON DELETE CASCADE,
  contest_id BIGINT NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  reporting_basis TEXT NOT NULL DEFAULT 'unknown' CHECK (reporting_basis IN ('precincts', 'expected_vote', 'ballots', 'reporting_units', 'unknown')),
  reporting_value NUMERIC(7, 4) CHECK (reporting_value IS NULL OR reporting_value BETWEEN 0 AND 100),
  reported_units INTEGER CHECK (reported_units IS NULL OR reported_units >= 0),
  total_units INTEGER CHECK (total_units IS NULL OR total_units >= 0),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  CHECK (reported_units IS NULL OR total_units IS NULL OR reported_units <= total_units),
  UNIQUE (batch_id, contest_id)
);

CREATE INDEX result_snapshots_contest_idx ON result_snapshots (contest_id, batch_id DESC);

CREATE TABLE reporting_unit_statuses (
  snapshot_id BIGINT NOT NULL REFERENCES result_snapshots(id) ON DELETE CASCADE,
  reporting_unit_id BIGINT NOT NULL REFERENCES geographies(id),
  vote_type TEXT NOT NULL DEFAULT 'total',
  count_status TEXT NOT NULL DEFAULT 'unknown' CHECK (count_status IN ('not_started', 'in_process', 'complete', 'unknown')),
  reporting_basis TEXT NOT NULL DEFAULT 'unknown' CHECK (reporting_basis IN ('precincts', 'expected_vote', 'ballots', 'reporting_units', 'unknown')),
  reporting_value NUMERIC(7, 4) CHECK (reporting_value IS NULL OR reporting_value BETWEEN 0 AND 100),
  reported_subunits INTEGER CHECK (reported_subunits IS NULL OR reported_subunits >= 0),
  total_subunits INTEGER CHECK (total_subunits IS NULL OR total_subunits >= 0),
  ballots_counted BIGINT CHECK (ballots_counted IS NULL OR ballots_counted >= 0),
  expected_ballots BIGINT CHECK (expected_ballots IS NULL OR expected_ballots >= 0),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  PRIMARY KEY (snapshot_id, reporting_unit_id, vote_type),
  CHECK (reported_subunits IS NULL OR total_subunits IS NULL OR reported_subunits <= total_subunits)
);

CREATE INDEX reporting_unit_statuses_geography_idx ON reporting_unit_statuses (reporting_unit_id, snapshot_id DESC);

CREATE TABLE vote_totals (
  snapshot_id BIGINT NOT NULL REFERENCES result_snapshots(id) ON DELETE CASCADE,
  reporting_unit_id BIGINT NOT NULL REFERENCES geographies(id),
  contest_choice_id BIGINT NOT NULL REFERENCES contest_choices(id),
  vote_type TEXT NOT NULL DEFAULT 'total',
  round SMALLINT NOT NULL DEFAULT 0 CHECK (round >= 0),
  votes BIGINT,
  is_suppressed BOOLEAN NOT NULL DEFAULT FALSE,
  is_estimated BOOLEAN NOT NULL DEFAULT FALSE,
  tabulation_method TEXT NOT NULL DEFAULT 'source_reported' CHECK (tabulation_method IN ('source_reported', 'sum_of_reporting_units', 'allocated')),
  allocation_method TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  PRIMARY KEY (snapshot_id, reporting_unit_id, contest_choice_id, vote_type, round),
  CHECK ((is_suppressed AND votes IS NULL) OR (NOT is_suppressed AND votes IS NOT NULL AND votes >= 0))
);

CREATE INDEX vote_totals_choice_idx ON vote_totals (contest_choice_id, snapshot_id);
CREATE INDEX vote_totals_reporting_unit_idx ON vote_totals (reporting_unit_id, snapshot_id);

CREATE TABLE pollsters (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  website_url TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB
);

CREATE TABLE polls (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pollster_id BIGINT NOT NULL REFERENCES pollsters(id),
  source_artifact_id BIGINT REFERENCES source_artifacts(id),
  sponsor TEXT,
  geography_id BIGINT NOT NULL REFERENCES geographies(id),
  field_start DATE NOT NULL,
  field_end DATE NOT NULL,
  published_at TIMESTAMPTZ,
  sample_size INTEGER CHECK (sample_size IS NULL OR sample_size > 0),
  population TEXT NOT NULL CHECK (population IN ('adults', 'registered_voters', 'likely_voters', 'other')),
  mode TEXT,
  partisan_sponsor_party_id BIGINT REFERENCES parties(id),
  revision_of_poll_id BIGINT REFERENCES polls(id),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  CHECK (field_end >= field_start)
);

CREATE INDEX polls_geography_dates_idx ON polls (geography_id, field_end DESC);

CREATE TABLE poll_questions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  poll_id BIGINT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  contest_id BIGINT NOT NULL REFERENCES contests(id),
  question_text TEXT,
  sample_size INTEGER CHECK (sample_size IS NULL OR sample_size > 0)
);

CREATE TABLE poll_responses (
  question_id BIGINT NOT NULL REFERENCES poll_questions(id) ON DELETE CASCADE,
  contest_choice_id BIGINT REFERENCES contest_choices(id),
  response_label TEXT NOT NULL,
  share NUMERIC(7, 4) NOT NULL CHECK (share BETWEEN 0 AND 100),
  PRIMARY KEY (question_id, response_label)
);

CREATE TABLE model_runs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_type TEXT NOT NULL CHECK (run_type IN ('poll_average', 'election_projection', 'scenario')),
  model_name TEXT NOT NULL,
  model_version TEXT NOT NULL,
  as_of TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  parameters JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE model_run_poll_inputs (
  model_run_id BIGINT NOT NULL REFERENCES model_runs(id) ON DELETE CASCADE,
  poll_question_id BIGINT NOT NULL REFERENCES poll_questions(id),
  weight NUMERIC NOT NULL CHECK (weight >= 0),
  PRIMARY KEY (model_run_id, poll_question_id)
);

CREATE TABLE model_run_snapshot_inputs (
  model_run_id BIGINT NOT NULL REFERENCES model_runs(id) ON DELETE CASCADE,
  result_snapshot_id BIGINT NOT NULL REFERENCES result_snapshots(id),
  PRIMARY KEY (model_run_id, result_snapshot_id)
);

CREATE TABLE model_estimates (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  model_run_id BIGINT NOT NULL REFERENCES model_runs(id) ON DELETE CASCADE,
  contest_id BIGINT NOT NULL REFERENCES contests(id),
  geography_id BIGINT NOT NULL REFERENCES geographies(id),
  contest_choice_id BIGINT REFERENCES contest_choices(id),
  metric TEXT NOT NULL,
  estimate NUMERIC NOT NULL,
  lower_bound NUMERIC,
  upper_bound NUMERIC,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  CHECK (lower_bound IS NULL OR upper_bound IS NULL OR lower_bound <= upper_bound),
  UNIQUE NULLS NOT DISTINCT (model_run_id, geography_id, contest_choice_id, metric)
);

CREATE INDEX model_estimates_contest_geography_idx ON model_estimates (contest_id, geography_id, model_run_id);

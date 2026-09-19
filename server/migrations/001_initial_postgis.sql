CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS races (
  id TEXT PRIMARY KEY,
  cycle INTEGER NOT NULL,
  election_type TEXT NOT NULL CHECK (election_type IN ('primary', 'general', 'presidential_primary', 'presidential_general')),
  election_level TEXT NOT NULL,
  office TEXT NOT NULL,
  jurisdiction TEXT NOT NULL,
  is_ballot_measure BOOLEAN NOT NULL DEFAULT FALSE,
  candidate_a TEXT,
  candidate_b TEXT
);

CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  race_id TEXT NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  observed_at TIMESTAMPTZ NOT NULL,
  metric TEXT NOT NULL,
  value_a DOUBLE PRECISION,
  value_b DOUBLE PRECISION,
  reporting DOUBLE PRECISION CHECK (reporting BETWEEN 0 AND 100),
  source TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ingest_runs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL,
  rows_added INTEGER NOT NULL DEFAULT 0,
  message TEXT
);

CREATE INDEX IF NOT EXISTS observations_race_time_idx ON observations (race_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS races_archive_filter_idx ON races (cycle DESC, election_type, office);
CREATE INDEX IF NOT EXISTS ingest_runs_started_idx ON ingest_runs (started_at DESC);

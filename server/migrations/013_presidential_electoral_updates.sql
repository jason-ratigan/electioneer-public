-- Future state reports are append-only. The latest report for each state is displayed.
CREATE TABLE presidential_electoral_updates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle INTEGER NOT NULL,
  state_fips TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('projected', 'certified')),
  source_url TEXT NOT NULL,
  reported_at TIMESTAMPTZ NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  file_sha256 TEXT NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  FOREIGN KEY (cycle, state_fips)
    REFERENCES presidential_electoral_states(cycle, state_fips),
  UNIQUE (cycle, state_fips, file_sha256)
);

CREATE INDEX presidential_electoral_updates_latest_idx
  ON presidential_electoral_updates (cycle, state_fips, reported_at DESC, imported_at DESC);

CREATE TABLE presidential_electoral_update_votes (
  update_id UUID NOT NULL REFERENCES presidential_electoral_updates(id) ON DELETE CASCADE,
  recipient_name TEXT NOT NULL,
  party_abbreviation TEXT,
  votes SMALLINT NOT NULL CHECK (votes > 0),
  PRIMARY KEY (update_id, recipient_name)
);

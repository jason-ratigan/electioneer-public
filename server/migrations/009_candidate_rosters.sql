INSERT INTO data_sources (slug, name, homepage_url, enabled, metadata)
VALUES (
  'ballotpedia',
  'Ballotpedia',
  'https://ballotpedia.org/',
  TRUE,
  '{"authority":"secondary","uses":["candidate-discovery"]}'::JSONB
)
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  homepage_url = EXCLUDED.homepage_url,
  enabled = EXCLUDED.enabled,
  metadata = data_sources.metadata || EXCLUDED.metadata;

CREATE TABLE candidate_roster_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle INTEGER NOT NULL CHECK (cycle >= 1788),
  office_id UUID NOT NULL REFERENCES offices(id),
  district_geography_id UUID NOT NULL REFERENCES geographies(id),
  candidate_id UUID NOT NULL REFERENCES candidates(id),
  party_id UUID REFERENCES parties(id),
  source_id UUID NOT NULL REFERENCES data_sources(id),
  source_artifact_id UUID REFERENCES source_artifacts(id),
  identifier_namespace TEXT NOT NULL,
  source_identifier TEXT NOT NULL,
  candidate_name TEXT NOT NULL,
  party_label TEXT,
  roster_status TEXT NOT NULL DEFAULT 'source_listed' CHECK (roster_status IN (
    'source_listed', 'filed', 'qualified', 'withdrawn', 'disqualified',
    'lost_primary', 'advanced_to_runoff', 'general_candidate'
  )),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_id, identifier_namespace, source_identifier)
);

CREATE INDEX candidate_roster_race_idx
  ON candidate_roster_entries (cycle, office_id, district_geography_id);

CREATE INDEX candidate_roster_candidate_idx
  ON candidate_roster_entries (candidate_id, cycle);

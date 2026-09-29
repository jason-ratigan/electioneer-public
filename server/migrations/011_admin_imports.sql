INSERT INTO data_sources (slug, name, homepage_url, license, metadata)
VALUES ('nyt-polls', 'The New York Times', 'https://www.nytimes.com/interactive/polls/', 'CC BY 4.0',
  '{"attributionRequired":true,"licenseUrl":"https://creativecommons.org/licenses/by/4.0/","licenseBasis":"Uploader supplied NYT polling downloads; see import documentation"}')
ON CONFLICT (slug) DO NOTHING;

CREATE TABLE admin_imports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filename TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size BIGINT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','validating','ready','committing','completed','failed')),
  phase TEXT NOT NULL DEFAULT 'preview',
  progress INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  preview JSONB,
  report JSONB,
  confirmation TEXT,
  source_url TEXT,
  license TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ,
  ingestion_run_id UUID REFERENCES ingestion_runs(id)
);
CREATE INDEX admin_import_queue_idx ON admin_imports (created_at) WHERE status IN ('queued','validating','committing');

ALTER TABLE pollsters DROP CONSTRAINT pollsters_name_key;
ALTER TABLE pollsters ADD COLUMN source_id UUID REFERENCES data_sources(id), ADD COLUMN source_identifier TEXT;
CREATE UNIQUE INDEX pollsters_source_idx ON pollsters(source_id,source_identifier);
ALTER TABLE polls ADD COLUMN source_id UUID REFERENCES data_sources(id), ADD COLUMN source_identifier TEXT;
CREATE UNIQUE INDEX polls_source_idx ON polls(source_id,source_identifier);

-- Source race identity is independent of an official contest or ballot qualification.
CREATE TABLE polling_races (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES data_sources(id),
  source_identifier TEXT NOT NULL,
  UNIQUE(source_id, source_identifier)
);
ALTER TABLE poll_questions ALTER COLUMN contest_id DROP NOT NULL;
ALTER TABLE poll_questions ADD COLUMN source_id UUID REFERENCES data_sources(id),
  ADD COLUMN source_identifier TEXT,
  ADD COLUMN source_artifact_id UUID REFERENCES source_artifacts(id),
  ADD COLUMN ingestion_run_id UUID REFERENCES ingestion_runs(id),
  ADD COLUMN revision_of_question_id UUID REFERENCES poll_questions(id),
  ADD COLUMN content_sha256 TEXT,
  ADD COLUMN recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN question_kind TEXT NOT NULL DEFAULT 'election' CHECK(question_kind IN ('election','generic_ballot','approval')),
  ADD COLUMN polling_race_id UUID REFERENCES polling_races(id),
  ADD COLUMN geography_id UUID REFERENCES geographies(id),
  ADD COLUMN field_start DATE,
  ADD COLUMN field_end DATE,
  ADD COLUMN population TEXT,
  ADD COLUMN cycle INTEGER,
  ADD COLUMN office_slug TEXT,
  ADD COLUMN stage TEXT,
  ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}'::JSONB;
CREATE INDEX poll_questions_source_idx ON poll_questions(source_id,source_identifier,recorded_at DESC);
CREATE UNIQUE INDEX poll_questions_artifact_idx ON poll_questions(source_id,source_identifier,source_artifact_id);
ALTER TABLE poll_responses DROP CONSTRAINT poll_responses_pkey;
ALTER TABLE poll_responses ADD COLUMN id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ADD COLUMN source_identifier TEXT,
  ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}'::JSONB;
CREATE UNIQUE INDEX poll_responses_source_idx ON poll_responses(question_id,source_identifier);

CREATE TABLE published_poll_averages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES data_sources(id),
  source_artifact_id UUID NOT NULL REFERENCES source_artifacts(id),
  ingestion_run_id UUID NOT NULL REFERENCES ingestion_runs(id),
  series_identifier TEXT NOT NULL,
  observed_on DATE NOT NULL,
  response_label TEXT NOT NULL,
  share NUMERIC(7,4) NOT NULL CHECK (share BETWEEN 0 AND 100),
  revision_of_id UUID REFERENCES published_poll_averages(id),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  UNIQUE(source_artifact_id,series_identifier,observed_on,response_label)
);
CREATE INDEX published_averages_series_idx ON published_poll_averages(source_id,series_identifier,observed_on,response_label,recorded_at DESC);

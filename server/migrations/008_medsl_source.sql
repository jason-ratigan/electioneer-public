INSERT INTO data_sources (slug, name, homepage_url, enabled, metadata)
VALUES (
  'medsl',
  'MIT Election Data and Science Lab',
  'https://electionlab.mit.edu/data',
  TRUE,
  '{"uses":["official-precinct-returns"]}'::JSONB
)
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  homepage_url = EXCLUDED.homepage_url,
  enabled = EXCLUDED.enabled,
  metadata = data_sources.metadata || EXCLUDED.metadata;

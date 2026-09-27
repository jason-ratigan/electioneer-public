INSERT INTO data_sources (slug, name, homepage_url, license, enabled, metadata)
VALUES
  (
    'wikipedia',
    'English Wikipedia',
    'https://en.wikipedia.org/',
    'CC BY-SA 4.0',
    TRUE,
    '{"authority":"secondary","uses":["candidate-discovery","nominee-reconciliation"],"attributionRequired":true}'::JSONB
  ),
  (
    'fec',
    'Federal Election Commission',
    'https://www.fec.gov/',
    'United States government public data',
    TRUE,
    '{"authority":"official-federal-filing","uses":["candidate-identity","campaign-registration"],"notBallotQualification":true}'::JSONB
  )
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  homepage_url = EXCLUDED.homepage_url,
  license = EXCLUDED.license,
  enabled = EXCLUDED.enabled,
  metadata = data_sources.metadata || EXCLUDED.metadata;

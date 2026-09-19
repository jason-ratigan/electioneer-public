INSERT INTO data_sources (slug, name, homepage_url, license, enabled, metadata)
VALUES (
  'census',
  'U.S. Census Bureau',
  'https://www.census.gov/geographies/mapping-files/time-series/geo/cartographic-boundary.html',
  'Public domain',
  TRUE,
  '{"uses":["cartographic-boundaries"]}'::JSONB
)
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  homepage_url = EXCLUDED.homepage_url,
  license = EXCLUDED.license,
  enabled = EXCLUDED.enabled,
  metadata = data_sources.metadata || EXCLUDED.metadata;

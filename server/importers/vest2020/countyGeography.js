import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { feature } from 'topojson-client';

const countyTopologyPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../node_modules/us-atlas/counties-10m.json'
);
const validityStart = '2020-01-01';
const validityEnd = '2020-12-31';
let atlasPromise;

async function one(client, sql, params = []) {
  const result = await client.query(sql, params);
  if (result.rows.length !== 1) throw new Error(`Expected one row, received ${result.rows.length}`);
  return result.rows[0];
}

function countyName(state, name) {
  if (state.code === 'la') return `${name} Parish`;
  if (state.code === 'ak' || state.code === 'dc' || /\b(?:city|borough|municipality|census area)$/i.test(name)) return name;
  return `${name} County`;
}

async function loadAtlas() {
  if (!atlasPromise) {
    atlasPromise = fs.readFile(countyTopologyPath).then(bytes => {
      const topology = JSON.parse(bytes.toString('utf8'));
      return {
        bytes,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        features: feature(topology, topology.objects.counties).features
      };
    });
  }
  return atlasPromise;
}

export async function ensureStateCounties(client, { state, stateGeographyId, precinctIds, electionDate }) {
  const atlas = await loadAtlas();
  const countyFeatures = atlas.features
    .filter(item => String(item.id).padStart(5, '0').startsWith(state.stateFips))
    .map(item => ({ ...item, id: String(item.id).padStart(5, '0') }));
  if (!countyFeatures.length) throw new Error(`No us-atlas county boundaries found for ${state.abbreviation}`);

  const source = await one(client, "SELECT id FROM data_sources WHERE slug = 'census'");
  const artifact = await one(client, `
    INSERT INTO source_artifacts (
      source_id, uri, retrieved_at, sha256, byte_size, content_type,
      source_version, license, metadata
    ) VALUES (
      $1, 'npm:us-atlas@3.0.1/counties-10m.json', NOW(), $2, $3,
      'application/topo+json', 'us-atlas@3.0.1', 'Public domain',
      '{"boundaryVintage":2017,"resolution":"1:10m"}'::JSONB
    )
    ON CONFLICT (source_id, sha256) WHERE sha256 IS NOT NULL DO UPDATE SET
      uri = EXCLUDED.uri,
      byte_size = EXCLUDED.byte_size,
      content_type = EXCLUDED.content_type,
      source_version = EXCLUDED.source_version,
      license = EXCLUDED.license,
      metadata = source_artifacts.metadata || EXCLUDED.metadata
    RETURNING id
  `, [source.id, atlas.sha256, atlas.bytes.length]);

  const countyIds = [];
  for (const county of countyFeatures) {
    const geography = await one(client, `
      INSERT INTO geographies (
        geography_type, name, abbreviation, state_fips, county_fips, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6::JSONB)
      ON CONFLICT (geography_type, state_fips, county_fips, name) DO UPDATE SET
        abbreviation = EXCLUDED.abbreviation,
        metadata = geographies.metadata || EXCLUDED.metadata
      RETURNING id
    `, [
      ['ak', 'dc', 'la'].includes(state.code) ? 'county_equivalent' : 'county',
      countyName(state, county.properties.name),
      county.id,
      state.stateFips,
      county.id.slice(2),
      JSON.stringify({
        fips: county.id,
        censusName: county.properties.name,
        boundarySource: 'us-atlas@3.0.1'
      })
    ]);
    countyIds.push(geography.id);
    await client.query(`
      INSERT INTO geography_source_ids (
        geography_id, source_id, source_identifier, identifier_namespace
      ) VALUES ($1, $2, $3, 'us-atlas:counties-10m')
      ON CONFLICT (source_id, identifier_namespace, source_identifier) DO UPDATE SET
        geography_id = EXCLUDED.geography_id
    `, [geography.id, source.id, county.id]);
    await client.query(`
      INSERT INTO geography_versions (
        geography_id, source_artifact_id, valid_from, valid_to, geom,
        is_estimated, methodology, metadata
      )
      SELECT
        $1, $2, $3, $4,
        ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_GeomFromGeoJSON($5)), 3)),
        FALSE,
        'us-atlas 1:10m county boundary, derived from U.S. Census Bureau cartographic boundary data.',
        '{"boundaryVintage":2017}'::JSONB
      ON CONFLICT (geography_id, valid_from, valid_to) DO UPDATE SET
        source_artifact_id = EXCLUDED.source_artifact_id,
        geom = EXCLUDED.geom,
        methodology = EXCLUDED.methodology,
        metadata = geography_versions.metadata || EXCLUDED.metadata
    `, [geography.id, artifact.id, validityStart, validityEnd, JSON.stringify(county.geometry)]);
    await client.query(`
      INSERT INTO geography_relationships (
        parent_geography_id, child_geography_id, relationship_type, valid_from, valid_to
      ) VALUES ($1, $2, 'contains', $3, $4)
      ON CONFLICT (parent_geography_id, child_geography_id, relationship_type, valid_from)
      DO UPDATE SET valid_to = EXCLUDED.valid_to
    `, [stateGeographyId, geography.id, validityStart, validityEnd]);
  }

  const assignment = await one(client, `
    WITH precinct_versions AS (
      SELECT
        precinct.id AS precinct_id,
        precinct.county_fips,
        precinct.metadata->>'sourceCountyName' AS source_county_name,
        version.geom
      FROM geographies precinct
      JOIN geography_versions version ON version.geography_id = precinct.id
      WHERE precinct.id = ANY($1::UUID[])
        AND version.valid_from <= $2::DATE
        AND (version.valid_to IS NULL OR version.valid_to >= $2::DATE)
    ),
    county_versions AS (
      SELECT
        county.id AS county_id,
        county.county_fips,
        county.metadata->>'censusName' AS census_name,
        version.geom
      FROM geographies county
      JOIN geography_versions version ON version.geography_id = county.id
      WHERE county.id = ANY($3::UUID[])
        AND version.valid_from <= $2::DATE
        AND (version.valid_to IS NULL OR version.valid_to >= $2::DATE)
    ),
    direct AS (
      SELECT
        precinct.precinct_id,
        county.county_id,
        county.county_fips,
        'source county FIPS'::TEXT AS method
      FROM precinct_versions precinct
      JOIN county_versions county
        ON county.county_fips = precinct.county_fips
        OR (
          precinct.county_fips IS NULL
          AND precinct.source_county_name IS NOT NULL
          AND REGEXP_REPLACE(LOWER(precinct.source_county_name), '[^a-z0-9]', '', 'g')
            = REGEXP_REPLACE(LOWER(county.census_name), '[^a-z0-9]', '', 'g')
        )
    ),
    unmatched AS (
      SELECT precinct.*
      FROM precinct_versions precinct
      LEFT JOIN direct ON direct.precinct_id = precinct.precinct_id
      WHERE direct.precinct_id IS NULL
    ),
    spatial AS (
      SELECT
        precinct.precinct_id,
        COALESCE(intersecting.county_id, nearest.county_id) AS county_id,
        COALESCE(intersecting.county_fips, nearest.county_fips) AS county_fips,
        CASE WHEN intersecting.county_id IS NOT NULL
             THEN 'largest-area spatial intersection'
             ELSE 'nearest county boundary fallback' END AS method
      FROM unmatched precinct
      LEFT JOIN LATERAL (
        SELECT
          county.county_id,
          county.county_fips
        FROM county_versions county
        WHERE ST_Intersects(precinct.geom, county.geom)
        ORDER BY ST_Area(ST_Intersection(precinct.geom, county.geom)::GEOGRAPHY) DESC
        LIMIT 1
      ) intersecting ON TRUE
      LEFT JOIN LATERAL (
        SELECT county.county_id, county.county_fips
        FROM county_versions county
        WHERE intersecting.county_id IS NULL
        ORDER BY ST_Distance(precinct.geom::GEOGRAPHY, county.geom::GEOGRAPHY)
        LIMIT 1
      ) nearest ON TRUE
    ),
    selected AS (
      SELECT * FROM direct
      UNION ALL
      SELECT * FROM spatial
    ),
    linked AS (
      INSERT INTO geography_relationships (
        parent_geography_id, child_geography_id, relationship_type, valid_from, valid_to, metadata
      )
      SELECT county_id, precinct_id, 'contains', $4::DATE, $5::DATE,
             JSONB_BUILD_OBJECT('method', method)
      FROM selected
      ON CONFLICT (parent_geography_id, child_geography_id, relationship_type, valid_from)
      DO UPDATE SET valid_to = EXCLUDED.valid_to, metadata = EXCLUDED.metadata
      RETURNING child_geography_id
    ),
    updated AS (
      UPDATE geographies precinct
      SET county_fips = selected.county_fips
      FROM selected
      WHERE precinct.id = selected.precinct_id
      RETURNING precinct.id
    )
    SELECT
      (SELECT COUNT(*)::INTEGER FROM precinct_versions) AS precinct_count,
      (SELECT COUNT(*)::INTEGER FROM selected) AS assigned_count,
      (SELECT COUNT(*)::INTEGER FROM linked) AS linked_count,
      (SELECT COUNT(*)::INTEGER FROM selected WHERE method = 'nearest county boundary fallback') AS fallback_count
  `, [precinctIds, electionDate, countyIds, validityStart, validityEnd]);

  if (assignment.precinct_count !== precinctIds.length || assignment.assigned_count !== precinctIds.length) {
    throw new Error(`${state.abbreviation} county assignment incomplete: ${JSON.stringify(assignment)}`);
  }
  return { counties: countyFeatures.length, ...assignment };
}

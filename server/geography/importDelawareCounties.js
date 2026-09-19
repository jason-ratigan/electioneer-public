import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { feature } from 'topojson-client';
import { db, closeDatabase, initializeDatabase } from '../db.js';

const electionDate = '2020-11-03';
const validityStart = '2020-01-01';
const validityEnd = '2020-12-31';
const stateFips = '10';
const countyTopologyPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../node_modules/us-atlas/counties-10m.json'
);

async function one(client, sql, params = []) {
  const result = await client.query(sql, params);
  if (result.rows.length !== 1) throw new Error(`Expected one row, received ${result.rows.length}`);
  return result.rows[0];
}

async function loadDelawareCounties() {
  const bytes = await fs.readFile(countyTopologyPath);
  const topology = JSON.parse(bytes.toString('utf8'));
  const collection = feature(topology, topology.objects.counties);
  const counties = collection.features
    .filter(item => String(item.id).padStart(5, '0').startsWith(stateFips))
    .map(item => ({
      id: String(item.id).padStart(5, '0'),
      name: item.properties.name,
      geometry: item.geometry
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (counties.length !== 3) throw new Error(`Expected 3 Delaware counties, received ${counties.length}`);
  return {
    counties,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    byteSize: bytes.byteLength
  };
}

export async function importDelawareCounties() {
  const atlas = await loadDelawareCounties();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('signal:geography:de-counties:2020'))");

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
    `, [source.id, atlas.sha256, atlas.byteSize]);
    const state = await one(client, `
      SELECT id
      FROM geographies
      WHERE geography_type = 'state' AND state_fips = $1
    `, [stateFips]);

    const countyIds = [];
    for (const county of atlas.counties) {
      const geography = await one(client, `
        INSERT INTO geographies (
          geography_type, name, abbreviation, state_fips, county_fips, metadata
        ) VALUES (
          'county', $1, $2, $3, $4, $5::JSONB
        )
        ON CONFLICT (geography_type, state_fips, county_fips, name) DO UPDATE SET
          abbreviation = EXCLUDED.abbreviation,
          metadata = geographies.metadata || EXCLUDED.metadata
        RETURNING id
      `, [
        `${county.name} County`,
        county.id,
        stateFips,
        county.id.slice(2),
        JSON.stringify({ fips: county.id, boundarySource: 'us-atlas@3.0.1' })
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
          CASE
            WHEN GeometryType(ST_GeomFromGeoJSON($5)) = 'POLYGON'
              THEN ST_Multi(ST_GeomFromGeoJSON($5))
            ELSE ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_GeomFromGeoJSON($5)), 3))
          END,
          FALSE,
          'us-atlas 1:10m county boundary, derived from U.S. Census Bureau cartographic boundary data.',
          '{"boundaryVintage":2017}'::JSONB
        ON CONFLICT (geography_id, valid_from, valid_to) DO UPDATE SET
          source_artifact_id = EXCLUDED.source_artifact_id,
          geom = EXCLUDED.geom,
          methodology = EXCLUDED.methodology,
          metadata = geography_versions.metadata || EXCLUDED.metadata
      `, [
        geography.id,
        artifact.id,
        validityStart,
        validityEnd,
        JSON.stringify(county.geometry)
      ]);

      await client.query(`
        INSERT INTO geography_relationships (
          parent_geography_id, child_geography_id, relationship_type, valid_from, valid_to
        ) VALUES ($1, $2, 'contains', $3, $4)
        ON CONFLICT (parent_geography_id, child_geography_id, relationship_type, valid_from)
        DO UPDATE SET valid_to = EXCLUDED.valid_to
      `, [state.id, geography.id, validityStart, validityEnd]);
    }

    const assignment = await client.query(`
      WITH precinct_versions AS (
        SELECT DISTINCT ON (g.id)
          g.id AS precinct_id,
          gv.geom
        FROM geographies g
        JOIN geography_versions gv ON gv.geography_id = g.id
        WHERE g.geography_type = 'precinct'
          AND g.state_fips = $1
          AND gv.valid_from <= $2::DATE
          AND (gv.valid_to IS NULL OR gv.valid_to >= $2::DATE)
        ORDER BY g.id, gv.valid_from DESC
      ),
      county_versions AS (
        SELECT DISTINCT ON (g.id)
          g.id AS county_id,
          g.county_fips,
          gv.geom
        FROM geographies g
        JOIN geography_versions gv ON gv.geography_id = g.id
        WHERE g.id = ANY($3::UUID[])
          AND gv.valid_from <= $2::DATE
          AND (gv.valid_to IS NULL OR gv.valid_to >= $2::DATE)
        ORDER BY g.id, gv.valid_from DESC
      ),
      ranked AS (
        SELECT
          precinct.precinct_id,
          county.county_id,
          county.county_fips,
          ROW_NUMBER() OVER (
            PARTITION BY precinct.precinct_id
            ORDER BY ST_Area(ST_Intersection(precinct.geom, county.geom)::GEOGRAPHY) DESC
          ) AS rank
        FROM precinct_versions precinct
        JOIN county_versions county ON ST_Intersects(precinct.geom, county.geom)
      ),
      selected AS (
        SELECT precinct_id, county_id, county_fips
        FROM ranked
        WHERE rank = 1
      ),
      linked AS (
        INSERT INTO geography_relationships (
          parent_geography_id, child_geography_id, relationship_type, valid_from, valid_to,
          metadata
        )
        SELECT
          county_id, precinct_id, 'contains', $4::DATE, $5::DATE,
          '{"method":"largest-area spatial intersection"}'::JSONB
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
        (SELECT COUNT(*)::INTEGER FROM updated) AS updated_count
    `, [stateFips, electionDate, countyIds, validityStart, validityEnd]);

    const counts = assignment.rows[0];
    if (counts.precinct_count !== counts.assigned_count || counts.precinct_count !== counts.linked_count) {
      throw new Error(`County assignment incomplete: ${JSON.stringify(counts)}`);
    }

    await client.query('COMMIT');
    return {
      counties: atlas.counties.map(county => ({ fips: county.id, name: `${county.name} County` })),
      ...counts
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  try {
    await initializeDatabase();
    const result = await importDelawareCounties();
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await closeDatabase();
  }
}

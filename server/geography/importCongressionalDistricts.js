import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import proj4 from 'proj4';
import * as shapefile from 'shapefile';
import unzipper from 'unzipper';
import { closeDatabase, db, initializeDatabase } from '../db.js';

const defaultArchive = path.resolve('data/census/cb_2020_us_cd116_5m.zip');
const sourceUrl = 'https://www2.census.gov/geo/tiger/GENZ2020/shp/cb_2020_us_cd116_5m.zip';
const basename = 'cb_2020_us_cd116_5m';
const validFrom = '2019-01-03';
const validTo = '2021-01-02';

async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function entry(directory, extension) {
  const expected = `${basename}.${extension}`;
  const matches = directory.files.filter(item => item.path === expected);
  if (matches.length !== 1) throw new Error(`Expected exactly one ${expected}; found ${matches.length}`);
  return matches[0];
}

function transformCoordinates(coordinates, transform) {
  if (typeof coordinates[0] === 'number') return transform.forward(coordinates);
  return coordinates.map(value => transformCoordinates(value, transform));
}

function transformGeometry(geometry, transform) {
  if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) {
    throw new Error(`Expected Polygon or MultiPolygon; received ${geometry?.type || 'none'}`);
  }
  return { ...geometry, coordinates: transformCoordinates(geometry.coordinates, transform) };
}

async function row(client, sql, params = []) {
  const result = await client.query(sql, params);
  if (result.rows.length !== 1) throw new Error(`Expected one database row; received ${result.rows.length}`);
  return result.rows[0];
}

export async function importCongressionalDistricts(archivePath = defaultArchive) {
  const resolvedPath = path.resolve(archivePath);
  const archiveStat = await stat(resolvedPath);
  const directory = await unzipper.Open.file(resolvedPath);
  const [shp, dbf, prj] = await Promise.all([
    entry(directory, 'shp').buffer(),
    entry(directory, 'dbf').buffer(),
    entry(directory, 'prj').buffer()
  ]);
  const transform = proj4(prj.toString('utf8').trim(), 'EPSG:4326');
  const source = await shapefile.open(shp, dbf);
  const client = await db.connect();
  const runId = randomUUID();
  try {
    await client.query('BEGIN');
    const census = await row(client, "SELECT id FROM data_sources WHERE slug = 'census'");
    const checksum = await sha256File(resolvedPath);
    const artifact = await row(client, `
      INSERT INTO source_artifacts (
        source_id, uri, retrieved_at, sha256, byte_size, content_type,
        source_version, metadata
      ) VALUES ($1, $2, $3, $4, $5, 'application/zip', '2020 CD116 1:5,000,000', $6::JSONB)
      ON CONFLICT (source_id, sha256) WHERE sha256 IS NOT NULL DO UPDATE SET
        uri = EXCLUDED.uri,
        retrieved_at = EXCLUDED.retrieved_at,
        metadata = source_artifacts.metadata || EXCLUDED.metadata
      RETURNING id
    `, [
      census.id,
      sourceUrl,
      archiveStat.mtime.toISOString(),
      checksum,
      archiveStat.size,
      JSON.stringify({ localArchive: pathToFileURL(resolvedPath).href, congress: 116, scale: '1:5,000,000' })
    ]);
    await client.query(`
      INSERT INTO ingestion_runs (
        id, source_id, source_artifact_id, started_at, status,
        parser_name, parser_version, metadata
      ) VALUES ($1, $2, $3, NOW(), 'running', 'census-cd116-boundaries', '1.0.0', $4::JSONB)
    `, [runId, census.id, artifact.id, JSON.stringify({ congress: 116 })]);
    const statesResult = await client.query(`
      SELECT id, name, abbreviation, state_fips
      FROM geographies
      WHERE geography_type = 'state'
    `);
    const states = new Map(statesResult.rows.map(state => [state.state_fips, state]));
    let imported = 0;
    let skipped = 0;
    let repaired = 0;

    while (true) {
      const record = await source.read();
      if (record.done) break;
      const properties = record.value.properties;
      const state = states.get(properties.STATEFP);
      if (!state) {
        skipped += 1;
        continue;
      }
      const atLarge = properties.CD116FP === '00' || properties.CD116FP === '98';
      const districtCode = atLarge ? 'AL' : properties.CD116FP;
      const abbreviation = `${state.abbreviation}-${districtCode}`;
      const name = atLarge
        ? `${state.name} Congressional District At-Large`
        : `${state.name} Congressional District ${Number(districtCode)}`;
      let districts = await client.query(`
        SELECT id
        FROM geographies
        WHERE geography_type = 'congressional_district'
          AND state_fips = $1 AND abbreviation = $2
      `, [state.state_fips, abbreviation]);
      if (!districts.rows.length) {
        districts = await client.query(`
          INSERT INTO geographies (
            geography_type, name, abbreviation, state_fips, metadata
          ) VALUES ('congressional_district', $1, $2, $3, $4::JSONB)
          RETURNING id
        `, [
          name,
          abbreviation,
          state.state_fips,
          JSON.stringify({ districtLabel: atLarge ? 'At-Large' : `District ${Number(districtCode)}` })
        ]);
      }
      const geometry = transformGeometry(record.value.geometry, transform);
      for (const district of districts.rows) {
        const version = await row(client, `
          WITH prepared AS (
            SELECT ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)) AS raw_geom
          )
          INSERT INTO geography_versions (
            geography_id, source_artifact_id, valid_from, valid_to, geom,
            is_estimated, methodology, metadata
          )
          SELECT
            $2, $5, $3, $4,
            CASE WHEN ST_IsValid(raw_geom) THEN raw_geom
                 ELSE ST_Multi(ST_CollectionExtract(ST_MakeValid(raw_geom), 3)) END,
            FALSE,
            'U.S. Census Bureau 2020 cartographic boundary file for the 116th Congress.',
            JSONB_BUILD_OBJECT(
              'geoid', $6::TEXT,
              'congress', 116,
              'geometryRepaired', NOT ST_IsValid(raw_geom)
            )
          FROM prepared
          ON CONFLICT (geography_id, valid_from, valid_to) DO UPDATE SET
            source_artifact_id = EXCLUDED.source_artifact_id,
            geom = EXCLUDED.geom,
            methodology = EXCLUDED.methodology,
            metadata = EXCLUDED.metadata
          RETURNING (metadata->>'geometryRepaired')::BOOLEAN AS was_repaired
        `, [JSON.stringify(geometry), district.id, validFrom, validTo, artifact.id, properties.GEOID]);
        if (version.was_repaired) repaired += 1;
        await client.query(`
          INSERT INTO geography_relationships (
            parent_geography_id, child_geography_id, relationship_type, valid_from, valid_to
          ) VALUES ($1, $2, 'contains', $3, $4)
          ON CONFLICT (parent_geography_id, child_geography_id, relationship_type, valid_from)
          DO UPDATE SET valid_to = EXCLUDED.valid_to
        `, [state.id, district.id, validFrom, validTo]);
      }
      const primaryDistrictId = districts.rows[0].id;
      await client.query(`
        INSERT INTO geography_source_ids (
          geography_id, source_id, identifier_namespace, source_identifier
        ) VALUES ($1, $2, 'census:2020:cd116', $3)
        ON CONFLICT (source_id, identifier_namespace, source_identifier) DO UPDATE SET
          geography_id = EXCLUDED.geography_id
      `, [primaryDistrictId, census.id, properties.GEOID]);
      imported += 1;
    }
    await client.query(`
      UPDATE ingestion_runs
      SET completed_at = NOW(),
          status = CASE WHEN $3 > 0 THEN 'completed_with_warnings' ELSE 'completed' END,
          rows_read = $2::BIGINT + $4::BIGINT,
          rows_added = $2,
          warning_count = $3,
          message = $5,
          metadata = metadata || $6::JSONB
      WHERE id = $1
    `, [
      runId,
      imported,
      repaired,
      skipped,
      `Imported ${imported} congressional district boundaries for the 116th Congress.`,
      JSON.stringify({ skippedOutsideApplicationStates: skipped, geometryRepairs: repaired })
    ]);
    await client.query('COMMIT');
    return { imported, skipped, repaired, artifactId: String(artifact.id) };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  let exitCode = 0;
  try {
    const archiveIndex = process.argv.indexOf('--archive');
    const archivePath = archiveIndex >= 0 ? process.argv[archiveIndex + 1] : defaultArchive;
    if (archiveIndex >= 0 && !archivePath) throw new Error('--archive requires a path');
    await initializeDatabase();
    console.log(JSON.stringify(await importCongressionalDistricts(archivePath), null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    exitCode = 1;
  } finally {
    await closeDatabase();
    process.exitCode = exitCode;
  }
}

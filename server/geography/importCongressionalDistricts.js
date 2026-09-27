import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import proj4 from 'proj4';
import * as shapefile from 'shapefile';
import unzipper from 'unzipper';
import { closeDatabase, db, initializeDatabase } from '../db.js';

const configurations = new Map([
  [116, {
    format: 'shapefile',
    defaultArchive: path.resolve('data/census/cb_2020_us_cd116_5m.zip'),
    sourceUrl: 'https://www2.census.gov/geo/tiger/GENZ2020/shp/cb_2020_us_cd116_5m.zip',
    basename: 'cb_2020_us_cd116_5m',
    districtField: 'CD116FP',
    sourceVersion: '2020 CD116 1:5,000,000',
    validFrom: '2019-01-03',
    validTo: '2021-01-02'
  }],
  [118, {
    format: 'shapefile',
    defaultArchive: path.resolve('data/census/cb_2023_us_cd118_5m.zip'),
    sourceUrl: 'https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_cd118_5m.zip',
    basename: 'cb_2023_us_cd118_5m',
    districtField: 'CD118FP',
    sourceVersion: '2023 CD118 1:5,000,000',
    validFrom: '2023-01-03',
    validTo: '2025-01-02'
  }],
  [120, {
    format: 'geopackage',
    defaultArchive: path.resolve('tlgpkg_2026_us_legislative.gpkg.zip'),
    sourceUrl: 'https://www2.census.gov/geo/tiger/TGRGPKG26/tlgpkg_2026_us_legislative.gpkg.zip',
    archiveEntry: 'tlgpkg_2026_us_legislative.gpkg',
    layer: 'Congressional Districts',
    geometryField: 'shape',
    districtField: 'CD120FP',
    sourceVersion: '2026 TIGER/Line CD120 national legislative GeoPackage',
    validFrom: '2026-01-01',
    validTo: '2027-12-31',
    metadata: { missouriPolicy: 'imported_as_provided' }
  }]
]);

async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function entry(directory, basename, extension) {
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

function sqliteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

export function decodeGeoPackageGeometry(value) {
  const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (bytes.length < 9 || bytes[0] !== 0x47 || bytes[1] !== 0x50) {
    throw new Error('Invalid GeoPackage geometry header');
  }
  const flags = bytes[3];
  const littleEndian = (flags & 1) === 1;
  const envelopeIndicator = (flags >> 1) & 7;
  const envelopeSizes = [0, 32, 48, 48, 64];
  if (envelopeIndicator >= envelopeSizes.length) {
    throw new Error(`Unsupported GeoPackage geometry envelope: ${envelopeIndicator}`);
  }
  if ((flags & 0x10) !== 0) throw new Error('GeoPackage geometry is empty');
  const headerLength = 8 + envelopeSizes[envelopeIndicator];
  if (bytes.length <= headerLength) throw new Error('GeoPackage geometry has no WKB payload');
  return {
    srsId: littleEndian ? bytes.readInt32LE(4) : bytes.readInt32BE(4),
    wkb: bytes.subarray(headerLength)
  };
}

async function openShapefileBoundarySource(directory, configuration) {
  const [shp, dbf, prj] = await Promise.all([
    entry(directory, configuration.basename, 'shp').buffer(),
    entry(directory, configuration.basename, 'dbf').buffer(),
    entry(directory, configuration.basename, 'prj').buffer()
  ]);
  const transform = proj4(prj.toString('utf8').trim(), 'EPSG:4326');
  const source = await shapefile.open(shp, dbf);
  return {
    async read() {
      const record = await source.read();
      if (record.done) return record;
      return {
        done: false,
        value: {
          properties: record.value.properties,
          geometry: {
            format: 'geojson',
            value: JSON.stringify(transformGeometry(record.value.geometry, transform)),
            srid: 4326
          }
        }
      };
    },
    async close() {}
  };
}

async function openGeoPackageBoundarySource(directory, configuration) {
  const matches = directory.files.filter(item => item.path === configuration.archiveEntry);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${configuration.archiveEntry}; found ${matches.length}`);
  }
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'signal-census-gpkg-'));
  const databasePath = path.join(temporaryDirectory, path.basename(configuration.archiveEntry));
  let database;
  try {
    await pipeline(matches[0].stream(), createWriteStream(databasePath));
    const { DatabaseSync } = await import('node:sqlite');
    database = new DatabaseSync(databasePath, { readOnly: true });
    const layer = database.prepare(`
      SELECT c.srs_id, g.column_name, g.geometry_type_name
      FROM gpkg_contents c
      JOIN gpkg_geometry_columns g ON g.table_name = c.table_name
      WHERE c.data_type = 'features' AND c.table_name = ?
    `).get(configuration.layer);
    if (!layer) throw new Error(`GeoPackage layer not found: ${configuration.layer}`);
    if (layer.column_name !== configuration.geometryField || layer.geometry_type_name !== 'MULTIPOLYGON') {
      throw new Error(`Unexpected ${configuration.layer} geometry definition`);
    }
    const table = sqliteIdentifier(configuration.layer);
    const geometryField = sqliteIdentifier(configuration.geometryField);
    const districtField = sqliteIdentifier(configuration.districtField);
    const session = database.prepare(`
      SELECT COUNT(*) AS features, MIN(CDSESSN) AS minimum_session, MAX(CDSESSN) AS maximum_session
      FROM ${table}
    `).get();
    if (session.minimum_session !== '120' || session.maximum_session !== '120') {
      throw new Error(`Expected only 120th Congress features; received ${session.minimum_session}-${session.maximum_session}`);
    }
    const iterator = database.prepare(`
      SELECT STATEFP, ${districtField} AS district_code, GEOID, ${geometryField} AS geometry
      FROM ${table}
      ORDER BY STATEFP, ${districtField}
    `).iterate();
    return {
      async read() {
        const record = iterator.next();
        if (record.done) return { done: true };
        const decoded = decodeGeoPackageGeometry(record.value.geometry);
        if (decoded.srsId !== layer.srs_id) {
          throw new Error(`Geometry SRS ${decoded.srsId} does not match layer SRS ${layer.srs_id}`);
        }
        return {
          done: false,
          value: {
            properties: {
              STATEFP: record.value.STATEFP,
              [configuration.districtField]: record.value.district_code,
              GEOID: record.value.GEOID
            },
            geometry: { format: 'wkb', value: decoded.wkb, srid: decoded.srsId }
          }
        };
      },
      featureCount: Number(session.features),
      async close() {
        database.close();
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
    };
  } catch (error) {
    database?.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function openBoundarySource(directory, configuration) {
  if (configuration.format === 'geopackage') {
    return openGeoPackageBoundarySource(directory, configuration);
  }
  return openShapefileBoundarySource(directory, configuration);
}

async function row(client, sql, params = []) {
  const result = await client.query(sql, params);
  if (result.rows.length !== 1) throw new Error(`Expected one database row; received ${result.rows.length}`);
  return result.rows[0];
}

export async function importCongressionalDistricts({ archivePath, congress = 116 } = {}) {
  const configuration = configurations.get(Number(congress));
  if (!configuration) throw new Error(`Unsupported Congress: ${congress}`);
  const selectedArchive = archivePath || configuration.defaultArchive;
  const resolvedPath = path.resolve(selectedArchive);
  const archiveStat = await stat(resolvedPath);
  const directory = await unzipper.Open.file(resolvedPath);
  const source = await openBoundarySource(directory, configuration);
  let client;
  const runId = randomUUID();
  try {
    client = await db.connect();
    await client.query('BEGIN');
    const census = await row(client, "SELECT id FROM data_sources WHERE slug = 'census'");
    const checksum = await sha256File(resolvedPath);
    const artifact = await row(client, `
      INSERT INTO source_artifacts (
        source_id, uri, retrieved_at, sha256, byte_size, content_type,
        source_version, metadata
      ) VALUES ($1, $2, $3, $4, $5, 'application/zip', $6, $7::JSONB)
      ON CONFLICT (source_id, sha256) WHERE sha256 IS NOT NULL DO UPDATE SET
        uri = EXCLUDED.uri,
        retrieved_at = EXCLUDED.retrieved_at,
        metadata = source_artifacts.metadata || EXCLUDED.metadata
      RETURNING id
    `, [
      census.id,
      configuration.sourceUrl,
      archiveStat.mtime.toISOString(),
      checksum,
      archiveStat.size,
      configuration.sourceVersion,
      JSON.stringify({
        localArchive: pathToFileURL(resolvedPath).href,
        congress: Number(congress),
        format: configuration.format,
        ...(configuration.format === 'shapefile' ? { scale: '1:5,000,000' } : {}),
        ...configuration.metadata
      })
    ]);
    await client.query(`
      INSERT INTO ingestion_runs (
        id, source_id, source_artifact_id, started_at, status,
      parser_name, parser_version, metadata
      ) VALUES ($1, $2, $3, NOW(), 'running', $4, '1.2.0', $5::JSONB)
    `, [
      runId,
      census.id,
      artifact.id,
      `census-cd${congress}-boundaries`,
      JSON.stringify({ congress: Number(congress) })
    ]);
    const statesResult = await client.query(`
      SELECT id, name, abbreviation, state_fips
      FROM geographies
      WHERE geography_type = 'state'
    `);
    const states = new Map(statesResult.rows.map(state => [state.state_fips, state]));
    const previousVersions = await client.query(`
      DELETE FROM geography_versions
      WHERE valid_from = $1 AND valid_to = $2
        AND metadata->>'congress' = $3
      RETURNING geography_id
    `, [configuration.validFrom, configuration.validTo, String(congress)]);
    await client.query(`
      DELETE FROM geography_relationships
      WHERE valid_from = $1 AND valid_to = $2
        AND child_geography_id IN (
          SELECT id FROM geographies WHERE geography_type = 'congressional_district'
        )
    `, [configuration.validFrom, configuration.validTo]);
    await client.query(`
      DELETE FROM geography_source_ids
      WHERE source_id = $1 AND identifier_namespace = $2
    `, [census.id, `census:${congress}:cd${congress}`]);
    if (previousVersions.rows.length) {
      await client.query(`
        DELETE FROM geographies geography
        WHERE geography.id = ANY($1::UUID[])
          AND NOT EXISTS (SELECT 1 FROM geography_versions WHERE geography_id = geography.id)
          AND NOT EXISTS (SELECT 1 FROM contests WHERE district_geography_id = geography.id)
          AND NOT EXISTS (SELECT 1 FROM geography_source_ids WHERE geography_id = geography.id)
      `, [previousVersions.rows.map(version => version.geography_id)]);
    }
    let imported = 0;
    let skipped = 0;
    let skippedOutsideApplicationStates = 0;
    let skippedUndefinedDistricts = 0;
    let repaired = 0;

    while (true) {
      const record = await source.read();
      if (record.done) break;
      const properties = record.value.properties;
      const state = states.get(properties.STATEFP);
      if (!state) {
        skipped += 1;
        skippedOutsideApplicationStates += 1;
        continue;
      }
      const sourceDistrict = properties[configuration.districtField];
      if (sourceDistrict === 'ZZ') {
        skipped += 1;
        skippedUndefinedDistricts += 1;
        continue;
      }
      if (!/^(?:\d{2}|98)$/.test(sourceDistrict)) {
        throw new Error(`Unexpected congressional district code: ${sourceDistrict}`);
      }
      const atLarge = sourceDistrict === '00' || sourceDistrict === '98';
      const districtCode = atLarge ? 'AL' : sourceDistrict;
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
      const geometry = record.value.geometry;
      for (const district of districts.rows) {
        const rawGeometry = geometry.format === 'wkb'
          ? 'ST_Transform(ST_GeomFromWKB($1, $9), 4326)'
          : 'ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)';
        const geometryParameters = [
          geometry.value,
          district.id,
          configuration.validFrom,
          configuration.validTo,
          artifact.id,
          properties.GEOID,
          `U.S. Census Bureau ${configuration.sourceVersion}.`,
          Number(congress)
        ];
        if (geometry.format === 'wkb') geometryParameters.push(geometry.srid);
        const version = await row(client, `
          WITH prepared AS (
            SELECT ST_Multi(ST_Force2D(${rawGeometry})) AS raw_geom
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
            $7,
            JSONB_BUILD_OBJECT(
              'geoid', $6::TEXT,
              'congress', $8::INTEGER,
              'geometryRepaired', NOT ST_IsValid(raw_geom)
            )
          FROM prepared
          ON CONFLICT (geography_id, valid_from, valid_to) DO UPDATE SET
            source_artifact_id = EXCLUDED.source_artifact_id,
            geom = EXCLUDED.geom,
            methodology = EXCLUDED.methodology,
            metadata = EXCLUDED.metadata
          RETURNING (metadata->>'geometryRepaired')::BOOLEAN AS was_repaired
        `, geometryParameters);
        if (version.was_repaired) repaired += 1;
        await client.query(`
          INSERT INTO geography_relationships (
            parent_geography_id, child_geography_id, relationship_type, valid_from, valid_to
          ) VALUES ($1, $2, 'contains', $3, $4)
          ON CONFLICT (parent_geography_id, child_geography_id, relationship_type, valid_from)
          DO UPDATE SET valid_to = EXCLUDED.valid_to
        `, [state.id, district.id, configuration.validFrom, configuration.validTo]);
      }
      const primaryDistrictId = districts.rows[0].id;
      await client.query(`
        INSERT INTO geography_source_ids (
          geography_id, source_id, identifier_namespace, source_identifier
        ) VALUES ($1, $2, $3, $4)
        ON CONFLICT (source_id, identifier_namespace, source_identifier) DO UPDATE SET
          geography_id = EXCLUDED.geography_id
      `, [primaryDistrictId, census.id, `census:${congress}:cd${congress}`, properties.GEOID]);
      imported += 1;
    }
    if (source.featureCount != null && imported + skipped !== source.featureCount) {
      throw new Error(`Processed ${imported + skipped} of ${source.featureCount} GeoPackage features`);
    }
    if (Number(congress) === 120 && imported !== 436) {
      throw new Error(`Expected 436 in-scope 120th Congress features; received ${imported}`);
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
      `Imported ${imported} congressional district boundaries for the ${congress}th Congress.`,
      JSON.stringify({
        skippedOutsideApplicationStates,
        skippedUndefinedDistricts,
        geometryRepairs: repaired
      })
    ]);
    await client.query('COMMIT');
    return { imported, skipped, repaired, artifactId: String(artifact.id) };
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    throw error;
  } finally {
    client?.release();
    await source.close();
  }
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  let exitCode = 0;
  try {
    const archiveIndex = process.argv.indexOf('--archive');
    const congressIndex = process.argv.indexOf('--congress');
    const archivePath = archiveIndex >= 0 ? process.argv[archiveIndex + 1] : undefined;
    const congress = congressIndex >= 0 ? Number(process.argv[congressIndex + 1]) : 116;
    if (archiveIndex >= 0 && !archivePath) throw new Error('--archive requires a path');
    if (congressIndex >= 0 && !Number.isInteger(congress)) throw new Error('--congress requires an integer');
    await initializeDatabase();
    console.log(JSON.stringify(await importCongressionalDistricts({ archivePath, congress }), null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    exitCode = 1;
  } finally {
    await closeDatabase();
    process.exitCode = exitCode;
  }
}

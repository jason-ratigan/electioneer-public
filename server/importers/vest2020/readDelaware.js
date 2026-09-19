import proj4 from 'proj4';
import * as shapefile from 'shapefile';
import { delawareManifest } from './delawareManifest.js';

function transformPosition(position, transform, bounds) {
  const transformed = transform.forward(position);
  if (!transformed.every(Number.isFinite)) throw new Error(`Projection produced invalid coordinate: ${position}`);
  const [longitude, latitude] = transformed;
  bounds.minLongitude = Math.min(bounds.minLongitude, longitude);
  bounds.minLatitude = Math.min(bounds.minLatitude, latitude);
  bounds.maxLongitude = Math.max(bounds.maxLongitude, longitude);
  bounds.maxLatitude = Math.max(bounds.maxLatitude, latitude);
  return transformed;
}

function transformCoordinates(coordinates, transform, bounds) {
  if (typeof coordinates[0] === 'number') return transformPosition(coordinates, transform, bounds);
  return coordinates.map(value => transformCoordinates(value, transform, bounds));
}

function transformGeometry(geometry, transform, bounds) {
  if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) {
    throw new Error(`Expected Polygon or MultiPolygon geometry; received ${geometry?.type || 'none'}`);
  }
  return { ...geometry, coordinates: transformCoordinates(geometry.coordinates, transform, bounds) };
}

function validateBounds(actual, expected) {
  const inRange = actual.minLongitude >= expected.minLongitude
    && actual.minLatitude >= expected.minLatitude
    && actual.maxLongitude <= expected.maxLongitude
    && actual.maxLatitude <= expected.maxLatitude;
  if (!inRange) throw new Error(`Transformed bounds are outside Delaware: ${JSON.stringify(actual)}`);
}

export async function readDelaware(archive) {
  const manifest = delawareManifest;
  if (archive.encoding.toLowerCase() !== manifest.encoding) {
    throw new Error(`Expected ${manifest.encoding} DBF encoding; received ${archive.encoding}`);
  }
  if (!archive.prj.includes(manifest.sourceCrsMarker)) {
    throw new Error(`Unexpected Delaware projection: ${archive.prj}`);
  }

  const transform = proj4(archive.prj, 'EPSG:4326');
  const source = await shapefile.open(archive.shp, archive.dbf, { encoding: manifest.encoding });
  const columns = manifest.contests.flatMap(contest => contest.choices.map(choice => choice.column));
  const totals = Object.fromEntries(columns.map(column => [column, 0]));
  const bounds = {
    minLongitude: Number.POSITIVE_INFINITY,
    minLatitude: Number.POSITIVE_INFINITY,
    maxLongitude: Number.NEGATIVE_INFINITY,
    maxLatitude: Number.NEGATIVE_INFINITY
  };
  const precincts = [];
  const precinctIds = new Set();

  while (true) {
    const record = await source.read();
    if (record.done) break;
    const precinctId = String(record.value.properties[manifest.precinctField] ?? '').trim();
    if (!precinctId) throw new Error(`Record ${precincts.length + 1} has no ${manifest.precinctField}`);
    if (precinctIds.has(precinctId)) throw new Error(`Duplicate precinct identifier: ${precinctId}`);
    precinctIds.add(precinctId);

    const votes = {};
    for (const column of columns) {
      const value = record.value.properties[column];
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`Precinct ${precinctId} has invalid ${column} value: ${value}`);
      }
      votes[column] = value;
      totals[column] += value;
    }

    precincts.push({
      sourceIdentifier: precinctId,
      name: `Precinct ${precinctId}`,
      votes,
      geometry: transformGeometry(record.value.geometry, transform, bounds)
    });
  }

  if (precincts.length !== manifest.expectedPrecincts) {
    throw new Error(`Expected ${manifest.expectedPrecincts} Delaware precincts; read ${precincts.length}`);
  }
  validateBounds(bounds, manifest.expectedBounds);

  for (const contest of manifest.contests) {
    for (const choice of contest.choices) {
      if (totals[choice.column] !== choice.expectedVotes) {
        throw new Error(`${choice.column} expected ${choice.expectedVotes} votes; calculated ${totals[choice.column]}`);
      }
    }
  }

  return { precincts, totals, bounds };
}

import { createHash } from 'node:crypto';
import proj4 from 'proj4';
import * as shapefile from 'shapefile';
import { splitChoiceLabel, vestDocumentationCorrections } from './documentation.js';

const contestColumnPattern = /^G20(PRE|USS|GOV|HAL|DEL|H\d{2})([A-Z0-9]{4})$/;
const identityFields = [
  ['GEOID20'], ['GEOID'], ['PCTKEY'], ['SRPREC_KEY'], ['VTD_KEY'],
  ['COUNTYFP20', 'VTDST20'], ['COUNTYFP', 'VTDST'],
  ['COUNTYFP', 'PRECINCT'], ['COUNTY', 'PRECINCT'],
  ['CNTY', 'PREC'], ['DISTRICT', 'NAME'], ['PRECINCT'], ['NAME20'], ['NAME']
];
const nameFields = ['NAME20', 'PRECINCT', 'NAME', 'SRPREC', 'PREC', 'VTDST20', 'VTDST'];
const presidentialAliases = new Map([
  ['joseph-biden', { key: 'joseph-r-biden-jr', name: 'Joseph R. Biden Jr.' }],
  ['donald-trump', { key: 'donald-j-trump', name: 'Donald J. Trump' }],
  ['jo-jorgensen', { key: 'jo-jorgensen', name: 'Jo Jorgensen' }],
  ['howie-hawkins', { key: 'howie-hawkins', name: 'Howie Hawkins' }],
  ['don-blakenship', { key: 'don-blankenship', name: 'Don Blankenship' }],
  ['don-blankenship', { key: 'don-blankenship', name: 'Don Blankenship' }],
  ['brian-caroll', { key: 'brian-carroll', name: 'Brian Carroll' }],
  ['brian-carroll', { key: 'brian-carroll', name: 'Brian Carroll' }],
  ['rocky-de-la-fuente', { key: 'rocky-de-la-fuente', name: 'Rocky De La Fuente' }]
]);

export function slugifyCandidateName(value) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function candidateIdentity(name, state, presidential) {
  const sourceSlug = slugifyCandidateName(name);
  if (!sourceSlug) throw new Error(`Cannot derive candidate identity from ${JSON.stringify(name)}`);
  if (presidential) {
    return presidentialAliases.get(sourceSlug) || { key: sourceSlug, name };
  }
  return { key: `${sourceSlug}-${state.code}`, name };
}

function genericChoice(name) {
  return /^(?:write[- ]?in votes|other write[- ]?in|other candidates|none of these candidates)/i.test(name);
}

function partyValue(name, abbreviation) {
  if (!name || /^(?:write[- ]?in(?: candidate)?|no party listed)$/i.test(name)) return null;
  const normalized = name.toLowerCase();
  const documentedAbbreviation = normalized.includes('democrat') ? 'D'
    : normalized.includes('republican') ? 'R'
      : normalized.includes('libertarian') ? 'L'
        : normalized.includes('green') ? 'G'
          : normalized.includes('independent') || normalized === 'unaffiliated' ? 'I'
            : normalized.includes('constitution') ? 'C'
              : abbreviation;
  return { name, abbreviation: documentedAbbreviation };
}

export function parseContestColumn(column) {
  const match = column.match(contestColumnPattern);
  if (!match) return null;
  const code = match[1];
  const suffix = match[2];
  let officeSlug;
  let district;
  let districtLabel;
  let name;
  if (code === 'PRE') {
    officeSlug = 'president'; district = 'state'; districtLabel = 'Statewide'; name = 'President';
  } else if (code === 'USS') {
    officeSlug = 'us_senate'; district = 'state'; districtLabel = 'Statewide'; name = 'U.S. Senate';
  } else if (code === 'GOV') {
    officeSlug = 'governor'; district = 'state'; districtLabel = 'Statewide'; name = 'Governor';
  } else if (code === 'HAL' || code === 'DEL') {
    officeSlug = 'us_house'; district = 'AL'; districtLabel = code === 'DEL' ? 'At-Large Delegate' : 'At-Large';
    name = code === 'DEL' ? 'U.S. House Delegate — At-Large' : 'U.S. House — At-Large District';
  } else {
    const districtNumber = code.slice(1);
    officeSlug = 'us_house'; district = districtNumber; districtLabel = `District ${Number(districtNumber)}`;
    name = `U.S. House — District ${Number(districtNumber)}`;
  }
  return {
    column,
    contestCode: code,
    sourceIdentifier: `G20${code}`,
    choiceCode: suffix,
    partyAbbreviation: suffix[0],
    officeSlug,
    district,
    districtLabel,
    name
  };
}

function buildContests(columns, labels, state) {
  const contests = new Map();
  for (const column of columns) {
    const parsedColumn = parseContestColumn(column);
    if (!parsedColumn) continue;
    const label = labels.get(column);
    if (!label) throw new Error(`${state.abbreviation} documentation has no label for ${column}`);
    const parsedLabel = splitChoiceLabel(label);
    const isGeneric = genericChoice(parsedLabel.name);
    const isPresidential = parsedColumn.officeSlug === 'president';
    const identity = isGeneric ? null : candidateIdentity(parsedLabel.name, state, isPresidential);
    const choice = {
      column,
      name: parsedLabel.name,
      canonicalName: identity?.name || null,
      candidateKey: identity?.key || null,
      choiceType: isGeneric ? (parsedLabel.name.toLowerCase().includes('write') ? 'write_in' : 'other') : 'candidate',
      party: partyValue(parsedLabel.party, parsedColumn.partyAbbreviation),
      documentationCorrection: vestDocumentationCorrections.get(`${state.code}:${column}`) || null
    };
    if (!contests.has(parsedColumn.sourceIdentifier)) {
      contests.set(parsedColumn.sourceIdentifier, {
        sourceIdentifier: parsedColumn.sourceIdentifier,
        name: parsedColumn.name,
        officeSlug: parsedColumn.officeSlug,
        district: parsedColumn.district,
        districtLabel: parsedColumn.districtLabel,
        choices: []
      });
    }
    contests.get(parsedColumn.sourceIdentifier).choices.push(choice);
  }
  const order = new Map([['president', 0], ['governor', 1], ['us_senate', 2], ['us_house', 3]]);
  return [...contests.values()].sort((left, right) => {
    return order.get(left.officeSlug) - order.get(right.officeSlug)
      || left.district.localeCompare(right.district, undefined, { numeric: true });
  });
}

function transformPosition(position, transform, bounds) {
  const transformed = transform.forward(position);
  if (!transformed.every(Number.isFinite)) throw new Error(`Projection produced invalid coordinate: ${position}`);
  const [longitude, latitude] = transformed;
  if (longitude < -180.001 || longitude > 180.001 || latitude < -90.001 || latitude > 90.001) {
    throw new Error(`Projection produced out-of-range longitude/latitude: ${transformed}`);
  }
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

function value(properties, field) {
  const result = properties[field];
  return result == null ? '' : String(result).trim();
}

function preferredIdentifier(properties) {
  for (const fields of identityFields) {
    const values = fields.map(field => value(properties, field));
    if (values.every(Boolean)) return `${fields.join('+')}:${values.join(':')}`;
  }
  return null;
}

function displayName(properties, fallback) {
  for (const field of nameFields) {
    const candidate = value(properties, field);
    if (candidate) return candidate;
  }
  return fallback;
}

function countyFips(properties, stateFips) {
  for (const field of ['COUNTYFP20', 'COUNTYFP']) {
    const candidate = value(properties, field);
    if (/^\d{1,3}$/.test(candidate)) return candidate.padStart(3, '0');
  }
  for (const field of ['GEOID20', 'GEOID', 'FIPS_CODE']) {
    const candidate = value(properties, field);
    const padded = candidate.padStart(5, '0');
    if (/^\d{4,}$/.test(candidate) && padded.startsWith(stateFips)) {
      return padded.slice(2, 5);
    }
  }
  const texasKey = value(properties, 'PCTKEY');
  if (stateFips === '48' && /^\d{7,}$/.test(texasKey)) return texasKey.slice(0, 3);
  return null;
}

function countyName(properties) {
  for (const field of ['COUNTY', 'CNTY']) {
    const candidate = value(properties, field);
    if (candidate) return candidate;
  }
  return null;
}

function stableFallbackIdentifier(properties, geometry) {
  const nonVoteProperties = Object.fromEntries(
    Object.entries(properties)
      .filter(([key]) => !key.startsWith('G20'))
      .sort(([left], [right]) => left.localeCompare(right))
  );
  return `derived:${createHash('sha256')
    .update(JSON.stringify({ properties: nonVoteProperties, geometry }))
    .digest('hex')
    .slice(0, 24)}`;
}

export function normalizeDbfNumericPadding(dbf) {
  if (!Buffer.isBuffer(dbf) || dbf.length < 33) return dbf;
  const recordCount = dbf.readUInt32LE(4);
  const headerLength = dbf.readUInt16LE(8);
  const recordLength = dbf.readUInt16LE(10);
  if (headerLength < 33 || recordLength < 2 || headerLength + recordCount * recordLength > dbf.length) {
    throw new Error('Invalid DBF header or record dimensions');
  }

  const numericFields = [];
  let descriptorOffset = 32;
  let fieldOffset = 1;
  while (descriptorOffset < headerLength - 1 && dbf[descriptorOffset] !== 0x0d) {
    const type = String.fromCharCode(dbf[descriptorOffset + 11]);
    const length = dbf[descriptorOffset + 16];
    if (type === 'N' || type === 'F') numericFields.push({ offset: fieldOffset, length });
    fieldOffset += length;
    descriptorOffset += 32;
  }
  if (fieldOffset > recordLength) throw new Error('DBF field widths exceed the declared record length');

  let normalized = null;
  for (let recordIndex = 0; recordIndex < recordCount; recordIndex += 1) {
    const recordOffset = headerLength + recordIndex * recordLength;
    for (const field of numericFields) {
      const start = recordOffset + field.offset;
      const end = start + field.length;
      for (let index = start; index < end; index += 1) {
        if (dbf[index] !== 0x00) continue;
        normalized ||= Buffer.from(dbf);
        normalized[index] = 0x20;
      }
    }
  }
  return normalized || dbf;
}

export async function readVestState(archive, state, labels) {
  const transform = proj4(archive.prj, 'EPSG:4326');
  const dbf = normalizeDbfNumericPadding(archive.dbf);
  const source = await shapefile.open(archive.shp, dbf, { encoding: archive.encoding || 'utf-8' });
  const records = [];
  const bounds = {
    minLongitude: Number.POSITIVE_INFINITY,
    minLatitude: Number.POSITIVE_INFINITY,
    maxLongitude: Number.NEGATIVE_INFINITY,
    maxLatitude: Number.NEGATIVE_INFINITY
  };
  let columns = null;
  let contests = null;
  let voteColumns = null;
  let recordNumber = 0;

  while (true) {
    const record = await source.read();
    if (record.done) break;
    recordNumber += 1;
    if (!columns) {
      columns = Object.keys(record.value.properties);
      contests = buildContests(columns, labels, state);
      if (!contests.length) throw new Error(`${state.abbreviation} has no supported 2020 federal or governor contests`);
      voteColumns = contests.flatMap(contest => contest.choices.map(choice => choice.column));
    }
    const votes = {};
    for (const column of voteColumns) {
      const raw = record.value.properties[column];
      const numeric = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isSafeInteger(numeric) || numeric < 0) {
        throw new Error(`${state.abbreviation} record ${recordNumber} has invalid ${column} value: ${raw}`);
      }
      votes[column] = numeric;
    }
    const geometry = transformGeometry(record.value.geometry, transform, bounds);
    records.push({
      properties: record.value.properties,
      geometry,
      votes,
      preferredIdentifier: preferredIdentifier(record.value.properties)
    });
  }

  const identifierCounts = new Map();
  for (const record of records) {
    if (record.preferredIdentifier) {
      identifierCounts.set(record.preferredIdentifier, (identifierCounts.get(record.preferredIdentifier) || 0) + 1);
    }
  }
  const seen = new Set();
  const precincts = records.map((record, index) => {
    let sourceIdentifier = record.preferredIdentifier;
    if (!sourceIdentifier || identifierCounts.get(sourceIdentifier) > 1) {
      sourceIdentifier = stableFallbackIdentifier(record.properties, record.geometry);
    }
    if (seen.has(sourceIdentifier)) sourceIdentifier = `${sourceIdentifier}:${index + 1}`;
    seen.add(sourceIdentifier);
    return {
      sourceIdentifier,
      name: displayName(record.properties, `Precinct ${index + 1}`),
      countyFips: countyFips(record.properties, state.stateFips),
      countyName: countyName(record.properties),
      geometry: record.geometry,
      votes: record.votes
    };
  });

  const nameCounts = new Map();
  for (const precinct of precincts) {
    const key = `${precinct.countyFips || ''}:${precinct.name.toLowerCase()}`;
    nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
  }
  for (const precinct of precincts) {
    const key = `${precinct.countyFips || ''}:${precinct.name.toLowerCase()}`;
    if (nameCounts.get(key) > 1) precinct.name = `${precinct.name} · ${precinct.sourceIdentifier}`;
  }

  const totals = Object.fromEntries(voteColumns.map(column => [column, 0]));
  for (const precinct of precincts) {
    for (const column of voteColumns) totals[column] += precinct.votes[column];
  }
  return { precincts, contests, totals, bounds, columns };
}

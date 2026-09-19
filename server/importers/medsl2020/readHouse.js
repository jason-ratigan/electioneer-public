import { createInterface } from 'node:readline';
import { slugifyCandidateName } from '../vest2020/readState.js';

const expectedColumns = [
  'precinct', 'office', 'party_detailed', 'party_simplified', 'mode', 'votes',
  'county_name', 'county_fips', 'jurisdiction_name', 'jurisdiction_fips',
  'candidate', 'district', 'dataverse', 'year', 'stage', 'state', 'special',
  'writein', 'state_po', 'state_fips', 'state_cen', 'state_ic', 'date',
  'readme_check', 'magnitude'
];

export function parseCsvLine(line) {
  const fields = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      fields.push(field);
      field = '';
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error('CSV record has an unterminated quoted field');
  fields.push(field.replace(/\r$/, ''));
  return fields;
}

function titleCase(value) {
  const trimmed = value.trim();
  if (!trimmed || trimmed !== trimmed.toUpperCase()) return trimmed;
  return trimmed.toLowerCase().replace(/(^|[\s\-'])\p{L}/gu, match => match.toUpperCase());
}

function booleanValue(value) {
  return /^(?:true|1|yes)$/i.test(value.trim());
}

function normalizeDistrict(value) {
  const trimmed = value.trim().toUpperCase();
  if (trimmed === 'AL' || trimmed === 'AT LARGE' || trimmed === 'AT-LARGE' || trimmed === 'STATEWIDE') return 'AL';
  if (!/^\d+$/.test(trimmed)) return null;
  const district = Number(trimmed);
  return district === 0 ? 'AL' : String(district).padStart(2, '0');
}

function genericWriteIn(name, writeIn) {
  return writeIn && /^(?:write[- ]?in(?: votes?)?|scattered|scatter|writeins?)$/i.test(name.trim());
}

function statisticRow(name) {
  return /^(?:undervotes|overvotes|blank ballots|blanks|blank|over)$/i.test(name.trim());
}

function choiceKey(name, writeIn) {
  const slug = slugifyCandidateName(name) || 'unnamed';
  return genericWriteIn(name, writeIn) ? `generic:${slug}` : `candidate:${slug}`;
}

function partyFromVotes(partyVotes) {
  const order = ['DEMOCRAT', 'REPUBLICAN', 'LIBERTARIAN', 'NONPARTISAN'];
  const simplified = order.find(value => partyVotes.has(value))
    || [...partyVotes.entries()].sort((left, right) => right[1] - left[1])[0]?.[0]
    || null;
  if (simplified === 'DEMOCRAT') return { name: 'Democratic Party', abbreviation: 'D' };
  if (simplified === 'REPUBLICAN') return { name: 'Republican Party', abbreviation: 'R' };
  if (simplified === 'LIBERTARIAN') return { name: 'Libertarian Party', abbreviation: 'L' };
  if (simplified === 'NONPARTISAN') return { name: 'Nonpartisan', abbreviation: 'N' };
  if (!simplified) return null;
  return { name: titleCase(simplified), abbreviation: 'O' };
}

function stateRecord(row) {
  const stateFips = row.state_fips.padStart(2, '0');
  if (!/^\d{2}$/.test(stateFips)) throw new Error(`Invalid state FIPS: ${row.state_fips}`);
  if (!/^[A-Z]{2}$/.test(row.state_po)) throw new Error(`Invalid state abbreviation: ${row.state_po}`);
  return {
    abbreviation: row.state_po,
    name: titleCase(row.state),
    stateFips,
    contests: new Map(),
    rowsRead: 0,
    suppressedRows: 0
  };
}

function contestRecord(state, district, magnitude, special) {
  const atLarge = district === 'AL';
  return {
    sourceIdentifier: `${state.abbreviation}:${district}`,
    district,
    districtLabel: atLarge ? 'At-Large' : `District ${Number(district)}`,
    name: atLarge ? 'U.S. House — At-Large District' : `U.S. House — District ${Number(district)}`,
    magnitude,
    special,
    choices: new Map(),
    counties: new Map(),
    precincts: new Set(),
    rowsRead: 0
  };
}

function choiceRecord(row, key) {
  const isGeneric = genericWriteIn(row.candidate, booleanValue(row.writein));
  return {
    sourceIdentifier: key,
    ballotName: isGeneric ? 'Write-In Votes' : titleCase(row.candidate),
    canonicalName: isGeneric ? null : titleCase(row.candidate),
    candidateSlug: isGeneric ? null : slugifyCandidateName(row.candidate),
    choiceType: isGeneric ? 'write_in' : 'candidate',
    isWriteIn: booleanValue(row.writein),
    votes: 0,
    partyVotes: new Map()
  };
}

function finalizeState(state) {
  const contests = [...state.contests.values()].sort((left, right) =>
    left.district.localeCompare(right.district, undefined, { numeric: true })
  );
  for (const contest of contests) {
    contest.choices = [...contest.choices.values()].map(choice => ({
      ...choice,
      party: partyFromVotes(choice.partyVotes)
    })).sort((left, right) => right.votes - left.votes || left.ballotName.localeCompare(right.ballotName));
    contest.counties = [...contest.counties.values()].sort((left, right) => left.fips.localeCompare(right.fips));
  }
  return { ...state, contests };
}

export async function readHouseResults(archive, onProgress) {
  const reader = createInterface({ input: archive.csvStream(), crlfDelay: Infinity });
  const states = new Map();
  let header = null;
  let lineNumber = 0;
  let rowsRead = 0;
  let specialRows = 0;
  let suppressedRows = 0;
  let invalidCountyRows = 0;
  let excludedStatisticRows = 0;

  for await (const line of reader) {
    lineNumber += 1;
    if (!header) {
      header = parseCsvLine(line).map(value => value.replace(/^\uFEFF/, ''));
      if (header.length !== expectedColumns.length || header.some((value, index) => value !== expectedColumns[index])) {
        throw new Error(`Unexpected HOUSE CSV header: ${header.join(',')}`);
      }
      continue;
    }
    if (!line) continue;
    const values = parseCsvLine(line);
    if (values.length !== header.length) {
      throw new Error(`CSV line ${lineNumber} has ${values.length} fields; expected ${header.length}`);
    }
    const row = Object.fromEntries(header.map((column, index) => [column, values[index].trim()]));
    rowsRead += 1;
    const supportedOffice = row.office === 'US HOUSE'
      || row.office === 'DELEGATE TO THE U.S. HOUSE OF REPRESENTATIVES';
    if (!supportedOffice || row.dataverse !== 'HOUSE' || row.year !== '2020' || row.stage !== 'GEN') {
      throw new Error(`Unexpected election scope at CSV line ${lineNumber}`);
    }
    const special = booleanValue(row.special);
    if (special) specialRows += 1;
    if (statisticRow(row.candidate)) {
      excludedStatisticRows += 1;
      continue;
    }
    const district = normalizeDistrict(row.district);
    if (!district) throw new Error(`Invalid House district at CSV line ${lineNumber}: ${row.district}`);
    const magnitude = Number(row.magnitude);
    if (!Number.isSafeInteger(magnitude) || magnitude < 1) {
      throw new Error(`Invalid contest magnitude at CSV line ${lineNumber}: ${row.magnitude}`);
    }
    const numericVotes = Number(row.votes);
    if (!Number.isFinite(numericVotes) || !Number.isInteger(numericVotes)) {
      throw new Error(`Invalid vote count at CSV line ${lineNumber}: ${row.votes}`);
    }

    if (!states.has(row.state_po)) states.set(row.state_po, stateRecord(row));
    const state = states.get(row.state_po);
    state.rowsRead += 1;
    if (!state.contests.has(district)) {
      state.contests.set(district, contestRecord(state, district, magnitude, special));
    }
    const contest = state.contests.get(district);
    if (contest.magnitude !== magnitude) {
      throw new Error(`${state.abbreviation} ${contest.districtLabel} has inconsistent magnitude values`);
    }
    if (contest.special !== special) {
      throw new Error(`${state.abbreviation} ${contest.districtLabel} mixes special and regular rows`);
    }
    contest.rowsRead += 1;

    if (numericVotes < 0) {
      state.suppressedRows += 1;
      suppressedRows += 1;
      continue;
    }
    const key = choiceKey(row.candidate, booleanValue(row.writein));
    if (!contest.choices.has(key)) contest.choices.set(key, choiceRecord(row, key));
    const choice = contest.choices.get(key);
    choice.votes += numericVotes;
    const partyKey = row.party_simplified || row.party_detailed || '';
    choice.partyVotes.set(partyKey, (choice.partyVotes.get(partyKey) || 0) + numericVotes);

    const precinctKey = `${row.county_fips}:${row.precinct}`;
    contest.precincts.add(precinctKey);
    if (row.county_fips) {
      const fullFips = row.county_fips.padStart(5, '0');
      if (!/^\d{5}$/.test(fullFips) || !fullFips.startsWith(state.stateFips)) {
        invalidCountyRows += 1;
      } else if (!contest.counties.has(fullFips)) {
        contest.counties.set(fullFips, {
          fips: fullFips,
          countyFips: fullFips.slice(2),
          name: titleCase(row.county_name),
          precincts: new Set(),
          votes: new Map()
        });
      }
      const county = contest.counties.get(fullFips);
      if (county) {
        county.precincts.add(row.precinct);
        county.votes.set(key, (county.votes.get(key) || 0) + numericVotes);
      }
    }
    if (rowsRead % 250000 === 0) onProgress?.(`${rowsRead.toLocaleString()} CSV rows parsed`);
  }

  return {
    rowsRead,
    specialRows,
    suppressedRows,
    invalidCountyRows,
    excludedStatisticRows,
    states: [...states.values()].map(finalizeState).sort((left, right) => left.name.localeCompare(right.name))
  };
}

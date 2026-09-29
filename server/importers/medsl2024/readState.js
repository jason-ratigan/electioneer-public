import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { parseCsvLine } from '../medsl2020/readHouse.js';
import { resolvePresidentialCandidateName } from '../vest2020/presidentialCandidates.js';
import { slugifyCandidateName } from '../vest2020/readState.js';

const requiredColumns = [
  'precinct', 'office', 'party_detailed', 'party_simplified', 'mode', 'votes',
  'county_name', 'county_fips', 'jurisdiction_name', 'jurisdiction_fips',
  'candidate', 'district', 'dataverse', 'year', 'stage', 'state', 'special',
  'writein', 'state_po', 'state_fips', 'date', 'magnitude'
];

const officeDefinitions = new Map([
  ['US PRESIDENT', { slug: 'president', name: 'President' }],
  ['US SENATE', { slug: 'us_senate', name: 'U.S. Senate' }],
  ['US HOUSE', { slug: 'us_house', name: 'U.S. House' }],
  ['DELEGATE TO THE U.S. HOUSE OF REPRESENTATIVES', { slug: 'us_house', name: 'U.S. House' }],
  ['GOVERNOR', { slug: 'governor', name: 'Governor' }]
]);

const atLargeHouseJurisdictions = new Set(['AK', 'DC', 'DE', 'ND', 'SD', 'VT', 'WY']);

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
  if (['AL', 'AT LARGE', 'AT-LARGE', 'STATEWIDE', '00', '0'].includes(trimmed)) return 'AL';
  if (!/^\d+$/.test(trimmed)) return null;
  return String(Number(trimmed)).padStart(2, '0');
}

function genericWriteIn(name, writeIn) {
  return writeIn && /^(?:write[- ]?in(?: votes?)?|scattered|scatter|writeins?)$/i.test(name.trim());
}

function unassignedHouseRow(row) {
  const house = row.office.toUpperCase() === 'US HOUSE'
    || row.office.toUpperCase() === 'DELEGATE TO THE U.S. HOUSE OF REPRESENTATIVES';
  return house && !row.district.trim()
    && (statisticRow(row.candidate) || genericWriteIn(row.candidate, booleanValue(row.writein)));
}

function invalidAtLargeHouseRow(row) {
  const house = row.office.toUpperCase() === 'US HOUSE'
    || row.office.toUpperCase() === 'DELEGATE TO THE U.S. HOUSE OF REPRESENTATIVES';
  return house && normalizeDistrict(row.district) === 'AL'
    && !atLargeHouseJurisdictions.has(row.state_po);
}

function statisticRow(name) {
  return !name.trim() || /^(?:(?:contest |grand )?total(?: votes? cast| votes?)?|total ballots?|ballots? cast|registered voters?|voter turnout|under[\s-]?votes?(?:[\s-].*)?|over[\s-]?votes?(?:[\s-].*)?|blank ballots?|blanks?|over|under)$/i.test(name.trim());
}

function aggregateReportingUnit(name) {
  return /^(?:(?:county|contest|grand)\s+total|total(?:s| votes?)?)$/i.test(name.trim());
}

function contestIdentity(row) {
  const office = officeDefinitions.get(row.office.toUpperCase());
  if (!office) return null;
  const special = booleanValue(row.special);
  let district = null;
  if (office.slug === 'us_house') {
    district = normalizeDistrict(row.district);
    if (!district) throw new Error(`Invalid House district: ${row.district}`);
  }
  return {
    ...office,
    special,
    district,
    key: `${office.slug}\u001f${district || 'statewide'}\u001f${special ? 'special' : 'regular'}`
  };
}

function geographyScope(row, contest) {
  const county = row.county_fips.trim().padStart(5, '0');
  const locality = /^\d{5}$/.test(county)
    ? county
    : `${row.jurisdiction_fips.trim()}\u001f${row.jurisdiction_name.trim()}\u001f${row.county_name.trim()}`;
  return `${contest.key}\u001f${locality}\u001f${row.jurisdiction_fips.trim()}\u001f${row.jurisdiction_name.trim()}`;
}

function normalizedPrecinct(value) {
  return value.trim().toUpperCase().replace(/\s+/g, ' ');
}

function modeCellKey(row, contest) {
  return [
    geographyScope(row, contest),
    normalizedPrecinct(row.precinct),
    row.candidate.trim().toUpperCase(),
    row.party_detailed.trim().toUpperCase(),
    row.writein.trim().toUpperCase()
  ].join('\u001f');
}

function addToSetMap(map, key, value) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(value);
}

function possibleParentPrecincts(detailedPrecinct) {
  const parents = [];
  for (let index = 1; index < detailedPrecinct.length; index += 1) {
    if (/^[\s\-/#:]$/.test(detailedPrecinct[index])) {
      const parent = detailedPrecinct.slice(0, index).trim();
      if (parent) parents.push(parent);
    }
  }
  return parents;
}

async function forEachCsvRow(stream, callback, onDuplicate) {
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  let header;
  let lineNumber = 0;
  const seen = new Set();
  for await (const line of reader) {
    lineNumber += 1;
    if (!header) {
      header = parseCsvLine(line).map(value => value.replace(/^\uFEFF/, '').trim());
      const missing = requiredColumns.filter(column => !header.includes(column));
      if (missing.length) throw new Error(`CSV is missing required columns: ${missing.join(', ')}`);
      continue;
    }
    if (!line) continue;
    const values = parseCsvLine(line);
    if (values.length !== header.length) {
      throw new Error(`CSV line ${lineNumber} has ${values.length} fields; expected ${header.length}`);
    }
    const row = Object.fromEntries(header.map((column, index) => [column, values[index].trim()]));
    const fingerprint = createHash('sha256').update(JSON.stringify(row)).digest('hex');
    if (seen.has(fingerprint)) { onDuplicate?.(); continue; }
    seen.add(fingerprint);
    await callback(row, lineNumber);
  }
  if (!header) throw new Error('CSV is empty');
}

function partyFromVotes(partyVotes) {
  const simplified = [...partyVotes.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] || null;
  if (simplified === 'DEMOCRAT' || simplified === 'DEMOCRATIC') {
    return { name: 'Democratic Party', abbreviation: 'D' };
  }
  if (simplified === 'REPUBLICAN') return { name: 'Republican Party', abbreviation: 'R' };
  if (simplified === 'LIBERTARIAN') return { name: 'Libertarian Party', abbreviation: 'L' };
  if (simplified === 'GREEN') return { name: 'Green Party', abbreviation: 'G' };
  if (simplified === 'NONPARTISAN') return { name: 'Nonpartisan', abbreviation: 'N' };
  if (!simplified) return null;
  return { name: titleCase(simplified), abbreviation: 'O' };
}

function contestRecord(state, identity, row) {
  const atLarge = identity.district === 'AL';
  const districtLabel = identity.slug === 'us_house'
    ? (atLarge ? 'At-Large' : `District ${Number(identity.district)}`)
    : null;
  const specialLabel = identity.special ? ' - Special Election' : '';
  const name = identity.slug === 'us_house'
    ? `U.S. House - ${districtLabel}${specialLabel}`
    : `${identity.name}${specialLabel}`;
  const magnitude = Number(row.magnitude || 1);
  if (!Number.isSafeInteger(magnitude) || magnitude < 1) {
    throw new Error(`Invalid contest magnitude: ${row.magnitude}`);
  }
  return {
    key: identity.key,
    sourceIdentifier: `${state.abbreviation}:${identity.slug}:${identity.district || 'statewide'}:${identity.special ? 'special' : 'regular'}`,
    officeSlug: identity.slug,
    officeName: identity.name,
    district: identity.district,
    districtLabel,
    name,
    special: identity.special,
    magnitude,
    choices: new Map(),
    counties: new Map(),
    precincts: new Set(),
    rowsRead: 0,
    includedRows: 0
  };
}

function choiceIdentity(row, contest) {
  const isGeneric = genericWriteIn(row.candidate, booleanValue(row.writein));
  if (isGeneric) {
    return { key: 'generic:write-in', candidateSlug: null, canonicalName: null, ballotName: 'Write-In Votes' };
  }
  if (contest.officeSlug === 'president') {
    const reviewed = resolvePresidentialCandidateName(row.candidate);
    const candidateSlug = reviewed?.canonicalKey || slugifyCandidateName(row.candidate);
    return {
      key: `candidate:${candidateSlug}`,
      candidateSlug,
      canonicalName: reviewed?.canonicalName || titleCase(row.candidate),
      ballotName: reviewed?.canonicalName || titleCase(row.candidate)
    };
  }
  const candidateSlug = slugifyCandidateName(row.candidate);
  return {
    key: `candidate:${candidateSlug}`,
    candidateSlug,
    canonicalName: titleCase(row.candidate),
    ballotName: titleCase(row.candidate)
  };
}

function choiceRecord(identity, row) {
  return {
    sourceIdentifier: identity.key,
    ballotName: identity.ballotName,
    canonicalName: identity.canonicalName,
    candidateSlug: identity.candidateSlug,
    choiceType: identity.candidateSlug ? 'candidate' : 'write_in',
    isWriteIn: booleanValue(row.writein),
    votes: 0,
    reportedRows: 0,
    suppressedRows: 0,
    partyVotes: new Map()
  };
}

function countyRecord(row, fullFips) {
  return {
    fips: fullFips,
    countyFips: fullFips.slice(2),
    name: titleCase(row.county_name),
    precincts: new Set(),
    votes: new Map()
  };
}

function finalizeState(state) {
  const contests = [...state.contests.values()].sort((left, right) =>
    left.officeSlug.localeCompare(right.officeSlug)
      || (left.district || '').localeCompare(right.district || '', undefined, { numeric: true })
      || Number(left.special) - Number(right.special)
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

export async function readStateResults(archive) {
  let duplicateRows = 0;
  const totalCells = new Set();
  const totalPrecincts = new Map();
  const componentPrecincts = new Map();
  let rowsRead = 0;
  let supportedRows = 0;
  let unassignedDistrictRows = 0;
  await forEachCsvRow(archive.csvStream(), row => {
    rowsRead += 1;
    if (row.year !== '2024' || row.stage !== 'GEN') return;
    if (unassignedHouseRow(row) || invalidAtLargeHouseRow(row)) {
      unassignedDistrictRows += 1;
      return;
    }
    const contest = contestIdentity(row);
    if (!contest) return;
    supportedRows += 1;
    const scope = geographyScope(row, contest);
    const precinct = normalizedPrecinct(row.precinct);
    if (row.mode.toUpperCase() === 'TOTAL') {
      totalCells.add(modeCellKey(row, contest));
      addToSetMap(totalPrecincts, scope, precinct);
    } else {
      addToSetMap(componentPrecincts, scope, precinct);
    }
  }, () => { duplicateRows += 1; rowsRead += 1; });

  const aggregateTotalPrecincts = new Set();
  for (const [scope, totals] of totalPrecincts) {
    const details = componentPrecincts.get(scope);
    if (!details) continue;
    for (const detail of details) {
      for (const parent of possibleParentPrecincts(detail)) {
        if (totals.has(parent)) aggregateTotalPrecincts.add(`${scope}\u001f${parent}`);
      }
    }
  }

  let state;
  let excludedModeRows = 0;
  let excludedStatisticRows = 0;
  let suppressedRows = 0;
  let adjustmentRows = 0;
  let invalidCountyRows = 0;
  await forEachCsvRow(archive.csvStream(), (row, lineNumber) => {
    if (row.year !== '2024' || row.stage !== 'GEN') return;
    if (unassignedHouseRow(row) || invalidAtLargeHouseRow(row)) return;
    const identity = contestIdentity(row);
    if (!identity) return;
    const stateFips = row.state_fips.padStart(2, '0');
    if (!/^\d{2}$/.test(stateFips) || !/^[A-Z]{2}$/.test(row.state_po)) {
      throw new Error(`Invalid state identity at CSV line ${lineNumber}`);
    }
    if (!state) {
      state = {
        abbreviation: row.state_po,
        name: titleCase(row.state),
        stateFips,
        date: row.date,
        contests: new Map()
      };
    } else if (state.abbreviation !== row.state_po || state.stateFips !== stateFips || state.date !== row.date) {
      throw new Error(`Archive mixes states or election dates at CSV line ${lineNumber}`);
    }

    const scope = geographyScope(row, identity);
    const mode = row.mode.toUpperCase();
    const precinct = normalizedPrecinct(row.precinct);
    const aggregateTotal = aggregateTotalPrecincts.has(`${scope}\u001f${precinct}`);
    if ((mode === 'TOTAL' && aggregateTotal)
      || (mode !== 'TOTAL' && totalCells.has(modeCellKey(row, identity)))) {
      excludedModeRows += 1;
      return;
    }
    if (aggregateReportingUnit(row.precinct)) {
      excludedModeRows += 1;
      return;
    }
    if (statisticRow(row.candidate)) {
      excludedStatisticRows += 1;
      return;
    }
    if (!state.contests.has(identity.key)) {
      state.contests.set(identity.key, contestRecord(state, identity, row));
    }
    const contest = state.contests.get(identity.key);
    const magnitude = Number(row.magnitude || 1);
    if (contest.magnitude !== magnitude) {
      throw new Error(`${state.abbreviation} ${contest.name} has inconsistent magnitude values`);
    }
    contest.rowsRead += 1;

    const choiceIdentityValue = choiceIdentity(row, contest);
    if (!choiceIdentityValue.candidateSlug && choiceIdentityValue.key !== 'generic:write-in') {
      excludedStatisticRows += 1;
      return;
    }
    if (!contest.choices.has(choiceIdentityValue.key)) {
      contest.choices.set(choiceIdentityValue.key, choiceRecord(choiceIdentityValue, row));
    }
    const choice = contest.choices.get(choiceIdentityValue.key);
    choice.isWriteIn ||= booleanValue(row.writein);

    const fullFips = row.county_fips.padStart(5, '0');
    const validCounty = /^\d{5}$/.test(fullFips) && fullFips.startsWith(state.stateFips);
    if (!validCounty) invalidCountyRows += 1;
    else if (!contest.counties.has(fullFips)) contest.counties.set(fullFips, countyRecord(row, fullFips));
    const county = validCounty ? contest.counties.get(fullFips) : null;
    const precinctKey = `${validCounty ? fullFips : row.jurisdiction_fips}:${row.precinct}`;
    contest.precincts.add(precinctKey);
    county?.precincts.add(row.precinct);
    if (county && !county.votes.has(choiceIdentityValue.key)) {
      county.votes.set(choiceIdentityValue.key, { votes: 0, reportedRows: 0, suppressedRows: 0 });
    }
    const countyChoice = county?.votes.get(choiceIdentityValue.key);

    if (row.votes === '*') {
      suppressedRows += 1;
      choice.suppressedRows += 1;
      if (countyChoice) countyChoice.suppressedRows += 1;
      return;
    }
    const votes = Number(row.votes);
    if (!row.votes || !Number.isSafeInteger(votes)) {
      throw new Error(`Invalid vote count at CSV line ${lineNumber}: ${row.votes}`);
    }
    if (votes < 0) adjustmentRows += 1;
    choice.votes += votes;
    choice.reportedRows += 1;
    const partyKey = row.party_simplified || row.party_detailed || '';
    choice.partyVotes.set(partyKey, (choice.partyVotes.get(partyKey) || 0) + Math.max(0, votes));
    if (countyChoice) {
      countyChoice.votes += votes;
      countyChoice.reportedRows += 1;
    }
    contest.includedRows += 1;
  });
  if (!state) throw new Error(`No supported 2024 general-election rows in ${archive.csvPath}`);
  return finalizeState({
    ...state,
    rowsRead,
    duplicateRows,
    supportedRows,
    excludedModeRows,
    excludedStatisticRows,
    suppressedRows,
    adjustmentRows,
    invalidCountyRows,
    unassignedDistrictRows,
    totalModeScopes: totalPrecincts.size,
    aggregateTotalPrecincts: aggregateTotalPrecincts.size
  });
}

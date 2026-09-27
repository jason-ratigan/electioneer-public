import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseCsvLine } from '../medsl2020/readHouse.js';

const expectedHeader = [
  'state', 'chamber', 'district', 'candidate_name', 'candidate_party',
  'candidate_party_raw', 'candidate_ballotpedia_url', 'race_ballotpedia_url', 'scraped_at'
];

function normalizeDistrict(chamber, value) {
  if (chamber === 'Senate') {
    if (value !== 'Statewide') throw new Error(`Senate district must be Statewide; received ${value}`);
    return 'Statewide';
  }
  if (/^at-large$/i.test(value)) return 'At-large';
  if (!/^\d{1,2}$/.test(value) || Number(value) < 1 || Number(value) > 99) {
    throw new Error(`Invalid House district: ${value}`);
  }
  return String(Number(value));
}

function assertBallotpediaUrl(value, field, lineNumber) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} is not a URL at line ${lineNumber}: ${value}`);
  }
  if (url.protocol !== 'https:' || url.hostname !== 'ballotpedia.org' || url.search || url.hash) {
    throw new Error(`${field} must be a canonical Ballotpedia HTTPS URL at line ${lineNumber}`);
  }
  return url.href;
}

export function identityName(value) {
  return value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export async function readNomineeRoster(filePath) {
  const reader = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  let header;
  let pending = '';
  let physicalLineNumber = 0;
  const rows = [];
  const uniqueProfilesByRace = new Set();

  for await (const physicalLine of reader) {
    physicalLineNumber += 1;
    const line = pending ? `${pending}\n${physicalLine}` : physicalLine;
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      if (line[index] !== '"') continue;
      if (quoted && line[index + 1] === '"') index += 1;
      else quoted = !quoted;
    }
    if (quoted) {
      pending = line;
      continue;
    }
    pending = '';
    if (!header) {
      header = parseCsvLine(line).map(value => value.replace(/^\uFEFF/, '').trim());
      if (header.length !== expectedHeader.length
        || header.some((column, index) => column !== expectedHeader[index])) {
        throw new Error(`Unexpected nominee CSV header: ${header.join(',')}`);
      }
      continue;
    }
    if (!line.trim()) continue;
    const values = parseCsvLine(line);
    if (values.length !== header.length) {
      throw new Error(`Nominee CSV row ending at line ${physicalLineNumber} has ${values.length} fields`);
    }
    const source = Object.fromEntries(header.map((column, index) => [column, values[index].trim()]));
    if (!['House', 'Senate'].includes(source.chamber)) {
      throw new Error(`Unsupported chamber at line ${physicalLineNumber}: ${source.chamber}`);
    }
    if (!source.state || !source.candidate_name || !source.candidate_party || !source.candidate_party_raw) {
      throw new Error(`Nominee CSV row ending at line ${physicalLineNumber} has a blank required field`);
    }
    const scrapedAt = new Date(source.scraped_at);
    if (Number.isNaN(scrapedAt.valueOf())) {
      throw new Error(`Invalid scraped_at timestamp at line ${physicalLineNumber}`);
    }
    const row = {
      state: source.state,
      chamber: source.chamber,
      district: normalizeDistrict(source.chamber, source.district),
      candidateName: source.candidate_name.replace(/\s+/g, ' ').trim(),
      candidateParty: source.candidate_party.replace(/\s+/g, ' ').trim(),
      candidatePartyRaw: source.candidate_party_raw.replace(/\s+/g, ' ').trim(),
      candidateUrl: assertBallotpediaUrl(
        source.candidate_ballotpedia_url, 'candidate_ballotpedia_url', physicalLineNumber
      ),
      raceUrl: assertBallotpediaUrl(
        source.race_ballotpedia_url, 'race_ballotpedia_url', physicalLineNumber
      ),
      scrapedAt: scrapedAt.toISOString(),
      sourceLine: physicalLineNumber
    };
    const uniqueKey = `${row.raceUrl}\u001f${row.candidateUrl}`;
    if (uniqueProfilesByRace.has(uniqueKey)) {
      throw new Error(`Duplicate candidate profile within a race at line ${physicalLineNumber}`);
    }
    uniqueProfilesByRace.add(uniqueKey);
    rows.push(row);
  }
  if (pending) throw new Error('Nominee CSV ends inside a quoted field');
  if (!header) throw new Error('Nominee CSV is empty');
  return {
    rows,
    rowCount: rows.length,
    raceCount: new Set(rows.map(row => row.raceUrl)).size,
    houseRaceCount: new Set(rows.filter(row => row.chamber === 'House').map(row => row.raceUrl)).size,
    senateRaceCount: new Set(rows.filter(row => row.chamber === 'Senate').map(row => row.raceUrl)).size
  };
}

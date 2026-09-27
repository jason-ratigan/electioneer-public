import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseCsvLine } from '../medsl2020/readHouse.js';

const expectedHeader = [
  'state', 'chamber', 'district', 'candidate_name', 'candidate_party',
  'candidate_party_raw', 'candidate_source_url', 'race_source_url',
  'source_page_title', 'source_page_id', 'source_revision_id', 'official_source_url',
  'extraction_method', 'source_status', 'fec_candidate_id', 'fec_match_method', 'scraped_at'
];

function normalizeDistrict(chamber, value) {
  if (chamber === 'Senate') {
    if (value !== 'Statewide') throw new Error(`Senate district must be Statewide; received ${value}`);
    return value;
  }
  if (/^at-large$/i.test(value)) return 'At-large';
  if (!/^\d{1,2}$/.test(value) || Number(value) < 1 || Number(value) > 99) {
    throw new Error(`Invalid House district: ${value}`);
  }
  return String(Number(value));
}

function checkedUrl(value, field, lineNumber, { optional = false, wikipedia = false } = {}) {
  if (!value && optional) return '';
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} is not a URL at line ${lineNumber}: ${value}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${field} must use HTTP or HTTPS at line ${lineNumber}`);
  }
  if (wikipedia && (url.protocol !== 'https:' || url.hostname !== 'en.wikipedia.org')) {
    throw new Error(`${field} must be an English Wikipedia HTTPS URL at line ${lineNumber}`);
  }
  return url.href;
}

export function identityName(value) {
  return value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export async function readWikimediaNominees(filePath) {
  const reader = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  let header;
  let pending = '';
  let physicalLineNumber = 0;
  const rows = [];
  const uniqueCandidates = new Set();

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
        throw new Error(`Unexpected Wikimedia nominee CSV header: ${header.join(',')}`);
      }
      continue;
    }
    if (!line.trim()) continue;
    const values = parseCsvLine(line);
    if (values.length !== header.length) {
      throw new Error(`Wikimedia nominee row ending at line ${physicalLineNumber} has ${values.length} fields`);
    }
    const source = Object.fromEntries(header.map((column, index) => [column, values[index].trim()]));
    if (!['House', 'Senate'].includes(source.chamber)) {
      throw new Error(`Unsupported chamber at line ${physicalLineNumber}: ${source.chamber}`);
    }
    for (const field of [
      'state', 'candidate_name', 'candidate_party', 'candidate_party_raw', 'source_page_title',
      'source_page_id', 'source_revision_id', 'extraction_method', 'source_status', 'fec_match_method',
      'scraped_at'
    ]) {
      if (!source[field]) throw new Error(`Blank ${field} at line ${physicalLineNumber}`);
    }
    if (!/^\d+$/.test(source.source_page_id) || !/^\d+$/.test(source.source_revision_id)) {
      throw new Error(`Invalid Wikimedia page identity at line ${physicalLineNumber}`);
    }
    if (source.fec_candidate_id && !/^[HS]\d[A-Z]{2}\d{5}$/.test(source.fec_candidate_id)) {
      throw new Error(`Invalid FEC candidate ID at line ${physicalLineNumber}: ${source.fec_candidate_id}`);
    }
    if (!['exact_name', 'first_last', 'unmatched', 'ambiguous'].includes(source.fec_match_method)) {
      throw new Error(`Invalid FEC match method at line ${physicalLineNumber}: ${source.fec_match_method}`);
    }
    const scrapedAt = new Date(source.scraped_at);
    if (Number.isNaN(scrapedAt.valueOf())) throw new Error(`Invalid scraped_at at line ${physicalLineNumber}`);
    const row = {
      state: source.state,
      chamber: source.chamber,
      district: normalizeDistrict(source.chamber, source.district),
      candidateName: source.candidate_name.replace(/\s+/g, ' ').trim(),
      candidateParty: source.candidate_party.replace(/\s+/g, ' ').trim(),
      candidatePartyRaw: source.candidate_party_raw.replace(/\s+/g, ' ').trim(),
      candidateUrl: checkedUrl(source.candidate_source_url, 'candidate_source_url', physicalLineNumber, {
        optional: true, wikipedia: true
      }),
      raceUrl: checkedUrl(source.race_source_url, 'race_source_url', physicalLineNumber, { wikipedia: true }),
      sourcePageTitle: source.source_page_title,
      sourcePageId: source.source_page_id,
      sourceRevisionId: source.source_revision_id,
      officialSourceUrl: checkedUrl(source.official_source_url, 'official_source_url', physicalLineNumber, {
        optional: true
      }),
      extractionMethod: source.extraction_method,
      sourceStatus: source.source_status,
      fecCandidateId: source.fec_candidate_id,
      fecMatchMethod: source.fec_match_method,
      scrapedAt: scrapedAt.toISOString(),
      sourceLine: physicalLineNumber
    };
    const uniqueKey = [row.state, row.chamber, row.district, identityName(row.candidateName)].join('\u001f');
    if (uniqueCandidates.has(uniqueKey)) {
      throw new Error(`Duplicate candidate within a race at line ${physicalLineNumber}`);
    }
    uniqueCandidates.add(uniqueKey);
    rows.push(row);
  }
  if (pending) throw new Error('Wikimedia nominee CSV ends inside a quoted field');
  if (!header) throw new Error('Wikimedia nominee CSV is empty');

  const raceKeys = rows.map(row => [row.state, row.chamber, row.district].join('\u001f'));
  return {
    rows,
    rowCount: rows.length,
    raceCount: new Set(raceKeys).size,
    houseRaceCount: new Set(rows.filter(row => row.chamber === 'House')
      .map(row => `${row.state}\u001f${row.district}`)).size,
    senateRaceCount: new Set(rows.filter(row => row.chamber === 'Senate').map(row => row.state)).size
  };
}

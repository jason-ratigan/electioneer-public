import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseCsvLine } from '../medsl2020/readHouse.js';

const expectedHeader = ['state', 'chamber', 'district', 'candidate_name', 'candidate_party'];

function normalizedDistrict(chamber, value) {
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

export async function readCandidateRoster(filePath) {
  const reader = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  let header;
  let pending = '';
  let physicalLineNumber = 0;
  const rows = [];
  const uniqueRows = new Set();

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
        throw new Error(`Unexpected candidate CSV header: ${header.join(',')}`);
      }
      continue;
    }
    if (!line.trim()) continue;
    const values = parseCsvLine(line);
    if (values.length !== header.length) {
      throw new Error(`Candidate CSV row ending at line ${physicalLineNumber} has ${values.length} fields`);
    }
    const source = Object.fromEntries(header.map((column, index) => [column, values[index].trim()]));
    if (!source.state || !source.candidate_name || !source.candidate_party) {
      throw new Error(`Candidate CSV row ending at line ${physicalLineNumber} has a blank required field`);
    }
    if (!['House', 'Senate'].includes(source.chamber)) {
      throw new Error(`Unsupported chamber at line ${physicalLineNumber}: ${source.chamber}`);
    }
    const row = {
      state: source.state,
      chamber: source.chamber,
      district: normalizedDistrict(source.chamber, source.district),
      candidateName: source.candidate_name.replace(/\s+/g, ' ').trim(),
      candidateParty: source.candidate_party.replace(/\s+/g, ' ').trim(),
      sourceLine: physicalLineNumber
    };
    const uniqueKey = [row.state, row.chamber, row.district, row.candidateName, row.candidateParty].join('\u001f');
    if (uniqueRows.has(uniqueKey)) throw new Error(`Duplicate candidate row ending at line ${physicalLineNumber}`);
    uniqueRows.add(uniqueKey);
    rows.push(row);
  }
  if (pending) throw new Error('Candidate CSV ends inside a quoted field');
  if (!header) throw new Error('Candidate CSV is empty');
  return {
    rows,
    rowCount: rows.length,
    raceCount: new Set(rows.map(row => [row.state, row.chamber, row.district].join('\u001f'))).size,
    stateCount: new Set(rows.map(row => row.state).values()).size,
    partyLabelCount: new Set(rows.map(row => row.candidateParty).values()).size
  };
}

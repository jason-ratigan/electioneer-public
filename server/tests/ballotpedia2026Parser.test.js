import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseArguments } from '../importers/ballotpedia2026/cli.js';
import { parseNomineeArguments } from '../importers/ballotpedia2026/nomineesCli.js';
import { readCandidateRoster } from '../importers/ballotpedia2026/readCandidates.js';
import { identityName, readNomineeRoster } from '../importers/ballotpedia2026/readNominees.js';

const header = 'state,chamber,district,candidate_name,candidate_party';

async function withCsv(lines, callback) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ballotpedia-roster-'));
  const filePath = path.join(directory, 'candidates.csv');
  try {
    await writeFile(filePath, `${header}\n${lines.join('\n')}\n`);
    return await callback(filePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('Ballotpedia roster parser validates and normalizes congressional races', async () => {
  const parsed = await withCsv([
    'Delaware,House,At-large,Jane Candidate,Democratic',
    'Alabama,House,01,John Candidate,Republican',
    'Alabama,Senate,Statewide,"Smith, Alex",Independent'
  ], filePath => readCandidateRoster(filePath));
  assert.equal(parsed.rowCount, 3);
  assert.equal(parsed.raceCount, 3);
  assert.equal(parsed.stateCount, 2);
  assert.equal(parsed.rows[1].district, '1');
  assert.equal(parsed.rows[2].candidateName, 'Smith, Alex');
});

test('Ballotpedia roster parser rejects a district-specific Senate row', async () => {
  await assert.rejects(
    withCsv(['Delaware,Senate,1,Jane Candidate,Democratic'], filePath => readCandidateRoster(filePath)),
    /Senate district must be Statewide/
  );
});

test('Ballotpedia roster CLI is a dry run by default', () => {
  const options = parseArguments([]);
  assert.equal(options.commit, false);
  assert.match(options.filePath, /ballotpedia_2026_congressional_candidates\.csv$/);
});

test('Ballotpedia nominee parser preserves raw party labels and canonical URLs', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ballotpedia-nominees-'));
  const filePath = path.join(directory, 'nominees.csv');
  try {
    await writeFile(filePath, [
      'state,chamber,district,candidate_name,candidate_party,candidate_party_raw,candidate_ballotpedia_url,race_ballotpedia_url,scraped_at',
      "Delaware,House,At-large,Jane Candidate,Democratic,D,https://ballotpedia.org/Jane_Candidate,https://ballotpedia.org/Delaware%27s_At-large_District_election%2C_2026,2026-09-19T12:00:00Z"
    ].join('\n'));
    const parsed = await readNomineeRoster(filePath);
    assert.equal(parsed.rowCount, 1);
    assert.equal(parsed.houseRaceCount, 1);
    assert.equal(parsed.rows[0].candidatePartyRaw, 'D');
    assert.equal(parsed.rows[0].district, 'At-large');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Ballotpedia nominee identity matching ignores punctuation and accents', () => {
  assert.equal(identityName('José A. Smith-Jones'), identityName('Jose A Smith Jones'));
});

test('Ballotpedia nominee CLI prevents committing a partial scrape', () => {
  assert.throws(() => parseNomineeArguments(['--commit', '--limit', '2']), /cannot be combined/);
  assert.equal(parseNomineeArguments([]).commit, false);
});

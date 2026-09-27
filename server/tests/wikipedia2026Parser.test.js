import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseWikimediaArguments } from '../importers/wikipedia2026/cli.js';
import { readWikimediaNominees } from '../importers/wikipedia2026/readNominees.js';

const header = [
  'state', 'chamber', 'district', 'candidate_name', 'candidate_party',
  'candidate_party_raw', 'candidate_source_url', 'race_source_url',
  'source_page_title', 'source_page_id', 'source_revision_id', 'official_source_url',
  'extraction_method', 'source_status', 'fec_candidate_id', 'fec_match_method', 'scraped_at'
].join(',');

async function withNomineeCsv(lines, callback) {
  const directory = await mkdtemp(path.join(tmpdir(), 'wikimedia-nominees-'));
  const filePath = path.join(directory, 'nominees.csv');
  try {
    await writeFile(filePath, `${header}\n${lines.join('\n')}\n`);
    return await callback(filePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('Wikimedia nominee parser validates provenance and race identity', async () => {
  const parsed = await withNomineeCsv([
    'Delaware,House,At-large,Jane Candidate,Democratic,Democratic,https://en.wikipedia.org/wiki/Jane_Candidate,https://en.wikipedia.org/wiki/2026_United_States_House_of_Representatives_elections%23Delaware,2026 United States House of Representatives elections,78311563,1375770092,https://elections.delaware.gov/,national_house_candidate_table,general_candidate,H6DE00123,exact_name,2026-09-20T00:00:00Z',
    'Delaware,Senate,Statewide,John Candidate,Independent,Independent,,https://en.wikipedia.org/wiki/2026_United_States_Senate_election_in_Delaware,2026 United States Senate election in Delaware,123,456,,state_senate_candidate_status_sections,candidates,,unmatched,2026-09-20T00:00:00Z'
  ], filePath => readWikimediaNominees(filePath));
  assert.equal(parsed.rowCount, 2);
  assert.equal(parsed.houseRaceCount, 1);
  assert.equal(parsed.senateRaceCount, 1);
  assert.equal(parsed.rows[0].fecCandidateId, 'H6DE00123');
  assert.equal(parsed.rows[1].candidateUrl, '');
});

test('Wikimedia nominee parser rejects malformed FEC identities', async () => {
  await assert.rejects(withNomineeCsv([
    'Delaware,Senate,Statewide,Jane Candidate,Democratic,Democratic,,https://en.wikipedia.org/wiki/2026_United_States_Senate_election_in_Delaware,Senate page,123,456,,state_senate_candidate_status_sections,nominee,not-an-id,exact_name,2026-09-20T00:00:00Z'
  ], filePath => readWikimediaNominees(filePath)), /Invalid FEC candidate ID/);
});

test('Wikimedia sync CLI is a database dry run by default', () => {
  const options = parseWikimediaArguments([]);
  assert.equal(options.commit, false);
  assert.equal(options.refresh, false);
  assert.throws(() => parseWikimediaArguments(['--delay', '0.01']), /at least 0.1/);
  assert.throws(() => parseWikimediaArguments(['--commit', '--scrape-only']), /cannot be combined/);
});

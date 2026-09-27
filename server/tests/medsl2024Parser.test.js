import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Readable } from 'node:stream';
import { parseArguments } from '../importers/medsl2024/cli.js';
import { readStateResults } from '../importers/medsl2024/readState.js';
import { applyResultSummaries, readResultSummaries } from '../importers/medsl2024/summaries.js';
import { resolvePresidentialCandidateName } from '../importers/vest2020/presidentialCandidates.js';

const header = 'precinct,office,party_detailed,party_simplified,mode,votes,county_name,county_fips,jurisdiction_name,jurisdiction_fips,candidate,district,dataverse,year,stage,state,special,writein,state_po,state_fips,state_cen,state_ic,date,magnitude';

function line({
  precinct = 'One', office = 'US PRESIDENT', party = 'DEMOCRATIC', simplified = 'DEMOCRAT',
  mode = 'TOTAL', votes = '1', candidate = 'KAMALA D HARRIS', district = 'STATEWIDE',
  dataverse = 'PRESIDENT', special = 'FALSE', writein = 'FALSE'
} = {}) {
  return [
    precinct, office, party, simplified, mode, votes, 'TEST COUNTY', '10001',
    'TEST COUNTY', '10001', candidate, district, dataverse, '2024', 'GEN',
    'DELAWARE', special, writein, 'DE', '10', '51', '11', '2024-11-05', '1'
  ].join(',');
}

function archive(lines) {
  const csv = `${header}\n${lines.join('\n')}\n`;
  return { csvPath: 'de24.csv', csvStream: () => Readable.from([csv]) };
}

test('2024 parser prefers exact precinct totals and removes parent rollups/statistics', async () => {
  const parsed = await readStateResults(archive([
    line({ precinct: 'Town 1', mode: 'ELECTION DAY', votes: '6' }),
    line({ precinct: 'Town 1', mode: 'MAIL-IN', votes: '4' }),
    line({ precinct: 'Town 1', mode: 'TOTAL', votes: '10' }),
    line({ precinct: 'Town 2', mode: 'ELECTION DAY', votes: '7' }),
    line({ precinct: 'Town', mode: 'TOTAL', votes: '17' }),
    line({ precinct: 'COUNTY TOTAL', mode: 'TOTAL', votes: '17' }),
    line({ precinct: 'Town 1', mode: 'TOTAL', votes: '100', candidate: 'TOTAL VOTES CAST', party: '', simplified: '' }),
    line({ precinct: 'Town 1', mode: 'TOTAL', votes: '4', candidate: 'UNDER VOTES', party: '', simplified: '' }),
    line({ precinct: 'Town 1', mode: 'TOTAL', votes: '2', candidate: 'UNDERVOTES-VOIDS', party: '', simplified: '' })
  ]));
  const contest = parsed.contests[0];
  assert.equal(contest.choices.length, 1);
  assert.equal(contest.choices[0].ballotName, 'Kamala D. Harris');
  assert.equal(contest.choices[0].votes, 17);
  assert.equal(parsed.aggregateTotalPrecincts, 1);
  assert.equal(parsed.excludedStatisticRows, 3);
});

test('2024 parser groups the four supported offices and retains suppressed warnings', async () => {
  const parsed = await readStateResults(archive([
    line(),
    line({ office: 'US SENATE', candidate: 'JANE SENATOR', dataverse: 'SENATE' }),
    line({ office: 'US HOUSE', candidate: 'JOHN HOUSE', district: '1', dataverse: 'HOUSE' }),
    line({ office: 'GOVERNOR', candidate: 'JANE GOVERNOR', dataverse: 'STATE' }),
    line({ office: 'STATE HOUSE', candidate: 'LOCAL CANDIDATE', dataverse: 'STATE' }),
    line({ votes: '*', candidate: 'JILL STEIN', party: 'GREEN', simplified: 'OTHER' })
  ]));
  assert.deepEqual(
    parsed.contests.map(contest => contest.officeSlug).sort(),
    ['governor', 'president', 'us_house', 'us_senate']
  );
  assert.equal(parsed.suppressedRows, 1);
  assert.equal(parsed.supportedRows, 5);
});

test('reviewed presidential aliases resolve to one national identity', () => {
  assert.equal(resolvePresidentialCandidateName('DONALD J TRUMP').canonicalKey, 'donald-j-trump');
  assert.equal(resolvePresidentialCandidateName('TRUMP, DONALD J.').canonicalKey, 'donald-j-trump');
  assert.equal(resolvePresidentialCandidateName('HARRIS, KAMALA D.').canonicalKey, 'kamala-d-harris');
});

test('certified summary values replace derived statewide totals', async () => {
  const state = await readStateResults(archive([
    line({ votes: '8' }),
    line({ candidate: 'TICKET NAME VARIANT', party: '', simplified: '', votes: '3' })
  ]));
  const report = applyResultSummaries([{ state }], {
    rejected: [],
    summaries: [{
      filename: 'president.csv',
      classification: 'president_state',
      rowsRead: 1,
      entries: [{
        state: 'DE', officeSlug: 'president', special: false, countyFips: null,
        sourceIdentifier: 'candidate:kamala-d-harris', candidateSlug: 'kamala-d-harris',
        canonicalName: 'Kamala D. Harris', ballotName: 'Kamala D. Harris',
        isWriteIn: false, party: { name: 'Democratic Party', abbreviation: 'D' }, votes: 10
      }]
    }]
  });
  assert.equal(state.contests[0].choices[0].votes, 10);
  assert.equal(state.contests[0].choices.length, 1);
  assert.equal(report.stateTotalsReconciled, 1);
  assert.equal(report.presidentialChoicesPruned, 1);
});

test('statewide summaries accept NA as an aggregate mode', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'medsl-summary-'));
  try {
    await writeFile(path.join(directory, 'president.csv'), [
      'year,state,state_po,office,candidate,party_detailed,party_simplified,writein,mode,votes,stage,special',
      '2024,ARIZONA,AZ,US PRESIDENT,"TRUMP, DONALD J.",REPUBLICAN,REPUBLICAN,FALSE,NA,1770242,GEN,FALSE'
    ].join('\n'));
    const discovery = await readResultSummaries(directory);
    assert.equal(discovery.summaries[0].classification, 'president_state');
    assert.equal(discovery.summaries[0].entries[0].candidateSlug, 'donald-j-trump');
    assert.equal(discovery.summaries[0].entries[0].votes, 1770242);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('2024 CLI is dry-run and complete by default', () => {
  const options = parseArguments([]);
  assert.equal(options.commit, false);
  assert.equal(options.allowIncomplete, false);
  assert.match(options.sourceDirectory, /2024_results$/);
});

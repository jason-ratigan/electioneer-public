import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { closeDatabase } from '../db.js';
import { electoralCollegeRepository } from '../repositories/electoralCollegeRepository.js';
import { validateElectoralUpdate } from '../electoral/validateUpdate.js';

after(() => closeDatabase());

test('National Archives seeds preserve allocations, split votes, and uncast votes', async () => {
  for (const cycle of [2000, 2004, 2008, 2012, 2016, 2020, 2024]) {
    const result = await electoralCollegeRepository.byCycle(cycle);
    assert.equal(result.states.length, 51, `${cycle} jurisdictions`);
    assert.equal(result.allocatedVotes, 538);
    assert.equal(result.majority, 270);
    assert.equal(result.status, 'certified');
    assert.equal(result.reportedVotes, cycle === 2000 ? 537 : 538);
  }
  const year2000 = await electoralCollegeRepository.byCycle(2000);
  assert.equal(year2000.states.find(state => state.stateFips === '11').votes[0].votes, 2);
  const year2016 = await electoralCollegeRepository.byCycle(2016);
  assert.deepEqual(year2016.totals.slice(0, 2).map(item => item.votes), [304, 227]);
  assert.equal(year2016.states.find(state => state.stateFips === '53').votes.length, 3);
  const year2024 = await electoralCollegeRepository.byCycle(2024);
  assert.deepEqual(year2024.states.find(state => state.stateFips === '23').votes.map(item => item.votes), [3, 1]);
  assert.deepEqual(year2024.states.find(state => state.stateFips === '31').votes.map(item => item.votes), [4, 1]);
});

test('2028 begins with allocations and no result', async () => {
  const result = await electoralCollegeRepository.byCycle(2028);
  assert.equal(result.status, 'pending');
  assert.equal(result.allocatedVotes, 538);
  assert.equal(result.reportedVotes, 0);
  assert.equal(result.states.length, 51);
  assert.deepEqual(result.totals, []);
});

test('future updates reject duplicates and votes exceeding the allocation', () => {
  const allocations = new Map([['23', 4], ['31', 5]]);
  const update = {
    cycle: 2028,
    status: 'projected',
    sourceUrl: 'https://example.org/results',
    reportedAt: '2028-11-08T02:00:00Z',
    states: [{ fips: '23', votes: [
      { recipientName: 'Candidate A', partyAbbreviation: 'DEM', votes: 3 },
      { recipientName: 'Candidate B', partyAbbreviation: 'REP', votes: 1 }
    ] }]
  };
  assert.equal(validateElectoralUpdate(update, allocations).totalVotes, 4);
  assert.throws(() => validateElectoralUpdate({ ...update, states: [...update.states, update.states[0]] }, allocations), /Duplicate state/);
  assert.throws(() => validateElectoralUpdate({ ...update, states: [{ ...update.states[0], votes: [{ recipientName: 'A', votes: 5 }] }] }, allocations), /allocated/);
  assert.throws(() => validateElectoralUpdate({ ...update, sourceUrl: 'http://example.org' }, allocations), /HTTPS/);
});

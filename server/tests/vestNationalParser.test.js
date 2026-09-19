import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNationalArguments } from '../importers/vest2020/nationalCli.js';
import { parseVestDocumentation, splitChoiceLabel } from '../importers/vest2020/documentation.js';
import {
  candidateIdentity,
  normalizeDbfNumericPadding,
  parseContestColumn,
  slugifyCandidateName
} from '../importers/vest2020/readState.js';
import { resolveVestState } from '../importers/vest2020/states.js';

test('national CLI requires an explicit state scope', () => {
  assert.throws(() => parseNationalArguments([]), /Choose --all or provide --states/);
  assert.throws(() => parseNationalArguments(['--all', '--states', 'DE']), /either --all or --states/);
  assert.deepEqual(
    parseNationalArguments(['--states', 'de,PA,de']).states.map(state => state.abbreviation),
    ['DE', 'PA']
  );
});

test('documentation parser keeps labels scoped to a state', () => {
  const parsed = parseVestDocumentation(`Alabama\n-------\nG20PREDBID - Joseph Biden (Democratic Party)\n\nAlaska\n------\nG20PREDBID - Joseph Biden (Alaska Democratic Party)\n`);
  assert.equal(parsed.labels.get('al').get('G20PREDBID'), 'Joseph Biden (Democratic Party)');
  assert.equal(parsed.labels.get('ak').get('G20PREDBID'), 'Joseph Biden (Alaska Democratic Party)');
});

test('choice labels and supported contest columns are normalized', () => {
  assert.deepEqual(splitChoiceLabel('Joseph Biden (Democratic Party)'), {
    name: 'Joseph Biden',
    party: 'Democratic Party'
  });
  assert.equal(parseContestColumn('G20PREDBID').officeSlug, 'president');
  assert.equal(parseContestColumn('G20H03RDOE').districtLabel, 'District 3');
  assert.equal(parseContestColumn('G20HALDROC').district, 'AL');
  assert.equal(parseContestColumn('G20ATGRDOE'), null);
  assert.equal(slugifyCandidateName('José A. Smith, Jr.'), 'jose-a-smith-jr');
});

test('presidential identity is national while other candidates are state-scoped', () => {
  const delaware = resolveVestState('DE');
  const california = resolveVestState('CA');
  assert.equal(
    candidateIdentity('Joseph Biden', delaware, true).key,
    candidateIdentity('Joseph Biden', california, true).key
  );
  assert.notEqual(
    candidateIdentity('Alex Smith', delaware, false).key,
    candidateIdentity('Alex Smith', california, false).key
  );
});

test('null-padded numeric DBF fields are normalized before parsing', () => {
  const dbf = Buffer.alloc(71);
  dbf.writeUInt32LE(1, 4);
  dbf.writeUInt16LE(65, 8);
  dbf.writeUInt16LE(6, 10);
  dbf.write('VOTES', 32, 'ascii');
  dbf[43] = 'N'.charCodeAt(0);
  dbf[48] = 5;
  dbf[64] = 0x0d;
  dbf[65] = 0x20;
  dbf.write('42', 66, 'ascii');

  const normalized = normalizeDbfNumericPadding(dbf);

  assert.equal(normalized.subarray(66, 71).toString('ascii'), '42   ');
  assert.equal(dbf.subarray(66, 71).toString('hex'), '3432000000');
});

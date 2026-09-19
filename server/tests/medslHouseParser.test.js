import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHouseArguments } from '../importers/medsl2020/houseCli.js';
import { parseCsvLine } from '../importers/medsl2020/readHouse.js';

test('MEDSL CSV parser preserves quoted commas and escaped quotes', () => {
  assert.deepEqual(
    parseCsvLine('001,US HOUSE,"DOE, JANE","JOHN ""ACE"" SMITH"'),
    ['001', 'US HOUSE', 'DOE, JANE', 'JOHN "ACE" SMITH']
  );
});

test('MEDSL House CLI defaults to a dry run and accepts an archive override', () => {
  const defaults = parseHouseArguments([]);
  assert.equal(defaults.commit, false);
  assert.match(defaults.archivePath, /us_house_2020\.zip$/);

  const committed = parseHouseArguments(['--archive', 'house.zip', '--commit']);
  assert.equal(committed.commit, true);
  assert.match(committed.archivePath, /house\.zip$/);
  assert.throws(() => parseHouseArguments(['--unknown']), /Unknown argument/);
});

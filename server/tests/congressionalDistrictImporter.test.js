import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeGeoPackageGeometry } from '../geography/importCongressionalDistricts.js';

function header({ flags, srsId, envelopeBytes = 0 }) {
  const value = Buffer.alloc(8 + envelopeBytes);
  value.write('GP', 0, 'ascii');
  value[2] = 0;
  value[3] = flags;
  if ((flags & 1) === 1) value.writeInt32LE(srsId, 4);
  else value.writeInt32BE(srsId, 4);
  return value;
}

test('GeoPackage geometry decoder strips an XY envelope and preserves WKB', () => {
  const wkb = Buffer.from([1, 6, 0, 0, 0, 0]);
  const geometry = Buffer.concat([header({ flags: 3, srsId: 4269, envelopeBytes: 32 }), wkb]);
  const decoded = decodeGeoPackageGeometry(geometry);
  assert.equal(decoded.srsId, 4269);
  assert.deepEqual(decoded.wkb, wkb);
});

test('GeoPackage geometry decoder supports big-endian headers without envelopes', () => {
  const wkb = Buffer.from([0, 0, 0, 0, 6]);
  const decoded = decodeGeoPackageGeometry(Buffer.concat([
    header({ flags: 0, srsId: 4326 }),
    wkb
  ]));
  assert.equal(decoded.srsId, 4326);
  assert.deepEqual(decoded.wkb, wkb);
});

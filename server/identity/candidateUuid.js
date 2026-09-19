import { createHash } from 'node:crypto';

// Stable application namespace for candidate identity. Do not change after data is imported.
export const candidateUuidNamespace = '1f858046-945b-4fd7-af29-4128260c8075';

function uuidBytes(uuid) {
  const hex = uuid.replaceAll('-', '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error(`Invalid UUID namespace: ${uuid}`);
  return Buffer.from(hex, 'hex');
}

function formatUuid(bytes) {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function candidateUuid(canonicalKey) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(canonicalKey)) {
    throw new Error(`Invalid candidate canonical key: ${canonicalKey}`);
  }
  const digest = createHash('sha1')
    .update(uuidBytes(candidateUuidNamespace))
    .update(`candidate:${canonicalKey}`, 'utf8')
    .digest()
    .subarray(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  return formatUuid(digest);
}

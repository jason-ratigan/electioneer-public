import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import unzipper from 'unzipper';

async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function exactlyOne(directory, expectedPath) {
  const matches = directory.files.filter(entry => entry.path === expectedPath);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${expectedPath} entry; found ${matches.length}`);
  }
  return matches[0];
}

export async function openHouseArchive(archivePath) {
  const resolvedPath = path.resolve(archivePath);
  const archiveStat = await stat(resolvedPath);
  if (!archiveStat.isFile()) throw new Error(`Archive is not a file: ${resolvedPath}`);
  const directory = await unzipper.Open.file(resolvedPath);
  const csv = exactlyOne(directory, 'HOUSE_precinct_general.csv');
  const readme = exactlyOne(directory, 'README.md');
  const codebook = exactlyOne(directory, '2020-precincts-codebook.md');
  return {
    resolvedPath,
    retrievedAt: archiveStat.mtime.toISOString(),
    byteSize: archiveStat.size,
    sha256: await sha256File(resolvedPath),
    csvByteSize: csv.uncompressedSize,
    csvStream: () => csv.stream(),
    readme: (await readme.buffer()).toString('utf8'),
    codebook: (await codebook.buffer()).toString('utf8')
  };
}

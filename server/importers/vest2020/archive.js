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

function requiredEntry(directory, expectedPath) {
  const normalizedExpected = expectedPath.replaceAll('\\', '/').toLowerCase();
  const matches = directory.files.filter(entry => entry.path.replaceAll('\\', '/').toLowerCase() === normalizedExpected);
  if (matches.length !== 1) throw new Error(`Expected exactly one ${expectedPath} entry; found ${matches.length}`);
  return matches[0];
}

export async function openStateArchive(outerArchivePath, manifest) {
  const resolvedPath = path.resolve(outerArchivePath);
  const outerStat = await stat(resolvedPath);
  if (!outerStat.isFile()) throw new Error(`Archive is not a file: ${resolvedPath}`);

  const outerDirectory = await unzipper.Open.file(resolvedPath);
  const stateEntry = requiredEntry(outerDirectory, manifest.stateArchive);
  const stateBuffer = await stateEntry.buffer();
  const stateDirectory = await unzipper.Open.buffer(stateBuffer);
  const base = manifest.shapeBasename;

  const [shp, dbf, prj, cpg] = await Promise.all([
    requiredEntry(stateDirectory, `${base}.shp`).buffer(),
    requiredEntry(stateDirectory, `${base}.dbf`).buffer(),
    requiredEntry(stateDirectory, `${base}.prj`).buffer(),
    requiredEntry(stateDirectory, `${base}.cpg`).buffer()
  ]);

  return {
    resolvedPath,
    retrievedAt: outerStat.mtime.toISOString(),
    outerByteSize: outerStat.size,
    outerSha256: await sha256File(resolvedPath),
    stateByteSize: stateBuffer.length,
    stateSha256: createHash('sha256').update(stateBuffer).digest('hex'),
    shp,
    dbf,
    prj: prj.toString('utf8').trim(),
    encoding: cpg.toString('utf8').trim()
  };
}

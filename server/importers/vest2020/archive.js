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

function extensionEntry(directory, basename, extension, required = true) {
  const expected = `${basename}.${extension}`.toLowerCase();
  const matches = directory.files.filter(entry => {
    const normalized = entry.path.replaceAll('\\', '/').toLowerCase();
    return normalized === expected || normalized.endsWith(`/${expected}`);
  });
  if (matches.length === 1) return matches[0];
  if (!required && matches.length === 0) return null;
  throw new Error(`Expected exactly one ${expected} entry; found ${matches.length}`);
}

export async function openVestArchive(outerArchivePath) {
  const resolvedPath = path.resolve(outerArchivePath);
  const outerStat = await stat(resolvedPath);
  if (!outerStat.isFile()) throw new Error(`Archive is not a file: ${resolvedPath}`);
  const directory = await unzipper.Open.file(resolvedPath);
  const documentation = requiredEntry(directory, 'documentation.txt');
  return {
    resolvedPath,
    retrievedAt: outerStat.mtime.toISOString(),
    outerByteSize: outerStat.size,
    outerSha256: await sha256File(resolvedPath),
    directory,
    documentation: (await documentation.buffer()).toString('utf8')
  };
}

export async function openStateFromVestArchive(outer, state) {
  const stateEntry = requiredEntry(outer.directory, state.archiveName);
  const stateBuffer = await stateEntry.buffer();
  const stateDirectory = await unzipper.Open.buffer(stateBuffer);
  const shpEntry = extensionEntry(stateDirectory, state.shapeBasename, 'shp');
  const dbfEntry = extensionEntry(stateDirectory, state.shapeBasename, 'dbf');
  const prjEntry = extensionEntry(stateDirectory, state.shapeBasename, 'prj');
  const cpgEntry = extensionEntry(stateDirectory, state.shapeBasename, 'cpg', false);
  const [shp, dbf, prj, cpg] = await Promise.all([
    shpEntry.buffer(),
    dbfEntry.buffer(),
    prjEntry.buffer(),
    cpgEntry ? cpgEntry.buffer() : null
  ]);
  return {
    resolvedPath: outer.resolvedPath,
    retrievedAt: outer.retrievedAt,
    outerByteSize: outer.outerByteSize,
    outerSha256: outer.outerSha256,
    stateArchive: state.archiveName,
    stateByteSize: stateBuffer.length,
    stateSha256: createHash('sha256').update(stateBuffer).digest('hex'),
    shp,
    dbf,
    prj: prj.toString('utf8').trim(),
    encoding: cpg ? cpg.toString('utf8').trim() : 'utf-8'
  };
}

export async function openStateArchive(outerArchivePath, manifest) {
  const outer = await openVestArchive(outerArchivePath);
  return openStateFromVestArchive(outer, {
    archiveName: manifest.stateArchive,
    shapeBasename: manifest.shapeBasename
  });
}

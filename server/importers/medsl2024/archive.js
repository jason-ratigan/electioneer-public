import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import unzipper from 'unzipper';

async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function csvEntry(directory) {
  const entries = directory.files.filter(entry =>
    entry.type !== 'Directory'
      && !entry.path.startsWith('__MACOSX/')
      && entry.path.toLowerCase().endsWith('.csv')
  );
  if (entries.length !== 1) {
    throw new Error(`expected exactly one CSV entry; found ${entries.length}`);
  }
  return entries[0];
}

export async function openStateArchive(filePath) {
  const resolvedPath = path.resolve(filePath);
  const archiveStat = await stat(resolvedPath);
  if (!archiveStat.isFile()) throw new Error(`Archive is not a file: ${resolvedPath}`);
  const directory = await unzipper.Open.file(resolvedPath);
  const csv = csvEntry(directory);
  return {
    resolvedPath,
    filename: path.basename(resolvedPath),
    retrievedAt: archiveStat.mtime.toISOString(),
    byteSize: archiveStat.size,
    sha256: await sha256File(resolvedPath),
    csvPath: csv.path,
    csvByteSize: csv.uncompressedSize,
    csvStream: () => csv.stream()
  };
}

export async function openStateArchiveDirectory(directoryPath) {
  const resolvedDirectory = path.resolve(directoryPath);
  const entries = await readdir(resolvedDirectory, { withFileTypes: true });
  const archives = [];
  const rejected = [];
  for (const entry of entries
    .filter(item => item.isFile() && item.name.toLowerCase().endsWith('.zip'))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const filePath = path.join(resolvedDirectory, entry.name);
    try {
      archives.push(await openStateArchive(filePath));
    } catch (error) {
      rejected.push({ filename: entry.name, reason: error.message });
    }
  }
  if (!archives.length) throw new Error(`No readable state ZIP archives found in ${resolvedDirectory}`);
  return { resolvedDirectory, archives, rejected };
}

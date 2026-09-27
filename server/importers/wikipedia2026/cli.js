import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, initializeDatabase } from '../../db.js';
import { importWikimediaNominees } from './importNominees.js';
import { readWikimediaNominees } from './readNominees.js';

const importerDirectory = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  return `Usage: npm run sync:wikimedia:nominees:2026 -- [options]

Options:
  --commit              Persist the complete, validated nationwide roster.
  --refresh             Refresh Wikimedia and FEC cache entries.
  --delay SECONDS       Minimum request interval (default: 0.25; minimum: 0.1).
  --cache-dir PATH      Source cache (default: data/wikipedia2026/cache).
  --output-dir PATH     CSV/audit output (default: data/wikipedia2026/output).
  --skip-fetch          Validate/import the existing output directory.
  --scrape-only         Write source and audit files without PostgreSQL.
  --help, -h            Show this help.

Without --commit, database reconciliation runs inside a rolled-back transaction.`;
}

function takeValue(argv, index, argument) {
  if (!argv[index + 1]) throw new Error(`${argument} requires a value`);
  return argv[index + 1];
}

export function parseWikimediaArguments(argv) {
  const options = {
    commit: false,
    refresh: false,
    delay: 0.25,
    cacheDir: path.resolve('data/wikipedia2026/cache'),
    outputDir: path.resolve('data/wikipedia2026/output'),
    skipFetch: false,
    scrapeOnly: false,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--commit') options.commit = true;
    else if (argument === '--refresh') options.refresh = true;
    else if (argument === '--skip-fetch') options.skipFetch = true;
    else if (argument === '--scrape-only') options.scrapeOnly = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--delay') {
      options.delay = Number(takeValue(argv, index, argument));
      index += 1;
    } else if (argument === '--cache-dir') {
      options.cacheDir = path.resolve(takeValue(argv, index, argument));
      index += 1;
    } else if (argument === '--output-dir') {
      options.outputDir = path.resolve(takeValue(argv, index, argument));
      index += 1;
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!Number.isFinite(options.delay) || options.delay < 0.1) {
    throw new Error('--delay must be at least 0.1 seconds');
  }
  if (options.skipFetch && options.refresh) throw new Error('--skip-fetch cannot be combined with --refresh');
  if (options.commit && options.scrapeOnly) throw new Error('--commit cannot be combined with --scrape-only');
  return options;
}

async function runPython(args) {
  const executable = process.env.PYTHON || 'python';
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: 'inherit', windowsHide: true });
    child.on('error', error => reject(new Error(`Unable to start ${executable}: ${error.message}`)));
    child.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(
        signal ? `Wikimedia collector stopped by ${signal}` : `Wikimedia collector exited with code ${code}`
      ));
    });
  });
}

async function fetchSources(options) {
  const args = [
    path.join(importerDirectory, 'fetch_nominees.py'),
    '--cache-dir', options.cacheDir,
    '--output-dir', options.outputDir,
    '--delay', String(options.delay)
  ];
  if (options.refresh) args.push('--refresh');
  await runPython(args);
}

export async function runWikimediaSync(options) {
  if (!options.skipFetch) await fetchSources(options);
  const manifestPath = path.join(options.outputDir, 'manifest.json');
  const nomineePath = path.join(options.outputDir, 'nominees.csv');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const parsed = await readWikimediaNominees(nomineePath);
  if (options.scrapeOnly) return {
    mode: 'scrape-only',
    manifestPath,
    nomineePath,
    complete: manifest.complete,
    candidates: parsed.rowCount,
    houseRaces: parsed.houseRaceCount,
    senateRaces: parsed.senateRaceCount
  };
  await initializeDatabase();
  const result = await importWikimediaNominees({
    filePath: nomineePath,
    parsed,
    manifest,
    commit: options.commit
  });
  return { ...result, manifestPath, nomineePath };
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  let exitCode = 0;
  try {
    const options = parseWikimediaArguments(process.argv.slice(2));
    if (options.help) console.log(usage());
    else console.log(JSON.stringify(await runWikimediaSync(options), null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    exitCode = 1;
  } finally {
    await closeDatabase();
    process.exitCode = exitCode;
  }
}

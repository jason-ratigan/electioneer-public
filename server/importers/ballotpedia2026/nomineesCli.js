import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, initializeDatabase } from '../../db.js';
import { importNomineeRoster } from './importNominees.js';
import { readNomineeRoster } from './readNominees.js';

const importerDirectory = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  return `Usage: npm run sync:ballotpedia:nominees:2026 -- [options]

Options:
  --commit              Persist a complete, error-free nationwide scrape.
  --refresh             Ignore cached successful Ballotpedia responses.
  --limit N             Scrape the first N races for parser testing; never imports.
  --delay SECONDS       Minimum request interval (default: 1.25; minimum: 0.5).
  --cache-dir PATH      HTML cache (default: data/ballotpedia2026/cache).
  --output-dir PATH     CSV/audit output (default: data/ballotpedia2026/output).
  --skip-scrape         Validate/import an existing output directory.
  --scrape-only         Write CSV/audit files without connecting to PostgreSQL.
  --help, -h            Show this help.

Without --commit, a complete scrape is reconciled in a rolled-back database transaction.`;
}

function takeValue(argv, index, argument) {
  if (!argv[index + 1]) throw new Error(`${argument} requires a value`);
  return argv[index + 1];
}

export function parseNomineeArguments(argv) {
  const options = {
    commit: false,
    refresh: false,
    limit: null,
    delay: 1.25,
    cacheDir: path.resolve('data/ballotpedia2026/cache'),
    outputDir: path.resolve('data/ballotpedia2026/output'),
    skipScrape: false,
    scrapeOnly: false,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--commit') options.commit = true;
    else if (argument === '--refresh') options.refresh = true;
    else if (argument === '--skip-scrape') options.skipScrape = true;
    else if (argument === '--scrape-only') options.scrapeOnly = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--limit') {
      options.limit = Number(takeValue(argv, index, argument));
      index += 1;
    } else if (argument === '--delay') {
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
  if (options.limit !== null && (!Number.isInteger(options.limit) || options.limit < 1)) {
    throw new Error('--limit must be a positive integer');
  }
  if (!Number.isFinite(options.delay) || options.delay < 0.5) {
    throw new Error('--delay must be at least 0.5 seconds');
  }
  if (options.commit && options.limit !== null) throw new Error('--commit cannot be combined with --limit');
  if (options.skipScrape && options.refresh) throw new Error('--skip-scrape cannot be combined with --refresh');
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
        signal
          ? `Ballotpedia scraper stopped by ${signal}`
          : `Ballotpedia scraper exited with code ${code}`
      ));
    });
  });
}

async function scrape(options) {
  const args = [
    path.join(importerDirectory, 'scrape_nominees.py'),
    '--cache-dir', options.cacheDir,
    '--output-dir', options.outputDir,
    '--delay', String(options.delay)
  ];
  if (options.refresh) args.push('--refresh');
  if (options.limit !== null) args.push('--limit', String(options.limit));
  await runPython(args);
}

export async function runNomineeSync(options) {
  if (!options.skipScrape) await scrape(options);
  const manifestPath = path.join(options.outputDir, 'manifest.json');
  const nomineePath = path.join(options.outputDir, 'nominees.csv');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (options.scrapeOnly || options.limit !== null) {
    return { mode: 'scrape-only', manifestPath, nomineePath, manifest };
  }
  const parsed = await readNomineeRoster(nomineePath);
  await initializeDatabase();
  const result = await importNomineeRoster({
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
    const options = parseNomineeArguments(process.argv.slice(2));
    if (options.help) console.log(usage());
    else console.log(JSON.stringify(await runNomineeSync(options), null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    exitCode = 1;
  } finally {
    await closeDatabase();
    process.exitCode = exitCode;
  }
}

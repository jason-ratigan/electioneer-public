import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, initializeDatabase } from '../../db.js';
import { importCandidateRoster } from './importCandidates.js';
import { readCandidateRoster } from './readCandidates.js';

function usage() {
  return `Usage: npm run import:ballotpedia:candidates:2026 -- [options]

Options:
  --commit          Persist the validated candidate roster.
  --file PATH       Candidate CSV (default: ballotpedia_2026_congressional_candidates.csv).
  --help, -h        Show this help.

Without --commit, the complete import is validated and rolled back.`;
}

export function parseArguments(argv) {
  let commit = false;
  let filePath = path.resolve('ballotpedia_2026_congressional_candidates.csv');
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--commit') commit = true;
    else if (argument === '--file') {
      if (!argv[index + 1]) throw new Error('--file requires a path');
      filePath = path.resolve(argv[index + 1]);
      index += 1;
    } else if (argument === '--help' || argument === '-h') return { help: true };
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return { help: false, commit, filePath };
}

export async function runImport(options) {
  const parsed = await readCandidateRoster(options.filePath);
  return importCandidateRoster({ filePath: options.filePath, parsed, commit: options.commit });
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  let exitCode = 0;
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) console.log(usage());
    else {
      await initializeDatabase();
      console.log(JSON.stringify(await runImport(options), null, 2));
    }
  } catch (error) {
    console.error(error.stack || error.message);
    exitCode = 1;
  } finally {
    await closeDatabase();
    process.exitCode = exitCode;
  }
}

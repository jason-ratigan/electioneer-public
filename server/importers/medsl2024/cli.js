import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, initializeDatabase } from '../../db.js';
import { openStateArchiveDirectory } from './archive.js';
import { importResults } from './importResults.js';
import { readStateResults } from './readState.js';
import { applyResultSummaries, readResultSummaries } from './summaries.js';

const expectedJurisdictions = [
  'AK', 'AL', 'AR', 'AZ', 'CA', 'CO', 'CT', 'DC', 'DE', 'FL', 'GA', 'HI', 'IA',
  'ID', 'IL', 'IN', 'KS', 'KY', 'LA', 'MA', 'MD', 'ME', 'MI', 'MN', 'MO', 'MS',
  'MT', 'NC', 'ND', 'NE', 'NH', 'NJ', 'NM', 'NV', 'NY', 'OH', 'OK', 'OR', 'PA',
  'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VA', 'VT', 'WA', 'WI', 'WV', 'WY'
];

function usage() {
  return `Usage: npm run import:medsl:2024 -- [options]

Options:
  --commit              Persist the validated import.
  --replace             Replace prior MEDSL 2024 batches/contests in the same transaction.
  --source-dir PATH     Directory containing MEDSL state ZIPs (default: 2024_results).
  --allow-incomplete    Import the available jurisdictions instead of requiring all 51.
  --help, -h            Show this help.

Without --commit, the complete import is validated and rolled back.`;
}

export function parseArguments(argv) {
  let commit = false;
  let allowIncomplete = false;
  let replace = false;
  let sourceDirectory = path.resolve('2024_results');
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--commit') commit = true;
    else if (argument === '--replace') replace = true;
    else if (argument === '--allow-incomplete') allowIncomplete = true;
    else if (argument === '--source-dir') {
      if (!argv[index + 1]) throw new Error('--source-dir requires a path');
      sourceDirectory = path.resolve(argv[index + 1]);
      index += 1;
    } else if (argument === '--help' || argument === '-h') return { help: true };
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return { help: false, commit, replace, allowIncomplete, sourceDirectory };
}

export async function runImport(options, logger = console) {
  logger.log(`MEDSL 2024 ${options.commit ? 'commit' : 'dry-run'}: scanning ${options.sourceDirectory}`);
  const discovery = await openStateArchiveDirectory(options.sourceDirectory);
  const items = [];
  for (const [index, archive] of discovery.archives.entries()) {
    const state = await readStateResults(archive);
    logger.log(
      `[${index + 1}/${discovery.archives.length}] ${archive.filename} -> ${state.abbreviation}: `
      + `${state.supportedRows.toLocaleString()} relevant rows, ${state.contests.length} contests`
    );
    items.push({ archive, state });
  }
  const duplicates = [...new Set(items.map(item => item.state.abbreviation))]
    .filter(abbreviation => items.filter(item => item.state.abbreviation === abbreviation).length > 1);
  if (duplicates.length) throw new Error(`Duplicate state archives: ${duplicates.join(', ')}`);
  items.sort((left, right) => left.state.abbreviation.localeCompare(right.state.abbreviation));
  const imported = new Set(items.map(item => item.state.abbreviation));
  const missing = expectedJurisdictions.filter(abbreviation => !imported.has(abbreviation));
  const unexpected = [...imported].filter(abbreviation => !expectedJurisdictions.includes(abbreviation));
  if (unexpected.length) throw new Error(`Unexpected jurisdictions: ${unexpected.join(', ')}`);
  if (missing.length && !options.allowIncomplete) {
    throw new Error(
      `Missing 2024 jurisdictions: ${missing.join(', ')}. Add their state archives or use --allow-incomplete.`
    );
  }
  const summaryReport = applyResultSummaries(items, await readResultSummaries(options.sourceDirectory));
  for (const summary of summaryReport.files) {
    logger.log(`Using ${summary.filename} as ${summary.classification.replace('_', ' ')} reconciliation data.`);
  }
  if (discovery.rejected.length) {
    for (const rejected of discovery.rejected) {
      logger.warn(`Skipped unreadable ${rejected.filename}: ${rejected.reason}`);
    }
  }
  const result = await importResults({
    items,
    rejectedArchives: [
      ...discovery.rejected,
      ...summaryReport.rejected.map(item => ({
        filename: item.filename,
        reason: `summary skipped: ${item.reason}`
      }))
    ],
    commit: options.commit,
    replace: options.replace,
    onProgress: message => logger.log(message)
  });
  return { ...result, missingJurisdictions: missing, summaryReport };
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

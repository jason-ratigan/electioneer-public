import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, initializeDatabase } from '../../db.js';
import { openHouseArchive } from './archive.js';
import { importHouseResults } from './importHouse.js';
import { readHouseResults } from './readHouse.js';

function usage() {
  return `Usage: npm run import:medsl:house:2020 -- [options]

Options:
  --commit          Persist the validated import.
  --archive PATH    MEDSL House ZIP (default: us_house_2020.zip).
  --help, -h        Show this help.

Without --commit, the complete import is validated and rolled back.`;
}

export function parseHouseArguments(argv) {
  let commit = false;
  let archivePath = path.resolve('us_house_2020.zip');
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--commit') commit = true;
    else if (argument === '--archive') {
      if (!argv[index + 1]) throw new Error('--archive requires a path');
      archivePath = path.resolve(argv[index + 1]);
      index += 1;
    } else if (argument === '--help' || argument === '-h') {
      return { help: true };
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { help: false, archivePath, commit };
}

export async function runHouseImport(options, logger = console) {
  logger.log(`MEDSL 2020 House ${options.commit ? 'commit' : 'dry-run'}: opening archive`);
  const archive = await openHouseArchive(options.archivePath);
  const parsed = await readHouseResults(archive, message => logger.log(message));
  logger.log(
    `${parsed.rowsRead.toLocaleString()} rows parsed into `
    + `${parsed.states.length} jurisdictions and `
    + `${parsed.states.reduce((sum, state) => sum + state.contests.length, 0)} contests`
  );
  const result = await importHouseResults({
    archive,
    parsed,
    commit: options.commit,
    onProgress: message => logger.log(message)
  });
  if (result.alreadyImported) logger.log(`Archive already imported in batch ${result.batchId}.`);
  else logger.log(
    `${options.commit ? 'Imported' : 'Validated'} ${result.contests} contests, `
    + `${result.choices} choices, and ${result.voteTotals} vote totals with ${result.warnings} warnings.`
  );
  return { mode: options.commit ? 'committed' : 'dry-run', ...result };
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  let exitCode = 0;
  try {
    const options = parseHouseArguments(process.argv.slice(2));
    if (options.help) console.log(usage());
    else {
      await initializeDatabase();
      const summary = await runHouseImport(options);
      console.log(JSON.stringify(summary, null, 2));
    }
  } catch (error) {
    console.error(error.stack || error.message);
    exitCode = 1;
  } finally {
    await closeDatabase();
    process.exitCode = exitCode;
  }
}

import path from 'node:path';
import { closeDatabase } from '../../db.js';
import { importDelaware } from './importDelaware.js';

function usage() {
  return `Usage: npm run import:vest:de -- [--commit] [--archive PATH]

Runs a complete Delaware VEST validation and PostgreSQL transaction.
The transaction is rolled back unless --commit is provided.`;
}

function parseArguments(argv) {
  let commit = false;
  let archivePath = path.resolve('dataverse_files.zip');

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

  return { archivePath, commit, help: false };
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) console.log(usage());
  else console.log(JSON.stringify(await importDelaware(options), null, 2));
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
} finally {
  await closeDatabase();
}

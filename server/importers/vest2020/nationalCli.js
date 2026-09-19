import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, initializeDatabase } from '../../db.js';
import { openVestArchive } from './archive.js';
import { parseVestDocumentation } from './documentation.js';
import { importVestState } from './importState.js';
import { resolveVestState, vestStates } from './states.js';

function usage() {
  return `Usage: npm run import:vest:2020 -- (--all | --states AL,CA,NY) [options]

Options:
  --commit          Persist each successful state in its own transaction.
  --archive PATH    Outer Harvard Dataverse ZIP (default: dataverse_files.zip).
  --stop-on-error   Stop after the first state failure instead of continuing.
  --help, -h        Show this help.

Without --commit, every state runs through the complete import and validation
pipeline, then its transaction is rolled back.`;
}

export function parseNationalArguments(argv) {
  let commit = false;
  let all = false;
  let stopOnError = false;
  let archivePath = path.resolve('dataverse_files.zip');
  let requestedStates = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--commit') commit = true;
    else if (argument === '--all') all = true;
    else if (argument === '--stop-on-error') stopOnError = true;
    else if (argument === '--archive') {
      if (!argv[index + 1]) throw new Error('--archive requires a path');
      archivePath = path.resolve(argv[index + 1]);
      index += 1;
    } else if (argument === '--states') {
      if (!argv[index + 1]) throw new Error('--states requires a comma-separated list');
      requestedStates.push(...argv[index + 1].split(',').map(value => value.trim()).filter(Boolean));
      index += 1;
    } else if (argument === '--help' || argument === '-h') {
      return { help: true };
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (all && requestedStates.length) throw new Error('Use either --all or --states, not both');
  if (!all && !requestedStates.length) throw new Error('Choose --all or provide --states AL,CA,...');
  const states = all
    ? vestStates
    : [...new Map(requestedStates.map(value => {
        const state = resolveVestState(value);
        return [state.abbreviation, state];
      })).values()];
  return { help: false, archivePath, commit, stopOnError, states };
}

export async function runNationalImport(options, logger = console) {
  const outer = await openVestArchive(options.archivePath);
  const documentation = parseVestDocumentation(outer.documentation);
  const results = [];
  const failures = [];

  logger.log(`VEST 2020 ${options.commit ? 'commit' : 'dry-run'}: ${options.states.length} state archive(s)`);
  for (const [index, state] of options.states.entries()) {
    logger.log(`[${index + 1}/${options.states.length}] ${state.abbreviation} ${state.name}: starting`);
    try {
      const result = await importVestState({
        outer,
        state,
        documentation,
        commit: options.commit,
        onProgress: message => logger.log(`[${index + 1}/${options.states.length}] ${state.abbreviation}: ${message}`)
      });
      results.push(result);
      const outcome = result.repaired
        ? `repaired ${result.repairedVoteTotals} vote totals`
        : result.alreadyImported
          ? 'already imported'
          : options.commit ? 'imported' : 'validated';
      logger.log(
        `[${index + 1}/${options.states.length}] ${state.abbreviation}: ${outcome}; `
        + `${result.precincts ?? 'existing'} precincts, ${result.contests ?? 'existing'} contests, ${result.counties.counties ?? result.counties} counties`
      );
    } catch (error) {
      failures.push({ state: state.abbreviation, error: error.message });
      logger.error(`[${index + 1}/${options.states.length}] ${state.abbreviation}: FAILED — ${error.message}`);
      if (options.stopOnError) break;
    }
  }

  return {
    mode: options.commit ? 'committed' : 'dry-run',
    requested: options.states.length,
    succeeded: results.length,
    failed: failures.length,
    alreadyImported: results.filter(result => result.alreadyImported).length,
    states: results.map(result => ({
      state: result.state,
      precincts: result.precincts ?? null,
      contests: result.contests ?? null,
      counties: result.counties?.counties ?? result.counties ?? null,
      alreadyImported: result.alreadyImported
    })),
    failures
  };
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  let exitCode = 0;
  try {
    const options = parseNationalArguments(process.argv.slice(2));
    if (options.help) console.log(usage());
    else {
      await initializeDatabase();
      const summary = await runNationalImport(options);
      console.log(JSON.stringify(summary, null, 2));
      if (summary.failed) exitCode = 1;
    }
  } catch (error) {
    console.error(error.stack || error.message);
    exitCode = 1;
  } finally {
    await closeDatabase();
    process.exitCode = exitCode;
  }
}

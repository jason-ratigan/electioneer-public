import { closeDatabase } from '../db.js';
import { importElectoralUpdate } from './importUpdate.js';

const filePath = process.argv.slice(2).find(arg => !arg.startsWith('--'));
if (!filePath) {
  console.error('Usage: npm run import:electoral -- path/to/update.json [--commit]');
  process.exitCode = 1;
} else {
  try {
    console.log(JSON.stringify(await importElectoralUpdate(filePath, { commit: process.argv.includes('--commit') }), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await closeDatabase();
  }
}

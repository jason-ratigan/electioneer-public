import { closeDatabase, initializeDatabase } from './db.js';

try {
  await initializeDatabase();
  console.log('Database migrations applied.');
} finally {
  await closeDatabase();
}

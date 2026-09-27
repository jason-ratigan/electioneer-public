import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;
const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'migrations'
);

export const db = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://signal:signal@localhost:15432/signal',
  max: Number(process.env.DATABASE_POOL_SIZE || 10),
  ssl: process.env.DATABASE_SSL === 'true'
    ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' }
    : undefined
});

db.on('error', error => console.error('Unexpected PostgreSQL pool error', error));

export const run = (sql, params = []) => db.query(sql, params);
export const all = async (sql, params = []) => (await db.query(sql, params)).rows;
export const closeDatabase = () => db.end();

export async function initializeDatabase() {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('signal_schema_migrations'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const applied = new Set(
      (await client.query('SELECT name FROM schema_migrations')).rows.map(row => row.name)
    );
    const migrationFiles = (await fs.readdir(migrationsDirectory))
      .filter(file => file.endsWith('.sql'))
      .sort();

    for (const migrationFile of migrationFiles) {
      if (applied.has(migrationFile)) continue;
      const sql = await fs.readFile(path.join(migrationsDirectory, migrationFile), 'utf8');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [migrationFile]);
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

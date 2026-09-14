import duckdb from 'duckdb';
import fs from 'node:fs';
fs.mkdirSync('data', { recursive: true });
export const db = new duckdb.Database(process.env.DATABASE_PATH || 'data/signal.duckdb');
export const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, ...params, error => error ? reject(error) : resolve()));
export const all = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, ...params, (error, rows) => error ? reject(error) : resolve(rows)));

export async function initializeDatabase() {
  await run(`CREATE TABLE IF NOT EXISTS races (id VARCHAR PRIMARY KEY, cycle INTEGER, election_type VARCHAR, election_level VARCHAR, office VARCHAR, jurisdiction VARCHAR, is_ballot_measure BOOLEAN DEFAULT FALSE, candidate_a VARCHAR, candidate_b VARCHAR)`);
  await run(`CREATE TABLE IF NOT EXISTS observations (id VARCHAR PRIMARY KEY, race_id VARCHAR, observed_at TIMESTAMP, metric VARCHAR, value_a DOUBLE, value_b DOUBLE, reporting DOUBLE, source VARCHAR)`);
  await run(`CREATE TABLE IF NOT EXISTS ingest_runs (id VARCHAR PRIMARY KEY, source VARCHAR, started_at TIMESTAMP, completed_at TIMESTAMP, status VARCHAR, rows_added INTEGER, message VARCHAR)`);
  const [{ count }] = await all('SELECT COUNT(*)::INTEGER count FROM races');
  if (!count) {
    await run(`INSERT INTO races VALUES
      ('az-sen-g',2026,'general','state','Senate','Arizona',FALSE,'Candidate A','Candidate B'),
      ('ga-gov-p',2026,'primary','state','Governor','Georgia',FALSE,'Candidate A','Candidate B'),
      ('us-pres-g',2024,'presidential_general','national','President','National',FALSE,'Candidate A','Candidate B'),
      ('us-pres-primary',2024,'presidential_primary','state','President','Illustrative State',FALSE,'Candidate A','Candidate B'),
      ('us-pres-2020',2020,'presidential_general','national','President','National',FALSE,'Candidate A','Candidate B'),
      ('mi-gov-2018',2018,'general','state','Governor','Michigan',FALSE,'Candidate A','Candidate B'),
      ('pa-sen-2016',2016,'general','state','Senate','Pennsylvania',FALSE,'Candidate A','Candidate B'),
      ('us-pres-2012',2012,'presidential_general','national','President','National',FALSE,'Candidate A','Candidate B'),
      ('nc-gov-2008',2008,'general','state','Governor','North Carolina',FALSE,'Candidate A','Candidate B'),
      ('us-pres-2004',2004,'presidential_general','national','President','National',FALSE,'Candidate A','Candidate B'),
      ('us-pres-2000',2000,'presidential_general','national','President','National',FALSE,'Candidate A','Candidate B')`);
    await run(`INSERT INTO observations VALUES
      ('o1','az-sen-g',CURRENT_TIMESTAMP,'poll',46.8,45.9,0,'Illustrative demo'),
      ('o2','ga-gov-p',CURRENT_TIMESTAMP,'poll',42.3,39.8,0,'Illustrative demo'),
      ('o3','us-pres-g',CURRENT_TIMESTAMP,'result',48.2,49.1,100,'Illustrative demo'),
      ('o11','us-pres-primary',CURRENT_TIMESTAMP,'result',45.2,39.1,100,'Illustrative demo'),
      ('o4','us-pres-2020',CURRENT_TIMESTAMP,'result',51.2,46.8,100,'Illustrative demo'),
      ('o5','mi-gov-2018',CURRENT_TIMESTAMP,'result',52.1,45.3,100,'Illustrative demo'),
      ('o6','pa-sen-2016',CURRENT_TIMESTAMP,'result',47.4,48.8,100,'Illustrative demo'),
      ('o7','us-pres-2012',CURRENT_TIMESTAMP,'result',50.7,47.9,100,'Illustrative demo'),
      ('o8','nc-gov-2008',CURRENT_TIMESTAMP,'result',49.2,47.1,100,'Illustrative demo'),
      ('o9','us-pres-2004',CURRENT_TIMESTAMP,'result',48.3,50.7,100,'Illustrative demo'),
      ('o10','us-pres-2000',CURRENT_TIMESTAMP,'result',48.4,47.9,100,'Illustrative demo')`);
  }
}

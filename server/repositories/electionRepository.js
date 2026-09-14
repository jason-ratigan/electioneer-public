import fs from 'node:fs';
import { all, run } from '../db.js';
import { archivePolicy } from '../config.js';
export const electionRepository = {
  listRaces: ({type, cycle, office, query}) => all(`SELECT r.*, o.value_a, o.value_b, o.reporting, o.observed_at, o.source FROM races r LEFT JOIN observations o ON o.race_id=r.id WHERE (? IS NULL OR r.election_type=?) AND (? IS NULL OR r.cycle=?) AND (? IS NULL OR r.office=?) AND (? IS NULL OR LOWER(r.jurisdiction) LIKE '%' || LOWER(?) || '%') QUALIFY ROW_NUMBER() OVER (PARTITION BY r.id ORDER BY o.observed_at DESC)=1 ORDER BY r.cycle DESC, r.office, r.jurisdiction`, [type,type,cycle,cycle,office,office,query,query]),
  archiveFacets: async () => ({
    cycles: (await all('SELECT DISTINCT cycle FROM races WHERE cycle <= 2024 ORDER BY cycle DESC')).map(row=>row.cycle),
    offices: (await all('SELECT DISTINCT office FROM races WHERE cycle <= 2024 ORDER BY office')).map(row=>row.office)
  }),
  raceHistory: id => all('SELECT observed_at, metric, value_a, value_b, reporting, source FROM observations WHERE race_id=? ORDER BY observed_at', [id]),
  addObservation: value => run('INSERT INTO observations VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [value.id, value.raceId, value.observedAt, value.metric, value.valueA, value.valueB, value.reporting, value.source]),
  recordIngestRun: runInfo => run('INSERT INTO ingest_runs VALUES (?, ?, ?, ?, ?, ?, ?)', [runInfo.id, runInfo.source, runInfo.startedAt, runInfo.completedAt, runInfo.status, runInfo.rowsAdded, runInfo.message]),
  recentIngestRuns: () => all('SELECT * FROM ingest_runs ORDER BY started_at DESC LIMIT 20'),
  storage: async () => { const file=process.env.DATABASE_PATH||'data/signal.duckdb'; const bytes=fs.existsSync(file)?fs.statSync(file).size:0; const counts=await all(`SELECT (SELECT COUNT(*) FROM races)::INTEGER races, (SELECT COUNT(*) FROM observations)::INTEGER observations, (SELECT COUNT(*) FROM ingest_runs)::INTEGER ingest_runs`); return {...counts[0],bytes,megabytes:Number((bytes/1048576).toFixed(2)),limitMegabytes:archivePolicy.maxDatabaseMb}; }
};

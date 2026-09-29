import { db } from '../../db.js';
import { processJob } from './workflow.js';

// Session advisory lock makes recovery safe across API replicas and process crashes.
const lease=await db.connect();
const [{locked}]=(await lease.query("SELECT pg_try_advisory_lock(hashtext('admin-import-worker')) AS locked")).rows;
if(!locked) {lease.release();await db.end();process.exit(0);}
await db.query(`UPDATE ingestion_runs SET status='failed',completed_at=now(),message='Worker interrupted; retry creates a new audited attempt' WHERE status='running' AND parser_name='admin-import'`);
await db.query(`UPDATE admin_imports SET status='queued',message='Resuming interrupted job' WHERE status IN ('validating','committing')`);
let stopping=false;
process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
while(!stopping) {
  const job=(await db.query(`UPDATE admin_imports SET status=CASE WHEN phase='preview' THEN 'validating' ELSE 'committing' END,progress=5,updated_at=now() WHERE id=(SELECT id FROM admin_imports WHERE status='queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`)).rows[0];
  if(job) await processJob(job);
  else await new Promise(resolve=>setTimeout(resolve,1000));
}
await lease.query("SELECT pg_advisory_unlock(hashtext('admin-import-worker'))");lease.release();await db.end();

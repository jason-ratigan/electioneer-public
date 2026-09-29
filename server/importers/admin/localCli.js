import '../../loadEnv.js';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { db,initializeDatabase,closeDatabase } from '../../db.js';
import { receiveUpload } from './storage.js';
import { processJob } from './workflow.js';

// Local operator tool; HTTP access still requires bearer authentication.
const args=process.argv.slice(2);const files=[];let commit=false;
for(let i=0;i<args.length;i++) {
  if(args[i]==='--commit') commit=true;
  else if(args[i]==='--file'&&args[i+1]) files.push(path.resolve(args[++i]));
  else if(args[i]==='--polling-dir'&&args[i+1]) {
    const directory=path.resolve(args[++i]);
    for(const name of (await readdir(directory)).filter(n=>n.toLowerCase().endsWith('.csv')).sort()) files.push(path.join(directory,name));
  } else throw new Error(`Unknown/incomplete argument ${args[i]}. Use --file PATH or --polling-dir PATH, optionally --commit.`);
}
if(!files.length) throw new Error('Choose --file PATH or --polling-dir PATH. Default mode stages previews; --commit explicitly publishes validated files.');
await initializeDatabase();
const lease=await db.connect();
const ownsWorker=(await lease.query("SELECT pg_try_advisory_lock(hashtext('admin-import-worker')) AS locked")).rows[0].locked;
async function settle(id) {
  for(let attempt=0;attempt<3600;attempt++) {
    const job=(await db.query('SELECT * FROM admin_imports WHERE id=$1',[id])).rows[0];
    if(['ready','completed','failed'].includes(job.status)) return job;
    if(ownsWorker&&job.status==='queued') {
      await db.query(`UPDATE admin_imports SET status=CASE WHEN phase='preview' THEN 'validating' ELSE 'committing' END WHERE id=$1`,[id]);
      await processJob(job);
    }else await new Promise(resolve=>setTimeout(resolve,1000));
  }
  throw new Error('Worker timeout; the durable job can be resumed from Admin imports.');
}
try {
  for(const file of files) {
    const id=randomUUID(),filename=path.basename(file);
    const artifact=await receiveUpload(createReadStream(file),id);
    await db.query(`INSERT INTO admin_imports(id,filename,sha256,byte_size,status,message) VALUES($1,$2,$3,$4,'queued','Local operator upload')`,[id,filename,artifact.sha256,artifact.byteSize]);
    const preview=await settle(id);
    if(preview.status!=='ready') throw new Error(`${filename}: ${preview.message}`);
    console.log(JSON.stringify({file:filename,importId:id,mode:commit?'preview then commit':'preview only',scope:{source:preview.preview.source,cycles:preview.preview.cycles,stages:preview.preview.stages,rows:preview.preview.rows,questions:preview.preview.questions,averages:preview.preview.averages},newRecords:preview.preview.newRecords,warnings:preview.preview.warnings}));
    if(commit) {
      await db.query(`UPDATE admin_imports SET status='queued',phase='commit',confirmed_at=now(),progress=0,message='Explicit local --commit confirmation' WHERE id=$1 AND status='ready' AND confirmation=$2`,[id,preview.confirmation]);
      const done=await settle(id);
      if(done.status!=='completed') throw new Error(`${filename}: ${done.message}`);
      const report=done.report;
      console.log(JSON.stringify({file:filename,status:done.status,newQuestions:report.newQuestions,revisedQuestions:report.revisedQuestions,unchangedQuestions:report.unchangedQuestions,newAverages:report.newAverages,alreadyImported:report.alreadyImported,states:report.states?.length,historyId:id}));
    }
  }
}finally {
  if(ownsWorker) await lease.query("SELECT pg_advisory_unlock(hashtext('admin-import-worker'))");
  lease.release();await closeDatabase();
}

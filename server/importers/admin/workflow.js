import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { db } from '../../db.js';
import { storePolls } from './polls.js';
import { storeState } from '../medsl2024/importResults.js';
import { importHouseResults } from '../medsl2020/importHouse.js';
import { persistState } from '../vest2020/importState.js';
import { privatePath,hashFile,savePlan,readPlan } from './storage.js';
import { parseUpload } from './adapters.js';
import { sha,nytUrl } from './nyt.js';
import { vestStates } from '../vest2020/states.js';
import { downloadNytRefresh } from './nytRefresh.js';

const sourceUrls={ 'nyt-polls':nytUrl,medsl:'https://github.com/MEDSL/2024-elections-official',vest:'https://doi.org/10.7910/DVN/K7760H' };
const counts=async client=>(await client.query(`SELECT (SELECT count(*) FROM polls)::int AS surveys,(SELECT count(*) FROM poll_questions)::int AS questions,(SELECT count(*) FROM contests)::int AS contests,(SELECT count(*) FROM candidates)::int AS candidates,(SELECT count(*) FROM result_snapshots)::int AS snapshots`)).rows[0];
export async function executePlan(client,job,plan,runId,progress) {
  const source=(await client.query('SELECT id FROM data_sources WHERE slug=$1',[plan.source])).rows[0];
  const sourceUrl=job.source_url || (plan.adapter==='medsl-house-2020-v1'?'https://github.com/MEDSL/2020-elections-official':sourceUrls[plan.source]);
  const license=job.license || (plan.source==='medsl'?'Not specified in supplied repository; retain MEDSL citation and verify dataset terms':'CC BY 4.0');
  const artifact=(await client.query(`INSERT INTO source_artifacts(source_id,uri,retrieved_at,sha256,byte_size,content_type,license,metadata)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(source_id,sha256) WHERE sha256 IS NOT NULL DO UPDATE SET sha256=source_artifacts.sha256 RETURNING id`,
  [source.id,pathToFileURL(privatePath(job.id)).href,job.created_at,job.sha256,job.byte_size,job.filename.toLowerCase().endsWith('.zip')?'application/zip':'text/csv',license,JSON.stringify({filename:job.filename,sourceUrl,attribution:plan.source==='nyt-polls'?'Polling data compiled by The New York Times':plan.source==='medsl'?'MIT Election Data and Science Lab':'Voting and Election Science Team',changes:'Parsed and mapped; published polling percentages unchanged',uploadId:job.id})])).rows[0];
  await client.query(`INSERT INTO ingestion_runs(id,source_id,source_artifact_id,started_at,status,rows_read,parser_name,parser_version,metadata)
    VALUES($1,$2,$3,now(),'running',$4,'admin-import','1',$5) ON CONFLICT(id) DO UPDATE SET source_artifact_id=EXCLUDED.source_artifact_id,status='running'`,[runId,source.id,artifact.id,plan.rowsRead,JSON.stringify({uploadId:job.id,adapter:plan.adapter})]);
  const prior=await client.query(`SELECT id FROM ingestion_runs WHERE source_artifact_id=$1 AND parser_name='admin-import' AND status IN ('completed','completed_with_warnings') AND id<>$2 LIMIT 1`,[artifact.id,runId]);
  let report;
  if(prior.rows.length) report={alreadyImported:true,previousRun:prior.rows[0].id};
  else if(plan.source==='nyt-polls') report=await storePolls(client,plan,{sourceId:source.id,artifactId:artifact.id,runId,progress});
  else if(plan.adapter==='medsl-2024-v1') {
    const officeIds=new Map((await client.query('SELECT id,slug FROM offices')).rows.map(o=>[o.slug,o.id]));
    const results=[];
    for(const item of plan.items) {
      const known=vestStates.find(s=>s.abbreviation===item.state.abbreviation&&s.stateFips===item.state.stateFips);
      if(!known) throw new Error(`State abbreviation/FIPS mapping conflict: ${item.state.abbreviation}/${item.state.stateFips}`);
      await client.query(`INSERT INTO geographies(geography_type,name,abbreviation,state_fips) VALUES('state',$1,$2,$3) ON CONFLICT DO NOTHING`,[known.name,known.abbreviation,known.stateFips]);
      const counties=(await client.query("SELECT county_fips FROM geographies WHERE state_fips=$1 AND geography_type IN ('county','county_equivalent')",[known.stateFips])).rows;
      const countySet=new Set(counties.map(c=>c.county_fips));
      const unresolvedGeographies=[...new Map(item.state.contests.flatMap(c=>c.counties).filter(c=>!countySet.has(c.countyFips)).map(c=>[c.fips,{fips:c.fips,name:c.name,action:'County detail omitted; source contest totals retained'}])).values()];
      const result=await storeState(client,source.id,runId,item.archive,item.state,officeIds);
      result.unresolvedGeographies=unresolvedGeographies;
      if(!result.skipped) {
        // Source observations remain immutable; a correction appends snapshots.
        await client.query(`UPDATE result_batches b SET supersedes_batch_id=(SELECT old.id FROM result_batches old WHERE old.source_id=b.source_id AND old.id<>b.id AND old.metadata->>'state'=b.metadata->>'state' ORDER BY old.retrieved_at DESC LIMIT 1) WHERE b.id=$1`,[result.batchId]);
        await client.query(`UPDATE source_artifacts SET parent_artifact_id=CASE WHEN id<>$2 THEN $2 ELSE parent_artifact_id END,license=COALESCE(license,$3),metadata=metadata||$4::jsonb WHERE id=(SELECT source_artifact_id FROM result_batches WHERE id=$1)`,[result.batchId,artifact.id,license,JSON.stringify({sourceUrl,uploadId:job.id})]);
        await client.query(`UPDATE result_snapshots SET reporting_basis='unknown',reporting_value=NULL,metadata=metadata||'{"completeness":"not asserted by admin upload"}'::jsonb WHERE batch_id=$1`,[result.batchId]);
        await client.query(`UPDATE reporting_unit_statuses SET count_status='unknown',reporting_basis='unknown',reporting_value=NULL WHERE snapshot_id IN (SELECT id FROM result_snapshots WHERE batch_id=$1)`,[result.batchId]);
      }
      results.push(result);await progress?.(`Stored ${item.state.abbreviation}`);
    }
    report={states:results,reconciliation:plan.reconciliation||null};
  } else if(plan.adapter==='medsl-house-2020-v1') {
    for(const state of plan.parsed.states) {
      const known=vestStates.find(s=>s.abbreviation===state.abbreviation&&s.stateFips===state.stateFips);
      if(!known) throw new Error(`State abbreviation/FIPS mapping conflict: ${state.abbreviation}/${state.stateFips}`);
      await client.query(`INSERT INTO geographies(geography_type,name,abbreviation,state_fips) VALUES('state',$1,$2,$3) ON CONFLICT DO NOTHING`,[known.name,known.abbreviation,known.stateFips]);
    }
    report=await importHouseResults({archive:plan.archive,parsed:plan.parsed,transactionClient:client,commit:true,onProgress:message=>{void progress?.(message);}});
    if(!report.alreadyImported) {
      await client.query(`UPDATE source_artifacts SET parent_artifact_id=CASE WHEN id<>$2 THEN $2 ELSE parent_artifact_id END,license=COALESCE(license,$3),content_type=$4,metadata=metadata||$5::jsonb WHERE id=(SELECT source_artifact_id FROM result_batches WHERE id=$1)`,[report.batchId,artifact.id,license,plan.archive.contentType||'application/zip',JSON.stringify({sourceUrl,uploadId:job.id,filename:plan.archive.filename})]);
      await client.query(`UPDATE result_snapshots SET reporting_basis='unknown',reporting_value=NULL WHERE batch_id=$1`,[report.batchId]);
      await client.query(`UPDATE reporting_unit_statuses SET reporting_basis='unknown',reporting_value=NULL,count_status='unknown' WHERE snapshot_id IN (SELECT id FROM result_snapshots WHERE batch_id=$1)`,[report.batchId]);
    }
  } else if(plan.adapter==='vest-2020-v1') {
    const results=[];
    for(const item of plan.items) {
      const existing=await client.query(`SELECT b.id FROM result_batches b JOIN source_artifacts a ON a.id=b.source_artifact_id WHERE a.source_id=$1 AND a.sha256=$2`,[source.id,item.archive.stateSha256]);
      // The legacy CLI has a repair path; admin retries must not rewrite history.
      if(existing.rows.length) results.push({state:item.state.abbreviation,alreadyImported:true});
      else results.push(await persistState(client,plan.outer,item.archive,item.parsed,item.state,{runId:randomUUID(),startedAt:new Date().toISOString(),commit:true}));
      await progress?.(`Stored ${item.state.abbreviation}`);
    }
    report={states:results};
  } else throw new Error('Unsupported adapter');
  report.warnings=plan.warnings;
  await client.query(`UPDATE ingestion_runs SET status=$2,completed_at=now(),rows_added=$3,warning_count=$4,message=$5,metadata=metadata||$6::jsonb WHERE id=$1`,[runId,plan.warnings.length?'completed_with_warnings':'completed',report.responses||report.newAverages||report.voteTotals||report.states?.reduce((n,s)=>n+(s.voteTotals||s.detailVoteTotals||0),0)||0,plan.warnings.length,'Admin import finished',JSON.stringify(report)]);
  return report;
}

function describe(plan) {
  const questions = plan.questions || [];
  const resultStates = plan.items?.map(i => ({ ...i.state, contests: i.state.contests || i.parsed?.contests || [] })) || plan.parsed?.states || [];
  const unique = values => [...new Set(values.filter(value => value != null))];
  const resultContests = resultStates.flatMap(s => s.contests);
  const skipped = plan.adapter === 'medsl-house-2020-v1'
    ? ['duplicateRows','excludedModeRows','excludedStatisticRows','suppressedRows'].reduce((n,key) => n + (plan.parsed[key] || 0), 0)
    : resultStates.reduce((n,s) => n + (s.excludedModeRows || 0) + (s.excludedStatisticRows || 0) + (s.supportedRows != null ? s.rowsRead - s.supportedRows : 0), 0);
  return {
    adapter: plan.adapter,
    source: plan.source,
    cycles: unique(questions.map(q => q.cycle).concat(resultStates.length ? [plan.adapter.includes('2020') ? 2020 : 2024] : [])),
    offices: unique(questions.map(q => q.office).concat(resultContests.map(c => c.officeSlug || 'us_house'))),
    stages: unique(questions.map(q => q.stage).concat(resultContests.map(c => c.special ? 'special' : 'general'))),
    geographies: unique(questions.map(q => q.state).concat(resultStates.map(s => s.abbreviation))),
    rows: plan.rowsRead,
    questions: questions.length,
    surveys: new Set(questions.map(q => q.pollKey)).size,
    contests: new Set(questions.map(q => q.raceKey).filter(Boolean)).size + resultContests.length,
    averages: plan.averages?.length || 0,
    warnings: plan.warnings,
    skippedRows: (plan.duplicateRows || 0) + skipped,
    skippedFiles: plan.skippedFiles || [],
    sourceCounters: resultStates.map(s => ({ state:s.abbreviation, suppressedRows:s.suppressedRows || 0, invalidCountyRows:s.invalidCountyRows || 0, excludedModeRows:s.excludedModeRows || 0, adjustmentRows:s.adjustmentRows || 0, duplicateRows:s.duplicateRows || 0 }))
  };
}

export async function processJob(job) {
  const progress=async message=>{await db.query('UPDATE admin_imports SET message=$2,updated_at=now() WHERE id=$1',[job.id,message]);};
  let client,runId;
  try {
    if(job.phase==='download') {
      await progress('Downloading from The New York Times');
      const upload=await downloadNytRefresh(job);
      await db.query(`UPDATE admin_imports SET sha256=$2,byte_size=$3,phase='preview',status='queued',progress=0,message='Download complete; validation queued',updated_at=now() WHERE id=$1`,[job.id,upload.sha256,upload.byteSize]);
      return;
    }
    if(await hashFile(privatePath(job.id))!==job.sha256) throw new Error('Stored upload checksum changed; upload the source again.');
    if(job.phase==='preview') {
      const plan=await parseUpload(job,progress);
      await savePlan(job.id,plan);
      client=await db.connect();await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('admin-publication'))");
      const before=await counts(client);
      const report=await executePlan(client,job,plan,randomUUID(),progress);
      const after=await counts(client);
      await client.query('ROLLBACK');client.release();client=null;
      const preview={...describe(plan),changes:report,newRecords:Object.fromEntries(Object.keys(before).map(k=>[k,after[k]-before[k]])),planChecksum:await hashFile(privatePath(job.id,'plan')),sourceUrl:job.source_url||(plan.adapter==='medsl-house-2020-v1'?'https://github.com/MEDSL/2020-elections-official':sourceUrls[plan.source]),license:job.license||(plan.source==='medsl'?'Dataset terms not supplied':'CC BY 4.0')};
      const confirmation=sha({checksum:job.sha256,preview});
      await db.query(`UPDATE admin_imports SET status=CASE WHEN auto_publish THEN 'queued' ELSE 'ready' END,
        phase=CASE WHEN auto_publish THEN 'commit' ELSE 'preview' END,
        progress=CASE WHEN auto_publish THEN 0 ELSE 100 END,
        preview=$2,confirmation=$3,
        confirmed_at=CASE WHEN auto_publish THEN now() ELSE confirmed_at END,
        message=CASE WHEN auto_publish THEN 'Validated NYT download; publication queued' ELSE 'Preview validated in a rolled-back transaction. Review and explicitly confirm to publish.' END,
        updated_at=now() WHERE id=$1`,[job.id,JSON.stringify(preview),confirmation]);
    } else {
      if(!job.confirmed_at || await hashFile(privatePath(job.id,'plan'))!==job.preview?.planChecksum) throw new Error('The staged plan changed or was not confirmed. Upload again.');
      const plan=await readPlan(job.id);
      const source=(await db.query('SELECT id FROM data_sources WHERE slug=$1',[plan.source])).rows[0];
      runId=randomUUID();
      await db.query(`INSERT INTO ingestion_runs(id,source_id,started_at,status,parser_name,parser_version,metadata) VALUES($1,$2,now(),'running','admin-import','1',$3)`,[runId,source.id,JSON.stringify({uploadId:job.id})]);
      await db.query('UPDATE admin_imports SET ingestion_run_id=$2 WHERE id=$1',[job.id,runId]);
      client=await db.connect();await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('admin-publication'))");
      const report=await executePlan(client,job,plan,runId,progress);
      await db.query('UPDATE admin_imports SET message=$2 WHERE id=$1',[job.id,'Publishing transaction']);
      await client.query(`UPDATE admin_imports SET status='completed',progress=100,report=$2,message='Import published',updated_at=now() WHERE id=$1`,[job.id,JSON.stringify(report)]);
      await client.query('COMMIT');client.release();client=null;
    }
  } catch(error) {
    if(client) {await client.query('ROLLBACK');client.release();}
    if(runId) await db.query(`UPDATE ingestion_runs SET status='failed',completed_at=now(),message=$2 WHERE id=$1`,[runId,error.message]);
    await db.query(`UPDATE admin_imports SET status='failed',message=$2,updated_at=now() WHERE id=$1`,[job.id,error.message]);
  }
}

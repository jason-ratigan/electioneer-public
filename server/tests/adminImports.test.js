import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile,readdir } from 'node:fs/promises';
import { Readable } from 'node:stream';
import express from 'express';
import { db,closeDatabase } from '../db.js';
import { parseCsv } from '../importers/admin/csv.js';
import { parseNyt,sha } from '../importers/admin/nyt.js';
import { storePolls } from '../importers/admin/polls.js';
import { executePlan } from '../importers/admin/workflow.js';
import { validateZipEntry } from '../importers/admin/storage.js';
import { adminRouter } from '../importers/admin/routes.js';
import { readStateResults } from '../importers/medsl2024/readState.js';
import { openStateArchive } from '../importers/medsl2024/archive.js';
import { readHouseResults } from '../importers/medsl2020/readHouse.js';

after(()=>closeDatabase());
const sample=async name=>parseNyt(parseCsv(await readFile(new URL(`../../polling/${name}`,import.meta.url),'utf8')));
test('CSV preserves quoted newlines, BOM, escapes and source IDs; malformed data fails',()=>{
  assert.deepEqual(parseCsv('\uFEFFid,text\r\n001,"one\ntwo, ""three"""\r\n').rows,[{id:'001',text:'one\ntwo, "three"'}]);
  assert.throws(()=>parseCsv('a,a\n1,2'),/unique/);
  assert.throws(()=>parseCsv('a,b\n"x,y'),/unterminated/);
  assert.throws(()=>parseCsv('a,b\nx'),/expected/);
});
test('all provided NYT files retain the real row and question counts',async()=>{
  const files=await readdir('polling');let rows=0,questions=0;const surveys=new Set();
  for(const file of files) {
    const plan=await sample(file);
    if(plan.adapter==='nyt-election-v1') {rows+=plan.rowsRead;questions+=plan.questions.length;plan.questions.forEach(q=>surveys.add(q.pollKey));}
    if(file==='president approval.csv') assert.equal(plan.questions.length,1246);
    if(file==='president-averages.csv') assert.equal(plan.averages.length,1204);
  }
  assert.equal(rows,20075);assert.equal(questions,4065);assert.equal(surveys.size,2284);
});
test('ZIP rejects traversal, drive paths, encrypted entries, symlinks and bombs',()=>{
  const entry={path:'folder/polls.csv',uncompressedSize:100,compressedSize:100};
  assert.equal(validateZipEntry(entry),'folder/polls.csv');
  for(const path of ['../x','C:/x','/x','foo\\..\\x']) assert.throws(()=>validateZipEntry({...entry,path}),/Unsafe/);
  assert.throws(()=>validateZipEntry({...entry,flags:1}),/encrypted/);
  assert.throws(()=>validateZipEntry({...entry,externalFileAttributes:0xa0000000}),/symlinks/);
  assert.throws(()=>validateZipEntry({...entry,uncompressedSize:1e9}),/limits/);
});
test('every admin route requires authentication before inspecting uploads or the DB',async()=>{
  const old=process.env.ADMIN_IMPORT_TOKEN;process.env.ADMIN_IMPORT_TOKEN='test-admin-secret-which-is-at-least-32-characters';
  const app=express();app.use(express.json());app.use('/api/admin',adminRouter);
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    for(const [method,path] of [['GET','/imports'],['GET','/imports/'+randomUUID()],['POST','/imports'],['POST',`/imports/${randomUUID()}/commit`],['POST',`/imports/${randomUUID()}/retry`]]) {
      assert.equal((await fetch(base+'/api/admin'+path,{method})).status,401);
    }
    assert.equal((await fetch(base+'/api/admin/session',{headers:{Authorization:`Bearer ${process.env.ADMIN_IMPORT_TOKEN}`}})).status,200);
    const headers={Authorization:`Bearer ${process.env.ADMIN_IMPORT_TOKEN}`};
    assert.equal((await fetch(base+'/api/admin/imports?filename=../x.csv',{method:'POST',headers})).status,400);
    assert.equal((await fetch(base+'/api/admin/imports?filename=x.csv',{method:'POST',headers})).status,415);
    assert.equal((await fetch(base+`/api/admin/imports/${randomUUID()}/commit`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{"confirmation":"stale"}'})).status,409);
  }finally{await new Promise(resolve=>server.close(resolve));if(old===undefined)delete process.env.ADMIN_IMPORT_TOKEN;else process.env.ADMIN_IMPORT_TOKEN=old;}
});
test('real polling transaction: cross-file survey identity, question samples, idempotency, immutable corrections and rollback',async()=>{
  const client=await db.connect();const initial=Number((await client.query('SELECT count(*) FROM poll_questions')).rows[0].count);
  try {
    await client.query('BEGIN');
    const source=(await client.query("SELECT id FROM data_sources WHERE slug='nyt-polls'")).rows[0].id;
    const artifact=(await client.query(`INSERT INTO source_artifacts(source_id,uri,retrieved_at,sha256) VALUES($1,'test://polls',now(),$2) RETURNING id`,[source,sha(randomUUID())])).rows[0].id;
    const run=(await client.query(`INSERT INTO ingestion_runs(source_id,started_at,status) VALUES($1,now(),'running') RETURNING id`,[source])).rows[0].id;
    const election=await sample('house.csv'),approval=await sample('president approval.csv');
    const a=approval.questions.find(q=>election.questions.some(e=>e.pollKey===q.pollKey));
    const b=election.questions.find(q=>q.pollKey===a.pollKey);
    // Isolate the test identities even when a user has already imported the samples.
    const suffix=randomUUID();for(const q of [a,b]) {q.key+=':'+suffix;q.pollKey+=':'+suffix;}
    const plan={questions:[a,b],averages:[]};const context={sourceId:source,artifactId:artifact,runId:run};
    const first=await storePolls(client,plan,context);assert.equal(first.newSurveys,1);assert.equal(first.newQuestions,2);
    const second=await storePolls(client,plan,context);assert.equal(second.unchangedQuestions,2);assert.equal(second.newQuestions,0);
    const rows=(await client.query('SELECT question_kind,contest_id,population,sample_size FROM poll_questions WHERE ingestion_run_id=$1',[run])).rows;
    assert.ok(rows.some(q=>q.question_kind==='generic_ballot'&&q.contest_id===null));
    assert.ok(rows.some(q=>q.question_kind==='approval'&&q.contest_id===null));assert.ok(rows.every(q=>q.sample_size>0));
    const nextArtifact=(await client.query(`INSERT INTO source_artifacts(source_id,uri,retrieved_at,sha256) VALUES($1,'test://correction',now(),$2) RETURNING id`,[source,sha(randomUUID())])).rows[0].id;
    a.responses[0].share+=.1;a.hash=sha(a);
    const corrected=await storePolls(client,{questions:[a],averages:[]},{...context,artifactId:nextArtifact});assert.equal(corrected.revisedQuestions,1);
    assert.equal(Number((await client.query('SELECT count(*) FROM poll_questions WHERE source_identifier=$1',[a.key])).rows[0].count),2);
    const oldShare=Number((await client.query('SELECT r.share FROM poll_responses r JOIN poll_questions q ON q.id=r.question_id WHERE q.source_identifier=$1 AND q.revision_of_question_id IS NULL ORDER BY r.source_identifier',[a.key])).rows[0].share);
    assert.notEqual(oldShare,a.responses[0].share);
    await client.query('ROLLBACK');
    assert.equal(Number((await client.query('SELECT count(*) FROM poll_questions')).rows[0].count),initial);
  }finally{await client.query('ROLLBACK');client.release();}
});
test('failure midway through publication rolls back every new poll and artifact',async()=>{
  const client=await db.connect();const checksum=sha(randomUUID());
  const plan=await sample('senate.csv');plan.questions=plan.questions.slice(0,2);plan.questions[1].state='ZZ';
  const suffix=randomUUID();plan.questions.forEach(q=>{q.key+=':'+suffix;q.pollKey+=':'+suffix;});
  const job={id:randomUUID(),filename:'renamed.csv',sha256:checksum,byte_size:123,created_at:new Date()};
  try {
    await client.query('BEGIN');
    await assert.rejects(executePlan(client,job,plan,randomUUID()),/Unresolved geography/);
    await client.query('ROLLBACK');
    assert.equal((await client.query('SELECT id FROM source_artifacts WHERE sha256=$1',[checksum])).rows.length,0);
    assert.equal((await client.query('SELECT id FROM poll_questions WHERE source_identifier=$1',[plan.questions[0].key])).rows.length,0);
  }finally{await client.query('ROLLBACK');client.release();}
});
test('representative real MEDSL state archive retains scope and aggregation guards',async()=>{
  const archive=await openStateArchive('2024_results/ar24.zip');const state=await readStateResults(archive);
  // The supplied ar24.zip actually contains Alaska: content must beat its filename.
  assert.equal(state.abbreviation,'AK');assert.equal(state.date,'2024-11-05');assert.ok(state.rowsRead>1000);assert.ok(state.contests.some(c=>c.officeSlug==='president'));
  const header='precinct,office,party_detailed,party_simplified,mode,votes,county_name,county_fips,jurisdiction_name,jurisdiction_fips,candidate,district,dataverse,year,stage,state,special,writein,state_po,state_fips,date,magnitude';
  const row='P1,US PRESIDENT,DEMOCRAT,DEMOCRAT,TOTAL,10,Example,05001,Example,05001,KAMALA HARRIS,,PRESIDENT,2024,GEN,ARKANSAS,FALSE,FALSE,AR,05,2024-11-05,1';
  const text=[header,row,row,row.replace('TOTAL,10','MAIL,4')].join('\n');
  const parsed=await readStateResults({csvPath:'test.csv',csvStream:()=>Readable.from([text])});
  assert.equal(parsed.contests[0].choices[0].votes,10);assert.equal(parsed.duplicateRows,1);assert.equal(parsed.excludedModeRows,1);
});

test('MEDSL 2020 House keeps specials distinct and avoids mode, fusion and duplicate double counting',async()=>{
  const header='precinct,office,party_detailed,party_simplified,mode,votes,county_name,county_fips,jurisdiction_name,jurisdiction_fips,candidate,district,dataverse,year,stage,state,special,writein,state_po,state_fips,state_cen,state_ic,date,readme_check,magnitude';
  const row='P1,US HOUSE,DEMOCRAT,DEMOCRAT,TOTAL,10,Kent,10001,Kent,10001,Import Test Candidate,0,HOUSE,2020,GEN,DELAWARE,FALSE,FALSE,DE,10,51,11,2020-11-03,TRUE,1';
  const special=row.replace(',FALSE,FALSE,DE',',TRUE,FALSE,DE').replace('2020-11-03','2020-05-12');
  const text=[header,row,row,row.replace('TOTAL,10','MAIL,4'),row.replace(',DEMOCRAT,DEMOCRAT,TOTAL,10',',WORKING FAMILIES,DEMOCRAT,TOTAL,2'),special].join('\n');
  const archive={csvStream:()=>Readable.from([text])};
  const parsed=await readHouseResults(archive);
  assert.equal(parsed.states[0].contests.length,2);assert.equal(parsed.duplicateRows,1);assert.equal(parsed.excludedModeRows,1);
  assert.equal(parsed.states[0].contests.find(c=>!c.special).choices[0].votes,12);
  const client=await db.connect();
  try {
    await client.query('BEGIN');
    const checksum=sha(randomUUID());const job={id:randomUUID(),filename:'house.csv',sha256:checksum,byte_size:text.length,created_at:new Date()};
    const plan={adapter:'medsl-house-2020-v1',source:'medsl',rowsRead:parsed.rowsRead,parsed,archive:{resolvedPath:'test-house.csv',sha256:checksum,byteSize:text.length,retrievedAt:new Date().toISOString(),contentType:'text/csv'},warnings:[]};
    const report=await executePlan(client,job,plan,randomUUID());assert.equal(report.contests,2);
    assert.ok((await client.query("SELECT id FROM election_events WHERE cycle=2020 AND stage='special' AND end_date='2020-05-12'")).rows.length);
    await client.query('ROLLBACK');
  }finally{await client.query('ROLLBACK');client.release();}
  await assert.rejects(readHouseResults({csvStream:()=>Readable.from([text.replaceAll(',GEN,',',PRI,')])}),/scope/);
});

test('NYT names never substitute for missing candidate IDs, and published averages remain separate',async()=>{
  const raw=parseCsv(await readFile('polling/senate.csv','utf8'));raw.rows=[{...raw.rows[0],candidate_id:''}];
  assert.throws(()=>parseNyt(raw),/candidate_id/);
  const plan=await sample('president-averages.csv');plan.averages=plan.averages.slice(0,2);
  const testSeries=randomUUID();plan.averages.forEach(a=>{a.series+=':test:'+testSeries;});
  const client=await db.connect();const checksum=sha(randomUUID());
  try {
    await client.query('BEGIN');
    const job={id:randomUUID(),filename:'renamed.csv',sha256:checksum,byte_size:100,created_at:new Date()};
    const report=await executePlan(client,job,plan,randomUUID());assert.equal(report.newAverages,2);
    const repeated=await executePlan(client,job,plan,randomUUID());assert.equal(repeated.alreadyImported,true);
    assert.equal((await client.query('SELECT id FROM polls WHERE source_artifact_id=(SELECT id FROM source_artifacts WHERE sha256=$1)',[checksum])).rows.length,0);
    await client.query('ROLLBACK');
  }finally{await client.query('ROLLBACK');client.release();}
});

test('MEDSL special results use a special event and corrections append snapshots',async()=>{
  const header='precinct,office,party_detailed,party_simplified,mode,votes,county_name,county_fips,jurisdiction_name,jurisdiction_fips,candidate,district,dataverse,year,stage,state,special,writein,state_po,state_fips,date,magnitude';
  const row='P1,US SENATE,DEMOCRAT,DEMOCRAT,TOTAL,10,Kent,10001,Kent,10001,Import Special Test,,SENATE,2024,GEN,DELAWARE,TRUE,FALSE,DE,10,2024-11-05,1';
  const client=await db.connect();
  try {
    await client.query('BEGIN');
    const batches=[];
    for(const votes of [10,11]) {
      const text=[header,row.replace('TOTAL,10',`TOTAL,${votes}`)].join('\n');
      const state=await readStateResults({csvPath:'special.csv',csvStream:()=>Readable.from([text])});
      const checksum=sha(randomUUID());
      const job={id:randomUUID(),filename:'special.csv',sha256:checksum,byte_size:text.length,created_at:new Date()};
      const archive={resolvedPath:'special.csv',filename:'special.csv',csvPath:'special.csv',sha256:checksum,byteSize:text.length,retrievedAt:new Date().toISOString(),contentType:'text/csv',adminImport:true};
      const report=await executePlan(client,job,{adapter:'medsl-2024-v1',source:'medsl',rowsRead:1,items:[{state,archive}],warnings:[]},randomUUID());
      batches.push(report.states[0].batchId);
    }
    const rows=(await client.query(`SELECT e.stage,v.votes FROM result_snapshots s JOIN contests c ON c.id=s.contest_id JOIN election_events e ON e.id=c.election_id JOIN vote_totals v ON v.snapshot_id=s.id AND v.reporting_unit_id=c.district_geography_id WHERE s.batch_id=ANY($1::uuid[]) ORDER BY v.votes`,[batches])).rows;
    assert.deepEqual(rows,[{stage:'special',votes:'10'},{stage:'special',votes:'11'}]);
    await client.query('ROLLBACK');
  }finally{await client.query('ROLLBACK');client.release();}
});

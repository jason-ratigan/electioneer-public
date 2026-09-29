import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import pg from 'pg';
const config=JSON.parse(await fs.readFile('.tmp/import-test-config.json','utf8'));
if(!config.databaseName.startsWith('signal_import_check_')) throw new Error('Refusing to publish test data outside disposable database');
const base=`http://localhost:${config.port}`;
const headers={Authorization:`Bearer ${config.token}`};
async function api(route,options={}) {
  const response=await fetch(base+route,{...options,headers:{...headers,...options.headers}});const body=await response.json();
  if(!response.ok) throw new Error(`${response.status} ${body.error}`);return body.data;
}
async function settle(id) {
  for(let i=0;i<240;i++) {const j=await api('/api/admin/imports/'+id);if(['ready','completed','failed'].includes(j.status)) return j;await new Promise(r=>setTimeout(r,500));}
  throw new Error('Import did not settle');
}
async function upload(path,name) {return api('/api/admin/imports?'+new URLSearchParams({filename:name||path.split('/').at(-1)}),{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:await fs.readFile(path)});}
const pool=new pg.Pool({connectionString:config.databaseUrl});
try {
  assert.equal((await fetch(base+'/api/admin/imports')).status,401);
  assert.equal((await fetch(base+'/api/refresh',{method:'POST'})).status,401);
  assert.equal((await fetch(base+'/api/ingest-runs')).status,401);
  for(const file of ['senate.csv','house.csv','governor.csv','president polls 2028.csv','president approval.csv','president-averages.csv']) {
    const before=Number((await pool.query('SELECT count(*) FROM poll_questions')).rows[0].count);
    const job=await upload('polling/'+file,'renamed-'+file);const preview=await settle(job.id);
    assert.equal(preview.status,'ready',preview.message);
    assert.equal(Number((await pool.query('SELECT count(*) FROM poll_questions')).rows[0].count),before,'Preview must not publish');
    assert.equal((await fetch(base+`/api/admin/imports/${job.id}/commit`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{"confirmation":"wrong"}'})).status,409);
    await api(`/api/admin/imports/${job.id}/commit`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirmation:preview.confirmation})});
    const committed=await settle(job.id);assert.equal(committed.status,'completed',committed.message);
    console.log(file,'published',JSON.stringify({questions:committed.report.newQuestions,averages:committed.report.newAverages}));
  }
  const initial=(await pool.query('SELECT (SELECT count(*) FROM polls)::int surveys,(SELECT count(*) FROM poll_questions)::int questions,(SELECT count(*) FROM poll_responses)::int responses,(SELECT count(*) FROM published_poll_averages)::int averages')).rows[0];
  console.log('Totals',initial);assert.equal(initial.questions,5311);assert.equal(initial.responses,22567);assert.equal(initial.averages,1204);
  const repeated=await settle((await upload('polling/senate.csv','same-data-new-name.csv')).id);assert.equal(repeated.status,'ready',repeated.message);assert.equal(repeated.preview.changes.alreadyImported,true);
  await api(`/api/admin/imports/${repeated.id}/commit`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirmation:repeated.confirmation})});
  assert.equal((await settle(repeated.id)).report.alreadyImported,true);
  const polls=await api('/api/polls?state=US&kind=generic_ballot');assert.ok(polls.total>0);assert.ok(polls.rows[0].responses.length>0);
  assert.equal((await api('/api/poll-averages?limit=2000')).rows.length,1204);
  const results=await settle((await upload('2024_results/ar24.zip','misleading-state.zip')).id);assert.equal(results.status,'ready',results.message);assert.deepEqual(results.preview.geographies,['AK']);
  await api(`/api/admin/imports/${results.id}/commit`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirmation:results.confirmation})});
  const resultCommit=await settle(results.id);assert.equal(resultCommit.status,'completed',resultCommit.message);
  const hub=await api('/api/hub/overview?office=president&cycle=2024&stage=general');assert.ok(hub.some(c=>c.state.abbreviation==='AK'));
  const reconciled=await settle((await upload('.tmp/medsl-reconciliation.zip')).id);
  assert.equal(reconciled.status,'ready',reconciled.message);assert.ok(reconciled.preview.changes.reconciliation.stateTotalsReconciled>0);
  await api(`/api/admin/imports/${reconciled.id}/commit`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirmation:reconciled.confirmation})});
  assert.equal((await settle(reconciled.id)).status,'completed');
  const correctedHub=await api('/api/hub/overview?office=president&cycle=2024&stage=general');
  assert.equal(correctedHub.find(c=>c.state.abbreviation==='AK').totalVotes,338177);
  assert.ok(Number((await pool.query('SELECT count(*) FROM result_snapshots')).rows[0].count)>hub.length,'Historical result snapshots retained');
  const rejected=await settle((await upload('2024_results/2024-president-state.csv','unsupported.csv')).id);assert.equal(rejected.status,'failed');
  console.log('PASS: authenticated upload, asynchronous preview, explicit confirm, publication, retry idempotency, public polling and hub results, summary reconciliation and retained revisions, unsupported-file rejection');
}finally{await pool.end();}

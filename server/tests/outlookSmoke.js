// Read-only integration verification against a running development API.
import assert from 'node:assert/strict';
import {mappedSeat,pollingLead} from '../outlook/model.js';
const base=process.env.TEST_API_URL||'http://127.0.0.1:3000';
async function get(url){const r=await fetch(base+url,{signal:AbortSignal.timeout(30000)});assert.equal(r.status,200);return (await r.json()).data;}
for(const office of ['us_senate','governor','us_house']) {
  const data=await get(`/api/hub/outlook?office=${office}&cycle=2026`);
  const rows=data.polls.filter(q=>q.kind==='election'&&q.office===office&&q.stage==='general');
  assert.ok(rows.length>0,'Import the supplied polls before running this integration check');
  assert.ok(rows.every(q=>mappedSeat(q,data.districts)),`${office}: unresolved general-election geography`);
  assert.ok(data.polls.filter(q=>['generic_ballot','approval'].includes(q.kind)).every(q=>q.state==='US'));
  const bySeat=new Map();for(const q of rows){const key=mappedSeat(q,data.districts);if(!bySeat.has(key))bySeat.set(key,[]);bySeat.get(key).push(q);}
  for(const qs of bySeat.values())assert.equal(new Set(qs.map(q=>q.race_id)).size,1,'Ambiguous source races require review');
  if(office==='us_house'){
    assert.equal(data.districts.filter(d=>d.state_fips!=='11').length,435);
    const geo=await get('/api/hub/districts?cycle=2026&stage=general');
    assert.equal(geo.features.filter(f=>f.properties.stateFips!=='11').length,435);
    for(const q of rows)assert.ok(geo.features.some(f=>`${f.properties.stateAbbreviation}-${f.properties.districtCode}`===mappedSeat(q,data.districts)));
  }
  console.log(`${office}: ${rows.length} general questions mapped to ${bySeat.size} seats; ${[...bySeat.values()].filter(qs=>pollingLead(qs,'2026-09-28').count).length} recent averages`);
}
assert.equal((await fetch(base+'/api/hub/outlook?office=invalid&cycle=2026')).status,400);
assert.equal((await fetch(base+'/api/hub/outlook?office=us_house&cycle=invalid')).status,400);
console.log('Outlook API and 2026 mapping checks passed.');

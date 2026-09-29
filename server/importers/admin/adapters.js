import { createReadStream } from 'node:fs';
import { readFile,stat,writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { parseCsv } from './csv.js';
import { parseNyt,sha } from './nyt.js';
import { expandUpload,hashFile,privatePath } from './storage.js';
import { readStateResults } from '../medsl2024/readState.js';
import { readHouseResults,parseCsvLine } from '../medsl2020/readHouse.js';
import { openVestArchive,openStateFromVestArchive } from '../vest2020/archive.js';
import { parseVestDocumentation } from '../vest2020/documentation.js';
import { readVestState } from '../vest2020/readState.js';
import { vestStates } from '../vest2020/states.js';
import { readSummaryFile,applyResultSummaries } from '../medsl2024/summaries.js';

export async function parseUpload(job,progress=async()=>{}) {
  const members=await expandUpload(job.id,job.filename);
  // VEST's documented state archive layout is a format requirement, not entity identity.
  if(members.some(m=>m.name.toLowerCase().endsWith('.shp'))) {
    const outer=await openVestArchive(privatePath(job.id));
    const documentation=parseVestDocumentation(outer.documentation);
    const states=vestStates.filter(s=>outer.directory.files.some(e=>e.path===s.archiveName));
    if(!states.length) throw new Error('Unsupported VEST layout. Upload dataverse_files.zip (doi:10.7910/DVN/K7760H), including documentation.txt and standard 2020 state ZIPs.');
    const items=[];
    for(const state of states) {
      const archive=await openStateFromVestArchive(outer,state);
      const labels=documentation.labels.get(state.code);
      if(!labels) throw new Error(`VEST documentation missing for ${state.name}`);
      const parsed=await readVestState(archive,state,labels);
      items.push({state,archive,parsed});await progress(`Validated VEST ${state.abbreviation}`);
    }
    delete outer.directory;
    return {adapter:'vest-2020-v1',source:'vest',items,outer,questions:[],averages:[],rowsRead:items.reduce((n,i)=>n+i.parsed.precincts.length,0),warnings:['VEST precinct values are allocated research data. General election 2020 only; supplemental VTD archives are not imported.'],skippedFiles:members.filter(m=>!(/\.(shp|dbf|prj|cpg|shx|txt)$/i.test(m.name))).map(m=>m.name)};
  }
  const csvs=members.filter(m=>m.name.toLowerCase().endsWith('.csv'));
  if(!csvs.length) throw new Error('No supported CSV data found. Expected NYT polling CSVs, MEDSL precinct CSVs, or the documented VEST 2020 Dataverse archive.');
  const parts=[],summaries=[];
  for(const [index,member] of csvs.entries()) {
    await progress(`Identifying file ${index+1} of ${csvs.length}: ${member.name}`);
    const reader=createInterface({input:createReadStream(member.file),crlfDelay:Infinity});
    let header; for await(const line of reader) {header=parseCsvLine(line.replace(/^\uFEFF/,''));break;}
    if(header?.includes('poll_id') || header?.includes('topic')) {
      const parsed=parseNyt(parseCsv(await readFile(member.file,'utf8')));
      if(!parsed) throw new Error(`Unsupported polling CSV: ${member.name}`);
      parts.push(parsed);continue;
    }
    if(!header?.includes('precinct') && header?.includes('state_po') && header.includes('votes') && header.includes('candidate')) {
      const raw=parseCsv(await readFile(member.file,'utf8'));
      if(raw.rows.some(r=>r.year!=='2024'||r.stage!=='GEN')) throw new Error(`Unsupported MEDSL summary scope in ${member.name}; expected 2024 GEN.`);
      const signatures=new Set();
      for(const row of raw.rows) {const signature=JSON.stringify(row);if(signatures.has(signature)) throw new Error(`Duplicate summary row in ${member.name}; reconcile the source before importing.`);signatures.add(signature);}
      summaries.push({filename:member.name,...await readSummaryFile(member.file),file:member.file,sha256:await hashFile(member.file),byteSize:(await stat(member.file)).size});
      continue;
    }
    if(!header?.includes('precinct') || !header.includes('state_po') || !header.includes('votes')) throw new Error(`Unsupported CSV ${member.name}. Expected NYT polling or a documented MEDSL precinct/summary schema. Upload the state precinct ZIP from https://github.com/MEDSL/2024-elections-official/tree/main/individual_states. No source will be guessed from this filename.`);
    const scan=createInterface({input:createReadStream(member.file),crlfDelay:Infinity});let first=true;const years=new Set(),stages=new Set();
    for await(const line of scan) {
      if(first){first=false;continue;} if(!line) continue;
      const values=parseCsvLine(line);
      if(values.length!==header.length) throw new Error(`Malformed MEDSL CSV ${member.name}`);
      years.add(values[header.indexOf('year')]);stages.add(values[header.indexOf('stage')]);
    }
    if(years.size!==1 || stages.size!==1 || !stages.has('GEN')) throw new Error(`MEDSL scope ${[...years].join(', ')} / ${[...stages].join(', ')} is unsupported by these adapters. Supply the exact repository URL and codebook for primary/runoff or other-year data; no stage will be guessed.`);
    const archive={resolvedPath:member.file,filename:member.name,csvPath:member.name,sha256:await hashFile(member.file),byteSize:(await stat(member.file)).size,retrievedAt:job.created_at.toISOString(),contentType:'text/csv',adminImport:true,csvStream:()=>createReadStream(member.file)};
    let part;
    if(years.has('2024')) {
      const state=await readStateResults(archive);
      part={adapter:'medsl-2024-v1',source:'medsl',items:[{archive:{...archive,csvStream:undefined},state}],questions:[],averages:[],rowsRead:state.rowsRead,warnings:['2024 general-election precinct research returns. State upload may be incomplete; no certified companion-summary reconciliation has been applied.','MEDSL notes: Louisiana precinct returns omit parish early votes; Indiana Senate/Governor may overreport straight-ticket votes. Review the source state notes.']};
    } else if(years.has('2020')) {
      const parsed=await readHouseResults(archive);
      part={adapter:'medsl-house-2020-v1',source:'medsl',archive:{...archive,csvStream:undefined},parsed,questions:[],averages:[],rowsRead:parsed.rowsRead,warnings:['2020 U.S. House general-election precinct returns only. Suppressed negative values are omitted and audited.']};
    } else throw new Error(`No validated MEDSL adapter for year ${[...years][0]}. Supply its repository URL and codebook.`);
    parts.push(part);
  }
  if(!parts.length && summaries.length) throw new Error('These are MEDSL companion summaries. Put them in a ZIP with the corresponding 2024 state precinct ZIPs so each summary can be reconciled to its source contests. Standalone summaries are not precinct data.');
  if(new Set(parts.map(p=>p.source)).size!==1 || (summaries.length && parts.some(p=>p.adapter!=='medsl-2024-v1'))) throw new Error('Upload NYT and MEDSL data separately so source attribution is unambiguous.');
  if(parts.every(p=>p.source==='nyt-polls')) {
    const questions=new Map(),averages=new Map();
    for(const p of parts) {
      for(const q of p.questions) {if(questions.has(q.key) && questions.get(q.key).hash!==q.hash) throw new Error(`Conflicting question across files: ${q.key}`);questions.set(q.key,q);}
      for(const a of p.averages) {const key=`${a.series}:${a.date}:${a.answer}`;if(averages.has(key)&&averages.get(key).share!==a.share) throw new Error(`Conflicting average: ${key}`);averages.set(key,a);}
    }
    return {adapter:'nyt-v1',source:'nyt-polls',questions:[...questions.values()],averages:[...averages.values()],rowsRead:parts.reduce((n,p)=>n+p.rowsRead,0),warnings:[...new Set(parts.flatMap(p=>p.warnings))],duplicateRows:parts.reduce((n,p)=>n+(p.duplicateRows||0),0),skippedFiles:members.filter(m=>!m.name.endsWith('.csv')).map(m=>m.name)};
  }
  if(new Set(parts.map(p=>p.adapter)).size!==1) throw new Error('Upload different MEDSL formats separately.');
  if(parts[0].adapter==='medsl-house-2020-v1' && parts.length!==1) throw new Error('Upload one MEDSL 2020 House file at a time.');
  const plan=parts.length===1?parts[0]:{...parts[0],items:parts.flatMap(p=>p.items),rowsRead:parts.reduce((n,p)=>n+p.rowsRead,0)};
  if(plan.items && new Set(plan.items.map(i=>i.state.abbreviation)).size!==plan.items.length) throw new Error('Multiple precinct files for the same state are ambiguous; upload one authoritative state file.');
  if(summaries.length) {
    if(new Set(summaries.map(s=>s.classification)).size!==summaries.length) throw new Error('Multiple summaries of the same scope are ambiguous; choose one authoritative file per scope.');
    // The legacy reconciler totals Senate county summaries. Require full county coverage first.
    for(const item of plan.items) for(const contest of item.state.contests.filter(c=>c.officeSlug==='us_senate')) {
      const entries=summaries.flatMap(s=>s.entries).filter(e=>e.state===item.state.abbreviation&&e.officeSlug==='us_senate'&&e.special===contest.special&&e.countyFips);
      if(entries.length) {
        const counties=new Set(entries.map(e=>e.countyFips));
        if(contest.counties.some(c=>!counties.has(c.fips))) throw new Error(`Partial Senate county summary for ${item.state.abbreviation}; every precinct-source county must be represented before reconciliation.`);
      }
    }
    plan.reconciliation=applyResultSummaries(plan.items,{summaries,rejected:[]});
    plan.summaries=summaries;
    plan.rowsRead+=summaries.reduce((n,s)=>n+s.rowsRead,0);
    // Summary corrections change the effective artifact identity even if precinct bytes did not change.
    for(const item of plan.items) {
      const manifest=JSON.stringify({kind:'MEDSL reconciliation manifest',adapter:plan.adapter,state:item.state.abbreviation,precinct:{sha256:item.archive.sha256,name:item.archive.csvPath},summaries:summaries.map(s=>({name:s.filename,sha256:s.sha256})).sort((a,b)=>a.sha256.localeCompare(b.sha256))});
      const file=privatePath(job.id,`result-manifest-${item.state.abbreviation.toLowerCase()}.json`);
      await writeFile(file,manifest,{mode:0o600});
      item.archive={...item.archive,resolvedPath:file,filename:'Reconciliation manifest',sha256:sha(manifest),byteSize:Buffer.byteLength(manifest),contentType:'application/json'};
    }
    plan.warnings=plan.warnings.filter(w=>!w.includes('no certified companion-summary'));
    plan.warnings.push(`MEDSL companion reconciliation: ${plan.reconciliation.stateTotalsReconciled} statewide and ${plan.reconciliation.countyTotalsReconciled} county observations; ${plan.reconciliation.unmatchedEntries} summary entries outside the uploaded contests skipped. Raw files remain preserved.`);
  }
  plan.skippedFiles=members.filter(m=>!m.name.endsWith('.csv')).map(m=>m.name);
  return plan;
}

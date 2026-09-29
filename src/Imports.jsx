import React,{useEffect,useState} from 'react';

async function json(url,options={}) {
  const response=await fetch(url,options);
  const raw=await response.text();
  let body=null;
  if(raw) {
    try { body=JSON.parse(raw); }
    catch { throw new Error(`Invalid JSON from ${url} (HTTP ${response.status}).`); }
  }
  if(!response.ok) throw new Error(body?.error||`Request to ${url} failed (HTTP ${response.status}).`);
  if(!body||!Object.hasOwn(body,'data')) throw new Error(`Empty response from ${url} (HTTP ${response.status}).`);
  return body.data;
}
export function AdminImports({onPublished}) {
  const [token,setToken]=useState(''),[authenticated,setAuthenticated]=useState(false),[error,setError]=useState(''),[jobs,setJobs]=useState([]),[selected,setSelected]=useState(null),[uploading,setUploading]=useState(false),[checked,setChecked]=useState(false),[sourceUrl,setSourceUrl]=useState(''),[license,setLicense]=useState('');
  const auth={Authorization:`Bearer ${token}`};
  async function refresh() {const data=await json('/api/admin/imports',{headers:auth});setJobs(data);setSelected(current=>current?data.find(j=>j.id===current.id)||current:null);setError('');}
  useEffect(()=>{
    if(!authenticated) return;
    let active=true;
    const update=()=>refresh().catch(e=>{if(active)setError(e.message);});
    update();const timer=setInterval(update,2000);
    return()=>{active=false;clearInterval(timer);};
  },[authenticated,token]);
  useEffect(()=>{setChecked(false);if(selected?.status==='completed') onPublished?.();},[selected?.id,selected?.status]);
  async function login(e) {e.preventDefault();try{await json('/api/admin/session',{headers:auth});setAuthenticated(true);setError('');}catch(e){setError(e.message);}}
  async function upload(files) {
    if(uploading)return;setUploading(true);setError('');
    try {
      for(const file of files) {
        if(!/\.(csv|zip)$/i.test(file.name)) throw new Error(`${file.name}: choose a CSV or ZIP file.`);
        const query=new URLSearchParams({filename:file.name,sourceUrl,license});
        const job=await json(`/api/admin/imports?${query}`,{method:'POST',headers:{...auth,'Content-Type':'application/octet-stream'},body:file});
        setSelected(job);
      }
      await refresh();
    }catch(e){setError(e.message);}finally{setUploading(false);}
  }
  async function action(kind) {
    try {setError('');const job=await json(`/api/admin/imports/${selected.id}/${kind}`,{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify({confirmation:selected.confirmation})});setSelected(job);await refresh();}
    catch(e){setError(e.message);}
  }
  const p=selected?.preview;
  return <section className="import-page">
    <span className="section-label">ADMINISTRATION</span><h1>Import source data</h1>
    <p>Upload a source download, review its mapping and changes, then confirm publication.</p>
    {error&&<p role="alert" className="import-error">{error}</p>}
    {!authenticated?<form className="import-panel" onSubmit={login}><h2>Administrator access</h2><label>Admin token<input type="password" autoComplete="off" value={token} onChange={e=>setToken(e.target.value)} required/></label><p>Use the secret configured as ADMIN_IMPORT_TOKEN on your server. It stays in memory for this page session.</p><button className="primary-button">Unlock imports</button></form>:<>
      <button className="back-button" onClick={()=>{setAuthenticated(false);setToken('');setJobs([]);setSelected(null);}}>Lock admin</button>
      <div className="import-panel">
        <div className="import-fields"><label>Original source URL (optional)<input type="url" placeholder="https://…" value={sourceUrl} onChange={e=>setSourceUrl(e.target.value)}/></label><label>Dataset license override (optional)<input placeholder="Use only if specified by this download" value={license} onChange={e=>setLicense(e.target.value)}/></label></div>
        <label className={`upload-zone ${uploading?'busy':''}`} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();void upload([...e.dataTransfer.files]);}}>
          <strong>{uploading?'Uploading…':'Drop CSV or ZIP files here'}</strong><span>NYT polls and approval averages · MEDSL 2020 House / 2024 precinct returns · VEST 2020</span>
          <input type="file" multiple accept=".csv,.zip" disabled={uploading} onChange={e=>{void upload([...e.target.files]);e.target.value='';}}/>
          <small>Default limit: 512 MiB per file. ZIPs are checked before parsing. Separate files create separate reviewable imports.</small>
        </label>
      </div>
      <div className="import-columns">
        <section className="import-panel import-history"><h2>Import history</h2>{!jobs.length&&<p>No imports yet.</p>}{jobs.map(job=><button className={selected?.id===job.id?'selected':''} onClick={()=>setSelected(job)} key={job.id}><strong>{job.filename}</strong><span>{job.status} · {job.phase}</span><small>{new Date(job.created_at).toLocaleString()}</small></button>)}</section>
        <section className="import-panel import-detail" aria-live="polite">
          {!selected?<p>Select an import to review its preview and audit report.</p>:<><h2>{selected.filename}</h2><p><strong>{selected.status}</strong> · {selected.message}</p>
            {['queued','validating','committing'].includes(selected.status)&&<progress aria-label="Import progress"/>}
            <details><summary>Artifact and audit identity</summary><p>SHA-256: <code>{selected.sha256}</code></p><p>{Number(selected.byte_size).toLocaleString()} bytes · import {selected.id}</p>{selected.ingestion_run_id&&<p>Run {selected.ingestion_run_id}</p>}</details>
            {p&&<><h3>Proposed mapping</h3><dl className="preview-grid"><dt>Source / adapter</dt><dd>{p.source} / {p.adapter}</dd><dt>Cycles</dt><dd>{p.cycles.join(', ')||'Approval time series'}</dd><dt>Offices</dt><dd>{p.offices.join(', ')||'Presidential approval'}</dd><dt>Stages</dt><dd>{p.stages.join(', ')||'Not an election contest'}</dd><dt>Geography</dt><dd>{p.geographies.join(', ')||'National'}</dd><dt>Source rows</dt><dd>{p.rows.toLocaleString()}</dd><dt>Surveys / questions / races</dt><dd>{p.surveys} / {p.questions} / {p.contests}</dd><dt>Published averages</dt><dd>{p.averages}</dd><dt>Skipped rows</dt><dd>{p.skippedRows}</dd><dt>License</dt><dd>{p.license}</dd></dl>
              {p.sourceUrl&&<p><a href={p.sourceUrl} target="_blank" rel="noreferrer">Source documentation</a></p>}
              <h3>Changes after validation</h3><div className="preview-counts">{Object.entries(p.newRecords).map(([name,count])=><span key={name}><b>{count.toLocaleString()}</b> new {name}</span>)}</div>
              <p>{p.changes.unchangedQuestions||0} unchanged questions · {p.changes.revisedQuestions||0} revised questions · {p.changes.existingSurveys||0} existing surveys</p>
              {p.changes.alreadyImported&&<p>This exact artifact is already published. Confirmation will record a no-op.</p>}
              <h3>Warnings and mapping review</h3><ul>{p.warnings.map((w,i)=><li key={i}>{w}</li>)}</ul>
              {!!p.changes.unlinkedRaces?.length&&<p>{p.changes.unlinkedRaces.length} source races have no unique official contest match. Their polls remain available by source race, state, office, cycle and stage. No ballot choices will be created.</p>}
              <details><summary>Full mapping and row audit</summary><pre>{JSON.stringify({changes:p.changes,sourceCounters:p.sourceCounters,skippedFiles:p.skippedFiles},null,2)}</pre></details>
            </>}
            {selected.status==='ready'&&<div className="confirm-import"><label><input type="checkbox" checked={checked} onChange={e=>setChecked(e.target.checked)}/> I reviewed the source, mapping and warnings. Publish these observations.</label><button className="primary-button" disabled={!checked} onClick={()=>action('commit')}>Confirm import</button></div>}
            {selected.status==='failed'&&<button className="primary-button" onClick={()=>action('retry')}>Retry {selected.phase}</button>}
            {selected.report&&<><h3>Final audit report</h3><p>Publication completed in one transaction. Earlier observations are retained.</p><pre>{JSON.stringify(selected.report,null,2)}</pre></>}
          </>}
        </section>
      </div>
    </>}
  </section>;
}

const safeUrl=value=>typeof value==='string'&&/^https?:\/\//i.test(value)?value:null;
export function PollsView({initialState='',initialOffice='',initialCycle='',initialStage='',compact=false}) {
  const [filters,setFilters]=useState({state:initialState,office:initialOffice,cycle:String(initialCycle),stage:initialStage,kind:''});
  const [tab,setTab]=useState('polls'),[offset,setOffset]=useState(0),[data,setData]=useState(null),[facets,setFacets]=useState([]),[error,setError]=useState(''),[loading,setLoading]=useState(true);
  useEffect(()=>{json('/api/polls/facets').then(setFacets).catch(e=>setError(e.message));},[]);
  useEffect(()=>{setFilters({state:initialState,office:initialOffice,cycle:String(initialCycle),stage:initialStage,kind:''});setOffset(0);},[initialState,initialOffice,initialCycle,initialStage]);
  useEffect(()=>{
    const controller=new AbortController();setLoading(true);setError('');
    const query=new URLSearchParams({...Object.fromEntries(Object.entries(filters).filter(([,v])=>v)),offset,limit:compact?5:30});
    json(tab==='averages'?`/api/poll-averages?limit=60&offset=${offset}`:`/api/polls?${query}`,{signal:controller.signal}).then(setData).catch(e=>{if(e.name!=='AbortError')setError(e.message);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[JSON.stringify(filters),offset,tab,compact]);
  const options=(field)=>[...new Set(facets.map(f=>f[field]).filter(v=>v!==null).map(String))].sort();
  return <section className={`polls-page ${compact?'compact-polls':''}`}>
    <span className="section-label">{tab==='averages'?'PUBLISHED SERIES':'RAW POLLING'}</span><h1>{compact?'Polling in this state':'Polls'}</h1>
    <p>Polling data compiled by <a href="https://www.nytimes.com/interactive/polls/" target="_blank" rel="noreferrer">The New York Times</a> · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a>, unless otherwise noted. Published percentages are unchanged; records are mapped for display.</p>
    {!compact&&<div className="level-toggle"><button className={tab==='polls'?'active':''} onClick={()=>{setTab('polls');setOffset(0);}}>Individual polls</button><button className={tab==='averages'?'active':''} onClick={()=>{setTab('averages');setOffset(0);}}>NYT approval averages</button></div>}
    <p className="poll-distinction">{tab==='averages'?'These are the Times’ published approval averages, not individual surveys or Signal model estimates.':'These are survey responses, not official results, ballot qualification, or forecasts. Questions from the same survey are shown separately.'}</p>
    {tab==='polls'&&<div className="poll-filters">{[['state','State','state'],['office','Office','office_slug'],['cycle','Cycle','cycle'],['stage','Stage','stage'],['kind','Question type','question_kind']].map(([key,label,field])=><label key={key}>{label}<select value={filters[key]} onChange={e=>{setFilters({...filters,[key]:e.target.value});setOffset(0);}}><option value="">All</option>{[...new Set([...options(field),filters[key]].filter(Boolean))].map(value=><option key={value} value={value}>{String(value).replaceAll('_',' ')}</option>)}</select></label>)}</div>}
    {error&&<p role="alert" className="import-error">{error}</p>}
    {loading?<p>Loading polling observations…</p>:tab==='averages'?<div className="import-panel"><h2>Presidential approval · NYT published series</h2>{!data?.rows?.length?<p>No published averages have been imported.</p>:<table className="averages-table"><thead><tr><th>Date</th><th>Response</th><th>Published share</th><th>Source / license</th></tr></thead><tbody>{data.rows.map(r=><tr key={r.id}><td>{r.observed_on}</td><td>{r.response_label}</td><td>{Number(r.share)}%</td><td>{r.source} · {r.license}</td></tr>)}</tbody></table>}<div className="poll-pagination"><button disabled={!offset} onClick={()=>setOffset(Math.max(0,offset-60))}>Newer dates</button><span>{data?.total?offset+1:0}–{offset+(data?.rows?.length||0)} of {data?.total||0}</span><button disabled={offset+(data?.rows?.length||0)>=(data?.total||0)} onClick={()=>setOffset(offset+60)}>Older dates</button></div></div>:<>
      <p>{data?.total||0} matching questions</p>
      {!data?.rows?.length&&<div className="import-panel">No matching polls have been imported. Adjust the filters or upload source files in Admin imports.</div>}
      {data?.rows?.map(q=><article className="poll-card" key={q.id}>
        <div className="poll-card-head"><div><span className="section-label">{q.question_kind.replaceAll('_',' ')} · {q.cycle||'Approval'} · {q.stage||'Public opinion'}</span><h2>{q.pollster}</h2><p>{q.geography} · {q.office_slug.replaceAll('_',' ')} {q.metadata.seat_number?`· District ${q.metadata.seat_number}`:''}</p></div><div><strong>{q.field_start} – {q.field_end}</strong><p>n = {q.sample_size?.toLocaleString()||'not published'} · {q.population.replaceAll('_',' ')}</p></div></div>
        <div className="poll-shares">{q.responses?.map((r,i)=><div key={i}><span>{r.candidate&&r.candidate!==r.label?`${r.candidate} (${r.label})`:r.label}</span><strong>{Number(r.share)}%</strong></div>)}</div>
        <p>{q.metadata.methodology||'Method not supplied'}{q.metadata.hypothetical==='TRUE'?' · Hypothetical matchup':''}{q.metadata.ranked_choice_round?` · Ranked-choice round ${q.metadata.ranked_choice_round}`:''}{q.metadata.subpopulation?` · ${q.metadata.subpopulation}`:''}</p>
        <footer>{safeUrl(q.metadata.url)&&<a href={q.metadata.url} target="_blank" rel="noreferrer">Poll source</a>} {['url_article','url_topline','url_crosstab'].filter(k=>safeUrl(q.metadata[k])).map(k=><a key={k} href={q.metadata[k]} target="_blank" rel="noreferrer">{k.replace('url_','')}</a>)}<span>Via {q.source} · {q.license}</span>{q.revision_of_question_id&&<span>Revised source observation</span>}</footer>
        <details><summary>Question metadata and source identity</summary><pre>{JSON.stringify({survey:q.survey_id,...q.metadata},null,2)}</pre></details>
      </article>)}
      <div className="poll-pagination"><button disabled={!offset} onClick={()=>setOffset(Math.max(0,offset-(compact?5:30)))}>Previous</button><span>{data?.total?offset+1:0}–{offset+(data?.rows?.length||0)} of {data?.total||0}</span><button disabled={offset+(data?.rows?.length||0)>=(data?.total||0)} onClick={()=>setOffset(offset+(compact?5:30))}>Next</button></div>
    </>}
  </section>;
}

import React,{useEffect,useMemo,useState} from 'react';
import {geoAlbersUsa,geoPath} from 'd3-geo';
import {feature} from 'topojson-client';
import topology from 'us-atlas/states-10m.json';
import './explorer.css';
import {PollTable} from './PollTable.jsx';
import {pollColors as colors,mapLegend,mapShade,trendDomain,approvalDomain,responseGroup} from './pollingPresentation.js';
import {category,controlSummary,districtCode,mappedSeat,pollingLead,visiblePolls,MODEL_VERSION} from '../server/outlook/model.js';

const states=feature(topology,topology.objects.states);
const path=geoPath(geoAlbersUsa().fitExtent([[18,18],[962,588]],states));
const officeNames={us_senate:'Senate',governor:'Governor',us_house:'House',president:'President'};
const today=new Date().toISOString().slice(0,10);
const day=86400000;
const iso=n=>new Date(n).toISOString().slice(0,10);
const marginText=n=>n==null?'No usable average':Math.abs(n)<0.05?'Even':`${n>0?'D':'R'} +${Math.abs(n).toFixed(1)}`;
const partyLabel=party=>party==='D'?'Democratic':party==='R'?'Republican':'Independent / other';
const partyGroup=party=>['D','DEM','DEMOCRAT','DEMOCRATIC'].includes(String(party||'').toUpperCase())?'D':['R','REP','REPUBLICAN','GOP'].includes(String(party||'').toUpperCase())?'R':'other';
const callLabel=call=>call?.name||partyLabel(call?.party);
function readCalls() {try {return JSON.parse(window.localStorage.getItem('signal-outlook-calls-v1')||'{}');} catch {return {};}}
function useData(url) {
  const [state,setState]=useState({data:null,loading:true,error:null});
  useEffect(()=>{if(!url){setState({data:null,loading:false,error:null});return;}const c=new AbortController();setState({data:null,loading:true,error:null});fetch(url,{signal:c.signal}).then(async r=>{const b=await r.json();if(!r.ok)throw Error(b.error);return b.data;}).then(data=>setState({data,loading:false,error:null})).catch(e=>{if(e.name!=='AbortError')setState({data:null,loading:false,error:e.message});});return()=>c.abort();},[url]);return state;
}
function readLocation() {
  const p=new URLSearchParams(window.location.hash.split('?')[1]||'');
  return {office:officeNames[p.get('office')]?p.get('office'):'us_senate',cycle:[2025,2026,2027,2028].includes(Number(p.get('year')))?Number(p.get('year')):2026,
    asOf:/^\d{4}-\d{2}-\d{2}$/.test(p.get('date')||'')&&Number.isFinite(Date.parse(p.get('date')))?p.get('date'):today,state:p.get('state')||'',seat:p.get('seat')||'',stage:p.get('stage')||'general'};
}
function Trend({rows,asOf,matchup}) {
  const points=useMemo(()=>Array.from({length:13},(_,i)=>{const date=iso(Date.parse(asOf)-(12-i)*7*day);return {date,margin:pollingLead(rows,date,matchup).margin};}),[rows,asOf,matchup]);
  const values=points.filter(p=>p.margin!=null);
  if(!values.length)return <p className="muted">No comparable polling trend in this period.</p>;
  const [min,max]=trendDomain(values.map(p=>p.margin));
  const y=value=>130-(value-min)/(max-min)*110;
  const ticks=Array.from({length:5},(_,i)=>min+(max-min)*i/4);
  return <div className="trend-panel"><svg className="poll-trend" viewBox="0 0 480 165" role="img" aria-label={`Weekly polling margin; axis from ${marginText(min)} to ${marginText(max)}`}>
    {ticks.map(n=><g key={n}><line x1="55" x2="465" y1={y(n)} y2={y(n)} stroke="#e1e7ef"/><text x="2" y={y(n)+3}>{marginText(n)}</text></g>)}
    {min<=0&&max>=0&&<line x1="55" x2="465" y1={y(0)} y2={y(0)} stroke="#8d9aaf" strokeDasharray="4 4"/>}
    {points.map((p,i)=>p.margin==null?null:<React.Fragment key={p.date}>{i>0&&points[i-1].margin!=null&&<line x1={55+(i-1)*34} x2={55+i*34} y1={y(points[i-1].margin)} y2={y(p.margin)} stroke="#6578a1" strokeWidth="2"/>}<circle cx={55+i*34} cy={y(p.margin)} r="3.5" fill={p.margin>0?colors.D:colors.R}><title>{p.date}: {marginText(p.margin)}</title></circle></React.Fragment>)}
    <text x="55" y="158">{points[0].date}</text><text x="465" y="158" textAnchor="end">{asOf}</text>
  </svg><p className="muted">Polling margin · Axis fits the observations. Same candidate pair; missing weeks stay blank.</p></div>;
}
function ApprovalTrend({rows,asOf}) {
  const start=Date.parse(asOf)-120*day;
  const recent=rows.filter(r=>Date.parse(r.observed_on)>=start&&r.observed_on<=asOf);
  const series=[...new Set(recent.map(r=>r.response_label))];
  if(!recent.length)return <p>No published approval series for this period.</p>;
  const [min,max]=approvalDomain(recent.map(r=>Number(r.share)));
  const y=value=>150-(value-min)/(max-min)*130;
  const ticks=Array.from({length:5},(_,i)=>min+(max-min)*i/4);
  return <div className="trend-panel approval-trend"><svg className="poll-trend" viewBox="0 0 600 180" role="img" aria-label={`NYT published presidential approval averages; ${min}% to ${max}% window`}>
    {ticks.map(n=><g key={n}><line x1="40" x2="585" y1={y(n)} y2={y(n)} stroke="#e1e7ef"/><text x="0" y={y(n)+4}>{Number(n.toFixed(1))}%</text></g>)}
    {series.map(label=>{const points=recent.filter(r=>r.response_label===label).sort((a,b)=>a.observed_on.localeCompare(b.observed_on));return <polyline key={label} fill="none" stroke={colors[responseGroup({label},true)]} strokeWidth="2.5" points={points.map(r=>`${40+(Date.parse(r.observed_on)-start)/(120*day)*545},${y(Number(r.share))}`).join(' ')}><title>{label} · NYT published series</title></polyline>;})}
    <text x="30" y="175">{iso(start)}</text><text x="510" y="175">{asOf}</text>
  </svg><div className="outlook-legend">{series.map(label=><span key={label}><i style={{background:colors[responseGroup({label},true)]}}/>{label}</span>)}</div><p className="muted">{min}–{max}% window · Published approval shares. Colors denote responses, not party affiliation.</p></div>;
}
export function Explorer({revision,onHistory}) {
  const [browserTab,setBrowserTab]=useState('polls');
  const [selection,setSelection]=useState(readLocation),[query,setQuery]=useState(''),[filter,setFilter]=useState('all'),[national,setNational]=useState('approval'),[swing,setSwing]=useState(0),[useBaseline,setUseBaseline]=useState(true),[allCalls,setAllCalls]=useState(readCalls),[matchups,setMatchups]=useState({});
  const {office,cycle,asOf,state,seat,stage}=selection;
  const scenarioKey=`${office}:${cycle}:${stage}`;
  const overrides=allCalls[scenarioKey]||{};
  const setOverrides=updater=>setAllCalls(current=>({...current,[scenarioKey]:typeof updater==='function'?updater(current[scenarioKey]||{}):updater}));
  const change=patch=>setSelection(s=>({...s,...patch}));
  useEffect(()=>{const p=new URLSearchParams({office,year:cycle,date:asOf,stage,...(state?{state}:{}),...(seat?{seat}:{})});window.history.replaceState(null,'',`#explore?${p}`);},[selection]);
  useEffect(()=>{const update=()=>{if(window.location.hash.startsWith('#explore'))setSelection(readLocation());};window.addEventListener('hashchange',update);return()=>window.removeEventListener('hashchange',update);},[]);
  useEffect(()=>{try{window.localStorage.setItem('signal-outlook-calls-v1',JSON.stringify(allCalls));}catch{}},[allCalls]);
  useEffect(()=>{setSwing(0);setMatchups({});},[office,cycle,stage]);
  const resource=useData(`/api/hub/outlook?office=${office}&cycle=${cycle}&revision=${revision}`);
  const geometry=useData(office==='us_house'?`/api/hub/districts?cycle=${cycle}&stage=general&revision=${revision}`:null);
  const data=resource.data;
  const openHistory=({office,state,cycle})=>{const s=data?.states.find(s=>s.state===state);onHistory({office,cycle,state:s?{abbreviation:s.state,name:s.name,fips:s.state_fips}:null});};
  const allPolls=data?.polls||[];
  const electionPolls=useMemo(()=>visiblePolls(allPolls.filter(q=>q.kind==='election'&&q.office===office&&q.state!=='US'&&q.stage===stage),asOf),[data,office,stage,asOf]);
  const races=useMemo(()=>{
    if(!data)return [];
    const bySeat=new Map();
    const add=(key,s,label)=>{if(!bySeat.has(key))bySeat.set(key,{seatKey:key,state:s,label,polls:[],raceIds:new Set()});};
    if(office==='us_house')for(const d of data.districts){if(d.state_fips==='11')continue;const s=d.abbreviation.split('-')[0];add(d.abbreviation,s,d.abbreviation);}
    else if(cycle===2026&&stage==='general'&&data.baseline?.up)for(const s of data.baseline.up)add(s,s,data.states.find(x=>x.state===s)?.name||s);
    for(const q of electionPolls){const key=mappedSeat(q,data.districts);if(!key)continue;add(key,q.state,q.state_name);const r=bySeat.get(key);r.polls.push(q);r.raceIds.add(q.race_id);}
    return [...bySeat.values()].map(r=>({...r,incumbent:data.baseline?.seats?.[r.seatKey]||null,lead:pollingLead(r.raceIds.size>1?[]:r.polls,asOf,matchups[r.seatKey])})).sort((a,b)=>a.label.localeCompare(b.label,undefined,{numeric:true}));
  },[data,electionPolls,office,cycle,asOf,stage,matchups]);
  const selected=races.find(r=>r.seatKey===seat)|| (state?races.find(r=>r.state===state):null);
  const selectedRows=selected?.polls||[];
  const browserRows=useMemo(()=>selected?selected.polls:electionPolls.filter(q=>!state||q.state===state),[selected,electionPolls,state]);
  const nationalRows=useMemo(()=>visiblePolls(allPolls.filter(q=>q.state==='US'&&q.kind===national),asOf),[data,national,asOf]);
  const generic=pollingLead(visiblePolls(allPolls.filter(q=>q.state==='US'&&q.kind==='generic_ballot'),asOf),asOf);
  const published=data?.averages.filter(a=>a.observed_on<=asOf).sort((a,b)=>b.observed_on.localeCompare(a.observed_on))||[];
  const latestAverage=published.filter(a=>a.observed_on===published[0]?.observed_on);
  const dateMin='2023-01-01',dateMax=today;
  const controlAvailable=stage==='general'&&cycle===2026&&Boolean(data?.baseline);
  const baseline=data?.baseline;
  const totals=controlAvailable?controlSummary(races,{total:baseline.total,holdD:baseline.holdovers.D,holdR:baseline.holdovers.R,holdOther:baseline.holdovers.I,swing,overrides,useBaseline}):null;
  const displayed=races.filter(r=>(!state||r.state===state)&&`${r.label} ${r.state}`.toLowerCase().includes(query.toLowerCase())&&(filter==='all'||(filter==='polled'?r.polls.length>0:category(r.lead.margin)===filter)));
  const selectRace=r=>{change({state:r.state,seat:r.seatKey});setBrowserTab('polls');};
  const seatStatus=r=>{
    const call=overrides[r.seatKey];
    if(call)return ['D','R'].includes(call.party)?call.party:'other';
    if(r.lead.margin!=null)return mapShade(r.lead.margin+swing);
    if(controlAvailable&&useBaseline&&r.incumbent)return r.incumbent.party==='D'?'baselineD':r.incumbent.party==='R'?'baselineR':'other';
    return 'unknown';
  };
  const pickOptions=useMemo(()=>{
    if(!selected)return [];
    const roster=(data?.candidates||[]).filter(item=>item.seat===selected.seatKey).map(item=>({key:`roster:${item.id}`,name:item.name,party:partyGroup(item.party),source:item.source,kind:'roster'}));
    const polled=selected.polls.flatMap(q=>q.responses||[]).filter(r=>r.candidate&&['D','R'].includes(partyGroup(r.party))).map(r=>({key:`poll:${r.sourceId||r.candidate}`,name:r.candidate,party:partyGroup(r.party),source:'NYT poll response',kind:'poll'}));
    const seen=new Set();return [...roster,...polled].filter(item=>{const key=`${item.name.toLowerCase()}:${item.party}`;if(seen.has(key))return false;seen.add(key);return true;}).sort((a,b)=>a.party.localeCompare(b.party)||a.name.localeCompare(b.name));
  },[data?.candidates,selected]);
  const selectedCall=selected?overrides[selected.seatKey]:null;
  const heldPositions=!selected&&controlAvailable&&state?baseline.holdoverSeats?.[state]:null;
  const chooseCall=value=>setOverrides(current=>{const next={...current};if(!value)delete next[selected.seatKey];else {const item=pickOptions.find(option=>option.key===value);next[selected.seatKey]=item?{...item}:{key:value,party:value.slice(6),name:null,kind:'party'};}return next;});
  const winnerPicker=selected&&controlAvailable?<div className="winner-picker">
          <p className="holder-line">{selected.incumbent?<>Current holder: <b>{selected.incumbent.name}</b> · {partyLabel(selected.incumbent.party)}</>:<>No current holder in the {baseline.asOf} snapshot.</>}</p>
          <label>Pick a winner
            <select value={selectedCall?.key||''} onChange={e=>chooseCall(e.target.value)}>
              <option value="">Use polling or current holder</option>
              {selectedCall&&!selectedCall.key?.startsWith('party:')&&!pickOptions.some(option=>option.key===selectedCall.key)&&<option value={selectedCall.key}>Saved pick: {callLabel(selectedCall)}</option>}
              {pickOptions.some(option=>option.kind==='roster')&&<optgroup label="Listed general candidates">{pickOptions.filter(option=>option.kind==='roster').map(option=><option key={option.key} value={option.key}>{option.name} · {partyLabel(option.party)}</option>)}</optgroup>}
              {pickOptions.some(option=>option.kind==='poll')&&<optgroup label="Named in polls">{pickOptions.filter(option=>option.kind==='poll').map(option=><option key={option.key} value={option.key}>{option.name} · {partyLabel(option.party)}</option>)}</optgroup>}
              <optgroup label="Choose a party"><option value="party:D">Democratic winner</option><option value="party:R">Republican winner</option><option value="party:other">Independent / other winner</option></optgroup>
            </select>
          </label>
          {selectedCall?.kind==='party'&&<label>Winner's name (optional)<input value={selectedCall.name||''} maxLength={100} onChange={e=>setOverrides(current=>({...current,[selected.seatKey]:{...current[selected.seatKey],name:e.target.value}}))} placeholder="Add a name to this party pick"/></label>}
          {selectedCall&&<p>Your pick: <b>{callLabel(selectedCall)}</b> · counted as {partyLabel(selectedCall.party)}{selectedCall.source?` · ${selectedCall.source}`:''}.</p>}
          <small>Candidate names come from imported source rosters or poll responses; they are not a verified ballot. Picks are saved in this browser and change the scenario, not the source data.</small>
        </div>:null;
  const mapFeatures=office==='us_house'?(geometry.data?.features||[]):states.features;
  return <section className="explorer">
    <div className="explorer-heading"><div><span className="section-label">ELECTIONEER / ELECTION EXPLORER</span><h1>The road to {cycle}</h1><p>Follow the polls. Explore the map. Test a path to control.</p></div><button className="back-button" onClick={()=>openHistory({office,state,cycle:2024})}>Explore historical results →</button></div>
    <div className="explorer-toolbar"><div className="office-tabs">{Object.entries(officeNames).map(([id,label])=><button key={id} className={office===id?'active':''} onClick={()=>change({office:id,seat:''})}>{label}</button>)}</div><label>Election <select value={cycle} onChange={e=>change({cycle:Number(e.target.value),seat:''})}>{[2025,2026,2027,2028].map(y=><option key={y}>{y}</option>)}</select></label><label>Stage <select value={stage} onChange={e=>change({stage:e.target.value,seat:''})}>{[...new Set(['general',...allPolls.filter(q=>q.office===office&&q.kind==='election').map(q=>q.stage),stage])].filter(Boolean).map(s=><option key={s}>{s}</option>)}</select></label></div>
    <div className="time-travel"><div><strong>Polling through {asOf}</strong><span>Reconstructed from the latest imported source revisions</span></div><button aria-label="Go back one week" disabled={asOf<=dateMin} onClick={()=>change({asOf:iso(Math.max(Date.parse(dateMin),Date.parse(asOf)-7*day))})}>←</button><input aria-label="Polling timeline" type="range" min={Date.parse(dateMin)/day} max={Date.parse(dateMax)/day} value={Date.parse(asOf)/day} onChange={e=>change({asOf:iso(Number(e.target.value)*day)})}/><button aria-label="Go forward one week" disabled={asOf>=dateMax} onClick={()=>change({asOf:iso(Math.min(Date.parse(dateMax),Date.parse(asOf)+7*day))})}>→</button><input aria-label="Polling cutoff date" type="date" min={dateMin} max={dateMax} value={asOf} onChange={e=>{if(e.target.value)change({asOf:e.target.value});}}/><button onClick={()=>change({asOf:today})}>Today</button></div>
    {resource.error&&<p role="alert" className="import-error">{resource.error}</p>}
    {resource.loading?<p className="page-loading">Loading the polling map…</p>:<>
    <p className="muted">Imported polling snapshot: latest fieldwork {allPolls[0]?.field_end||'unavailable'}. Move the date to explore earlier observations.</p><div className="national-strip"><button onClick={()=>setNational('approval')} className={national==='approval'?'active':''}><span>NATIONAL · PRESIDENTIAL APPROVAL</span><strong>{latestAverage.length?latestAverage.map(a=>`${a.response_label} ${Number(a.share).toFixed(1)}%`).join(' / '):'No published average'}</strong><small>NYT published average · {published[0]?.observed_on||'No data by this date'}</small></button><button onClick={()=>setNational('generic_ballot')} className={national==='generic_ballot'?'active':''}><span>NATIONAL · GENERIC BALLOT</span><strong>{marginText(generic.margin)}</strong><small>Polling average · {generic.count} pollsters · latest {generic.latest||'—'}</small></button></div>
    {controlAvailable&&totals&&<section className="control-card">
      <div className="control-title"><div>
        <span className="section-label">{swing||Object.keys(overrides).length||!useBaseline?'YOUR SCENARIO':'POLLING + CURRENT HOLDERS'} · {officeNames[office].toUpperCase()}</span>
        <h2>{office==='governor'?(`Scenario: ${totals.D} Democratic and ${totals.R} Republican governors`):totals.D>=totals.majority?'Democratic-aligned majority in this scenario':totals.R>=totals.majority?'Republican majority in this scenario':office==='us_senate'&&totals.D===50&&totals.R===50?'A 50–50 Senate; the vice president breaks the tie':'Control remains unresolved'}</h2>
      </div><strong>{totals.majority}<small>{office==='governor'?'of 50 governorships':'seats for an outright majority'}</small></strong></div>
      <p className="current-balance">Current positions as of {baseline.asOf}: <b>{baseline.current.D} D</b> · <b>{baseline.current.R} R</b>{baseline.current.I>0&&<> · <b>{baseline.current.I} independent</b></>}{baseline.current.vacant>0&&<> · <b>{baseline.current.vacant} vacant</b></>}</p>
      <div className="control-bar">{['D','competitive','unknown','other','R'].map(k=><div key={k} style={{width:`${totals[k]/totals.total*100}%`,background:colors[k]}} title={`${k}: ${totals[k]}`}>{totals[k]>3?totals[k]:''}</div>)}</div>
      <div className="control-legend"><span>Democratic-aligned {totals.D}</span><span>Competitive {totals.competitive}</span><span>Unassigned {totals.unknown}</span><span>Other {totals.other}</span><span>Republican {totals.R}</span></div>
      <p>{totals.sources.polled} seats use a polling lead, {totals.sources.incumbent} use the current holder's party, and {totals.sources.picked} use your picks. {office==='us_senate'?`${baseline.holdovers.D} Democratic-aligned and ${baseline.holdovers.R} Republican seats are not up in 2026. The two independent holdovers caucus with Democrats.`:office==='governor'?`${baseline.holdovers.D+baseline.holdovers.R} governorships are not up in 2026.`:'Vacancies and independents remain distinct.'} Leads within 3 points remain competitive. Current holders are a scenario assumption, not a forecast.</p>
      <label className="baseline-toggle"><input type="checkbox" checked={useBaseline} onChange={e=>setUseBaseline(e.target.checked)}/> Use current holder's party when a race has no usable polling average</label>
      <div className="swing-control"><label htmlFor="swing">Test a uniform polling-margin shift: <b>{swing===0?'None':`${swing>0?'D':'R'} +${Math.abs(swing).toFixed(1)}`}</b></label><input id="swing" type="range" min="-10" max="10" step="0.5" value={swing} onChange={e=>setSwing(Number(e.target.value))}/><button onClick={()=>{setSwing(0);setOverrides({});setUseBaseline(true);}}>Reset scenario</button></div>
    </section>}
    {electionPolls.some(q=>!mappedSeat(q,data.districts))&&<p role="status">{electionPolls.filter(q=>!mappedSeat(q,data.districts)).length} questions cannot be mapped to the available boundaries. They remain available in the Polls library.</p>}<div className="explorer-grid"><section className="map-card"><div className="map-card-head"><div><h2>{cycle} {officeNames[office]} polling map</h2><p>{races.filter(r=>r.polls.length).length} seats with polls · {races.filter(r=>r.lead.margin!=null).length} with a recent comparable average</p></div>{state&&<button className="back-button" onClick={()=>change({state:'',seat:''})}>All states ×</button>}</div>
      <div className="outlook-map">{geometry.error?<p role="alert">District map could not load: {geometry.error}</p>:geometry.loading&&office==='us_house'?<p>Loading district boundaries…</p>:<svg viewBox="0 0 980 610" aria-label={`${cycle} ${officeNames[office]} polling map`}>
        {office==='us_house'&&states.features.map(f=><path key={f.id} d={path(f)} fill={colors.off} stroke="white"/>)}
        {mapFeatures.map(f=>{
          const s=office==='us_house'?f.properties.stateAbbreviation:data.states.find(item=>item.state_fips===String(f.id).padStart(2,'0'))?.state;
          const key=office==='us_house'?`${s}-${districtCode(f.properties.districtCode)}`:s;
          const r=races.find(item=>item.seatKey===key);
          const holder=office==='governor'&&!r?baseline?.holdoverSeats?.[s]:null;
          const call=r?overrides[r.seatKey]:null;
          const fill=r?colors[seatStatus(r)]:holder&&controlAvailable&&useBaseline?colors[holder.party==='D'?'baselineD':'baselineR']:colors.off;
          const continuing=office==='us_senate'&&!r?baseline?.holdoverSeats?.[s]:null;
          const label=r?`${r.label}: ${call?`your pick ${callLabel(call)} (${partyLabel(call.party)})`:r.lead.margin!=null?`polling ${marginText(r.lead.margin)}`:r.incumbent?`current holder ${r.incumbent.name} (${partyLabel(r.incumbent.party)})`:'no polling or holder'}`:holder?`${f.properties.name||s}: ${holder.name} (${partyLabel(holder.party)}), no 2026 governor election`:continuing?.length?`${f.properties.name||s}: ${continuing.map(item=>`${item.name} (${item.party})`).join(' and ')}, no 2026 Senate election`:`${f.properties.name||key}: no mapped polling race`;
          const select=()=>r?selectRace(r):change({state:s||'',seat:''});
          return <path key={f.id} d={path(f)} fill={fill} stroke={selected?.seatKey===key?'#172235':'#fff'} strokeWidth={selected?.seatKey===key?2.5:office==='us_house'?0.45:1.3} role="button" tabIndex="0" aria-pressed={selected?.seatKey===key} aria-label={label} onClick={select} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select();}}}><title>{label}</title></path>;
        })}
      </svg>}</div><div className="outlook-legend">{[...mapLegend,...(controlAvailable?[['baselineD','Current D holder'],['baselineR','Current R holder'],['other','Independent / other']]:[])].map(([k,l])=><span key={k}><i style={{background:colors[k]}}/>{l}</span>)}</div><footer>{office==='us_house'?`${cycle===2026?'120th Congress':cycle+'-dated'} imported district boundaries. Polls join by state and district, not candidate names.`:'Select a state, or choose a seat from the list. Polling leads, current holders, and your picks have distinct colors.'}</footer></section>
      <aside className="race-browser">
        <div className="race-browser-heading"><div><span className="section-label">{selected?`${officeNames[office].toUpperCase()} · ${stage.toUpperCase()}`:'LATEST POLLING'}</span><h2>{selected?.label|| (state?`${state} polling`:'Across the map')}</h2></div><div className="level-toggle" aria-label="Browse polls or races"><button aria-pressed={browserTab==='polls'} className={browserTab==='polls'?'active':''} onClick={()=>setBrowserTab('polls')}>Polls</button><button aria-pressed={browserTab==='races'} className={browserTab==='races'?'active':''} onClick={()=>setBrowserTab('races')}>Races</button></div></div>
        <label className="browser-race-select">Race<select aria-label="Choose a polling race" value={selected?.seatKey||''} onChange={e=>{const r=races.find(r=>r.seatKey===e.target.value);if(r)selectRace(r);else change({state:'',seat:''});}}><option value="">All mapped races</option>{races.map(r=><option key={r.seatKey} value={r.seatKey}>{r.label}</option>)}</select></label>
        {winnerPicker}
        {browserTab==='polls'?<>
          {selected&&<div className="browser-average"><span>Polling average <strong className={selected.lead.margin==null?'poll-other':selected.lead.margin>0?'poll-D':'poll-R'}>{marginText(selected.lead.margin)}</strong></span><small>{selected.lead.count} pollsters · {selected.lead.latest||'No recent average'}</small>{selected.lead.matchup&&<div><span className="poll-D">{selected.lead.matchup.d} {selected.lead.d.toFixed(1)}%</span><span className="poll-R">{selected.lead.matchup.r} {selected.lead.r.toFixed(1)}%</span></div>}</div>}
          <PollTable rows={browserRows} used={selected?.lead.questionIds||[]} showPlace={!selected} caption={selected?`${selected.label} polls`:`${state||'All states'} · ${officeNames[office]} polls`}/>
        </>:<><input aria-label="Search races" placeholder="Search a state or district…" value={query} onChange={e=>setQuery(e.target.value)}/><select aria-label="Filter races" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">All seats</option><option value="polled">Has polls</option><option value="competitive">Competitive polling</option><option value="unknown">No usable average</option></select><div className="race-scroll">{!displayed.length&&<p>No races match. Try all states or another filter.</p>}{displayed.map(r=><button key={r.seatKey} onClick={()=>selectRace(r)} className={selected?.seatKey===r.seatKey?'selected':''}><i style={{background:colors[seatStatus(r)]}}/><span><b>{r.label}</b><small>{r.polls.length} questions · {r.lead.latest||'No recent average'}</small></span><strong>{overrides[r.seatKey]?`Your pick: ${callLabel(overrides[r.seatKey])}`:r.lead.margin!=null?marginText(r.lead.margin):r.incumbent&&useBaseline?`${r.incumbent.party} holder`:marginText(null)}</strong></button>)}</div></>}
      </aside></div>
    <section className="race-detail">{selected?<><div className="detail-heading"><div><span className="section-label">RACE DETAILS · {stage.toUpperCase()}</span><h2>{selected.label} · {officeNames[office]}</h2></div><button className="back-button" onClick={()=>openHistory({office,state:selected.state,cycle:2024})}>Past results in {selected.state} →</button></div>
      {selected.lead.alternatives.length>1&&<label>Compare a matchup <select value={selected.lead.matchup?.key||''} onChange={e=>setMatchups({...matchups,[selected.seatKey]:e.target.value})}>{selected.lead.alternatives.map(m=><option key={m.key} value={m.key}>{m.label}</option>)}</select></label>}
      <div className="detail-columns"><div>
        <strong className="large-margin">{marginText(selected.lead.margin)}</strong>
        <p>{selected.lead.matchup?`${selected.lead.matchup.d} ${selected.lead.d.toFixed(1)}% / ${selected.lead.matchup.r} ${selected.lead.r.toFixed(1)}%`:'See the polling table beside the map for individual responses.'}</p>
        {selected.incumbent&&<p className="holder-line">Current holder: <b>{selected.incumbent.name}</b> · {partyLabel(selected.incumbent.party)} · snapshot {baseline?.asOf}</p>}
        {selected.raceIds.size>1&&<p>Multiple source races map to this seat. Their raw polls remain separate; no combined average is calculated.</p>}
        <p>{selected.lead.count} pollsters in average · latest {selected.lead.latest||'—'} · {selected.lead.excluded} questions outside the average</p>
      </div><Trend rows={selectedRows} asOf={asOf} matchup={selected.lead.matchup?.key}/></div></>:heldPositions?<><span className="section-label">CURRENT POSITIONS · {baseline.asOf}</span><h2>{state} has no {cycle} {officeNames[office]} election</h2>{(Array.isArray(heldPositions)?heldPositions:[heldPositions]).map((holder,index)=><p key={index}><b>{holder.name}</b> · {partyLabel(holder.party)}{holder.class?` · Senate class ${holder.class}`:''}</p>)}<p>These positions count as holdovers in the control totals. The polling cutoff does not change this dated roster.</p></>:<p>Select a state or district to explore its polling history.</p>}</section>
    <details className="national-detail" open><summary>National context · {national==='approval'?'presidential approval':'generic congressional ballot'} · {nationalRows.length} questions</summary><p>National opinion provides context for every map. These observations are never assigned to a state or district, and generic ballot margins are not converted into seat counts.</p>{national==='approval'&&<ApprovalTrend rows={published} asOf={asOf}/>} {national==='generic_ballot'&&<Trend rows={nationalRows} asOf={asOf} matchup={generic.matchup?.key}/>}<PollTable approval={national==='approval'} caption={national==='approval'?'National approval polls':'National generic ballot polls'} rows={nationalRows} used={national==='generic_ballot'?generic.questionIds:[]}/></details>
    <details className="methodology"><summary>How to read the outlook · sources and assumptions</summary><p>Polling average {MODEL_VERSION}: a descriptive average of the latest survey per pollster for one candidate pair, within 60 days. Recency weight halves every 21 days. Likely voters take precedence over registered voters, then adults within the same survey. Published shares are not normalized. No fabricated pollster grades, error bands or win probabilities are used.</p><p>The default pair comes from the latest eligible question. Other pairs remain selectable. Hypotheticals, subpopulations, ranked-choice rounds, multiple candidates of the same major party and third-party leaders remain raw observations. Primary polling does not populate general-election control totals. An empty average is not evidence of a safe seat.</p><p>The timeline excludes polls whose fieldwork or source creation date falls after the cutoff. It uses the latest imported revisions, so it is a reconstruction, not a claim about exactly what was known on that day. Picks are saved in this browser by office, election year and stage. Moving the polling date keeps them; Reset clears the current scenario. The 2026 officeholder snapshot is fixed as of its stated date, not reconstructed for earlier polling dates.</p><p>Polling compiled by <a href="https://www.nytimes.com/interactive/polls/">The New York Times</a>, supplied under <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>. The displayed averages and mappings are our transformations. NYT approval averages retain their published values.</p><p>Current-holder snapshot checked September 29, 2026: <a href="https://clerk.house.gov/Members/ViewMemberList">House Clerk district roster</a>, Senate <a href="https://www.senate.gov/senators/Class_I.htm">Class I</a>, <a href="https://www.senate.gov/senators/Class_II.htm">Class II</a>, <a href="https://www.senate.gov/senators/Class_III.htm">Class III</a>; <a href="https://dos.fl.gov/elections/candidates-committees/offices-up-for-election">Florida election offices</a> and <a href="https://www.ohiosos.gov/elections/elections-administration/directives">Ohio special-election directive</a>. Counting the two independent holdovers with Democrats is a coalition assumption. Governor parties: <a href="https://www.nga.org/wp-content/uploads/2024/12/Governors-Roster.pdf">NGA current roster</a>. Governor schedule: <a href="https://www.nga.org/governors/elections/">NGA elections</a>. The House count excludes nonvoting delegates; two seats were vacant in the snapshot. Baseline party holds are assumptions for unpolled races, not assertions about candidate strength. State maps exclude territories.</p></details>
    </>}
  </section>;
}

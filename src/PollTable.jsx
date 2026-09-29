import React,{useEffect,useState} from 'react';
import {responseColumns} from './pollingPresentation.js';

const safeUrl=url=>/^https?:\/\//i.test(url||'')?url:null;
const population={likely_voters:'LV',registered_voters:'RV',adults:'A'};
const percent=value=>value==null?'—':`${Number(value).toLocaleString('en-US',{maximumFractionDigits:2})}%`;

export function PollTable({rows,used=[],approval=false,showPlace=false,caption='Individual polls'}) {
  const [limit,setLimit]=useState(12);
  useEffect(()=>setLimit(12),[rows]);
  const included=new Set(used);
  function responseCell(responses,group) {
    return <td className={`poll-column poll-${group}`}>{responses.length?responses.map((r,i)=><div className="table-response" key={r.sourceId||i}><strong>{percent(r.share)}</strong><span>{approval?r.label:r.candidate||r.label}</span></div>):<span className="poll-missing">—</span>}</td>;
  }
  return <div className="poll-table-panel">
    <div className="poll-table-scroll" tabIndex="0" role="region" aria-label={`${caption}, scrollable table`}>
      <table className="poll-table"><caption>{caption} · {rows.length} questions</caption>
        <thead><tr><th scope="col">Poll / field dates</th><th scope="col" className="poll-D">{approval?'Approve':'Dem'}</th><th scope="col" className="poll-R">{approval?'Disapprove':'Rep'}</th><th scope="col" className="poll-other">Other / undecided</th><th scope="col">{approval?'Net':'D/R lead'}</th></tr></thead>
        <tbody>{!rows.length?<tr><td colSpan="5" className="poll-empty">No polls match this place, stage and date.</td></tr>:rows.slice(0,limit).map(q=>{
          const groups=responseColumns(q.responses,approval);
          const margin=groups.D.length===1&&groups.R.length===1?Number(groups.D[0].share)-Number(groups.R[0].share):null;
          const flags=[q.hypothetical==='TRUE'?'Hypothetical':null,q.ranked_choice_round?`RCV round ${q.ranked_choice_round}`:null,q.subpopulation,q.partisan?`Partisan: ${q.partisan}`:null].filter(Boolean);
          return <tr key={q.id} className={included.has(q.id)?'used-poll':''}>
            <th scope="row"><div className="table-pollster">{safeUrl(q.url)?<a href={q.url} target="_blank" rel="noreferrer">{q.pollster} ↗</a>:q.pollster}{included.has(q.id)&&<span title="Included in the displayed average" aria-label="Included in the displayed average" className="included-mark">●</span>}</div>
              <span className="table-dates"><time>{q.field_start}</time> – <time>{q.field_end}</time></span>
              <span className="table-sample" title={q.population?.replaceAll('_',' ')}>n={q.sample_size?.toLocaleString()||'—'} · {population[q.population]||q.population?.replaceAll('_',' ')||'Unknown population'}</span>
              {showPlace&&<span className="table-place">{q.state_name||q.state}{q.district?` · ${q.district==='0'?'At-large':`District ${q.district}`}`:''} · {q.stage}</span>}
              {!!flags.length&&<span className="table-flags">{flags.join(' · ')}</span>}
              <details className="poll-source-detail"><summary>Source</summary><span>{q.source} · {q.license}{q.methodology?` · ${q.methodology}`:''}</span></details>
            </th>
            {responseCell(groups.D,'D')}{responseCell(groups.R,'R')}{responseCell(groups.other,'other')}
            <td className={`table-spread ${margin==null||Math.abs(margin)<0.05?'poll-other':margin>0?'poll-D':'poll-R'}`}>{margin==null?'—':Math.abs(margin)<0.05?'Even':`${approval?(margin>0?'+':'−'):(margin>0?'D +':'R +')}${Math.abs(margin).toFixed(1)}`}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
    <div className="poll-table-footer"><span>LV likely · RV registered · A adults<br/>● In displayed average · Shares as published</span>{rows.length>limit&&<button className="back-button" onClick={()=>setLimit(limit+20)}>More ({rows.length-limit})</button>}</div>
    <p className="poll-table-attribution">Via <a href="https://www.nytimes.com/interactive/polls/">The New York Times</a> · <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>, unless noted under Source. Other responses stay separate; no inferred undecided share.</p>
  </div>;
}

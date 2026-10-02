// A descriptive polling model, deliberately separate from certified results and forecasts.
export const MODEL_VERSION = 'polling-lead-v1';
const day = 86400000;
const yes = value => /^(true|yes|1)$/i.test(String(value || ''));
export function districtCode(value) {
  if (/^(AL|at.large|0+)$/i.test(String(value))) return 'AL';
  return /^\d+$/.test(String(value)) ? String(Number(value)).padStart(2, '0') : null;
}
export function availableOn(q) {
  const match = String(q.created_at || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})(?:\s|$)/);
  const published = match ? `${match[3].length === 2 ? '20' : ''}${match[3]}-${match[1].padStart(2,'0')}-${match[2].padStart(2,'0')}` : q.field_end;
  return published > q.field_end ? published : q.field_end;
}
export function visiblePolls(rows, asOf) { return rows.filter(q => q.field_end && availableOn(q) <= asOf); }
export function pair(q) {
  if (yes(q.hypothetical) || q.subpopulation || q.ranked_choice_round || yes(q.ranked_choice_reallocated)) return null;
  const d = q.responses.filter(r => ['DEM','D'].includes(r.party));
  const r = q.responses.filter(r => ['REP','R'].includes(r.party));
  if(d.length !== 1 || r.length !== 1) return null;
  // A third-party leader cannot be interpreted as a D/R contest lead.
  if(q.responses.some(x => !['NONE','DEM','D','REP','R',''].includes(x.party || '') && Number(x.share) >= Math.max(Number(d[0].share),Number(r[0].share)))) return null;
  return {key:`${d[0].sourceId || d[0].label}|${r[0].sourceId || r[0].label}`,d:d[0],r:r[0]};
}
export function pollingLead(rows, asOf, matchupKey) {
  const recent = visiblePolls(rows,asOf).filter(q => (Date.parse(asOf)-Date.parse(q.field_end))/day <= 60 && ['general','special'].includes(q.stage || 'general'));
  const candidates = recent.map(q => ({q,p:pair(q)})).filter(x => x.p).sort((a,b)=>b.q.field_end.localeCompare(a.q.field_end)||a.q.id.localeCompare(b.q.id));
  const matchup = matchupKey || candidates[0]?.p.key;
  const matching = candidates.filter(x=>x.p.key===matchup);
  // One population/question per survey, then only the latest survey per pollster.
  const priority = {likely_voters:3,registered_voters:2,adults:1};
  matching.sort((a,b)=>b.q.field_end.localeCompare(a.q.field_end)||(priority[b.q.population]||0)-(priority[a.q.population]||0)||Number(b.q.sample_size||0)-Number(a.q.sample_size||0)||a.q.id.localeCompare(b.q.id));
  const surveys=new Set(),pollsters=new Set();
  const used=matching.filter(({q})=>{
    if(surveys.has(q.survey_id)||pollsters.has(q.pollster_id)) return false;
    surveys.add(q.survey_id);pollsters.add(q.pollster_id);return true;
  });
  let weight=0,d=0,r=0;
  for(const {q,p} of used) { const w=2**(-((Date.parse(asOf)-Date.parse(q.field_end))/day)/21);weight+=w;d+=Number(p.d.share)*w;r+=Number(p.r.share)*w; }
  return {margin:weight?(d-r)/weight:null,d:weight?d/weight:null,r:weight?r/weight:null,
    count:used.length,questionIds:used.map(x=>x.q.id),latest:used[0]?.q.field_end||null,
    matchup:used[0]?{key:matchup,d:used[0].p.d.candidate||used[0].p.d.label,r:used[0].p.r.candidate||used[0].p.r.label}:null,
    alternatives:[...new Map(candidates.map(x=>[x.p.key,{key:x.p.key,label:`${x.p.d.candidate||x.p.d.label} / ${x.p.r.candidate||x.p.r.label}`}])).values()],
    excluded:visiblePolls(rows,asOf).length-used.length};
}
export function category(margin) { return margin == null ? 'unknown' : Math.abs(margin)<3-1e-9 ? 'competitive' : margin>0?'D':'R'; }
export function mappedSeat(q,districts=[]) {
  if(q.kind!=='election'||q.state==='US'||q.state==='DC') return null;
  if(q.office!=='us_house') return q.state;
  let code=districtCode(q.district);
  if(code==='01'&&districts.some(d=>d.abbreviation===`${q.state}-AL`))code='AL';
  const key=code?`${q.state}-${code}`:null;
  return districts.some(d=>d.abbreviation===key)?key:null;
}
export function controlSummary(races,{total=435,holdD=0,holdR=0,holdOther=0,swing=0,overrides={},useBaseline=true}={}) {
  const counts={D:holdD,R:holdR,other:holdOther,competitive:0,unknown:0};
  const sources={picked:0,polled:0,incumbent:0};
  // Multiple source races for a seat never create extra seats.
  const groups=new Map();
  for(const race of races) if(race.seatKey && race.state!=='DC') { const list=groups.get(race.seatKey)||[];list.push(race);groups.set(race.seatKey,list); }
  for(const group of groups.values()) {
    const race=group[0];
    const selected=overrides[race.seatKey];
    let status='unknown';
    if(selected) {
      const party=typeof selected==='string'?selected:selected.party;
      status=party==='D'||party==='R'||party==='competitive'||party==='unknown'?party:'other';
      sources.picked++;
    } else if(group.length===1 && race.lead.margin!=null) {
      status=category(race.lead.margin+swing);sources.polled++;
    } else if(group.length===1 && useBaseline && race.incumbent?.party) {
      status=['D','R'].includes(race.incumbent.party)?race.incumbent.party:'other';sources.incumbent++;
    }
    counts[status in counts?status:'unknown']++;
  }
  counts.unknown += Math.max(0,total-Object.values(counts).reduce((a,b)=>a+b,0));
  return {...counts,total,majority:Math.floor(total/2)+1,sources};
}

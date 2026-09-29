import { createHash } from 'node:crypto';
export const nytUrl = 'https://www.nytimes.com/interactive/polls/';
export const sha = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const offices = { 'U.S. President': 'president', 'U.S. Senate': 'us_senate', 'U.S. House': 'us_house', Governor: 'governor' };
const stages = new Set(['general','primary','runoff','special','primary runoff','special primary','special runoff']);
export function sourceDate(value) {
  let date = value;
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(value);
  if (match) date = `${match[3].length === 2 ? '20' : ''}${match[3]}-${match[1].padStart(2,'0')}-${match[2].padStart(2,'0')}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10) !== date) throw new Error(`Invalid source date: ${value}`);
  return date;
}
function percentage(value) {
  if (!value.trim() || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 100) throw new Error(`Invalid published percentage: ${value}`);
  return Number(value);
}
export function parseNyt({header,rows}) {
  const has = fields => fields.every(field => header.includes(field));
  if (has(['topic','date','answer','pct']) && header.length === 4) {
    const seen = new Map();
    const averages = rows.map(r => {
      // This exact topic is documented by the supplied NYT approval-average file.
      if (r.topic !== '2025 Approval - Trump') throw new Error(`Unrecognized published-average series: ${r.topic}; supply its NYT documentation before mapping it.`);
      const item = { series: 'nyt:approval:trump:2025', date: sourceDate(r.date), answer: r.answer, share: percentage(r.pct), raw: r };
      const key = `${item.series}:${item.date}:${item.answer}`;
      if (seen.has(key)) throw new Error(`Duplicate average observation ${key}`);
      seen.set(key, true); return item;
    });
    return { adapter: 'nyt-averages-v1', source: 'nyt-polls', averages, questions: [], rowsRead: rows.length, warnings: ['Times-published approval averages; separate from individual polls and Signal model estimates.'] };
  }
  if (!has(['poll_id','question_id','pollster_id','pollster','start_date','end_date','population','sample_size','state','methodology'])) return null;
  const approval = has(['politician','yes','no','alternate_answers']);
  if (!approval && !has(['race_id','candidate_id','candidate_name','pct','answer','office_type','cycle','stage'])) throw new Error('Unrecognized NYT question format');
  const questions = new Map(); let duplicateRows = 0;
  for (const [index,r] of rows.entries()) {
    for (const key of ['poll_id','question_id','pollster_id']) if (!r[key]) throw new Error(`Record ${index + 2}: missing ${key}`);
    const start = sourceDate(r.start_date), end = sourceDate(r.end_date);
    if (end < start) throw new Error(`Question ${r.question_id}: field dates are reversed`);
    if (Number(end.slice(0,4)) < 2014) throw new Error('Polling archive begins in 2014');
    const sample = r.sample_size === '' ? null : Number(r.sample_size);
    if (sample !== null && (!Number.isSafeInteger(sample) || sample <= 0)) throw new Error(`Question ${r.question_id}: invalid sample size`);
    if (!approval && (!offices[r.office_type] || !stages.has(r.stage) || !/^20\d\d$/.test(r.cycle) || !r.race_id || !r.candidate_id)) throw new Error(`Question ${r.question_id}: unsupported office, cycle, stage or missing race_id/candidate_id; no identity is inferred from a display name`);
    const kind = approval ? 'approval' : r.office_type === 'U.S. House' && r.state === 'US' && !r.seat_number ? 'generic_ballot' : 'election';
    const responseFields = approval ? ['yes','no','alternate_answers'] : ['party','pct','answer','candidate_name','candidate_id'];
    const metadata = Object.fromEntries(Object.entries(r).filter(([key]) => !responseFields.includes(key)));
    // Ranked-choice rounds are distinct question observations, never combined.
    const key = `nyt:question:${r.question_id}:round:${r.ranked_choice_round || 'none'}`;
    const signature = sha(metadata);
    if (!questions.has(key)) questions.set(key, { key, pollKey: `nyt:poll:${r.poll_id}`, pollsterKey: `nyt:pollster:${r.pollster_id}`, raceKey: approval ? null : `nyt:race:${r.race_id}`, kind, start, end, sample, state: r.state || 'US', population: r.population, cycle: approval ? null : Number(r.cycle), office: approval ? 'president' : offices[r.office_type], stage: approval ? null : r.stage, metadata, signature, responses: [], seen: new Map() });
    const q = questions.get(key);
    if (q.signature !== signature) throw new Error(`Conflicting metadata within question ${r.question_id}; split or correct the source file.`);
    const responses = approval ? [['Approve',r.yes],['Disapprove',r.no]].map(([answer,pct]) => ({ key: `nyt:approval:${answer}`, answer, share: percentage(pct), raw: r })) : [{ key: `nyt:candidate:${r.candidate_id}`, answer: r.answer, share: percentage(r.pct), raw: r }];
    for (const response of responses) {
      if (!response.answer) throw new Error(`Question ${r.question_id}: empty answer`);
      if (q.seen.has(response.key)) {
        if (q.seen.get(response.key) !== sha(response)) throw new Error(`Conflicting response ${response.key} in ${r.question_id}`);
        duplicateRows++; continue;
      }
      q.seen.set(response.key,sha(response)); q.responses.push(response);
    }
  }
  const values = [...questions.values()].map(q => {
    delete q.seen; delete q.signature;
    q.responses.sort((a,b) => a.key.localeCompare(b.key));
    q.hash = sha(q); return q;
  });
  const non100 = values.filter(q => Math.abs(q.responses.reduce((s,r) => s+r.share,0)-100) > .05).length;
  return { adapter: approval ? 'nyt-approval-v1' : 'nyt-election-v1', source: 'nyt-polls', rowsRead: rows.length, questions: values, averages: [], duplicateRows, warnings: [`${non100} questions have published shares that do not sum to 100; percentages are preserved.`, 'Polled responses are source identities, not verified ballot choices. No quality scores or forecasts are inferred.', ...(approval ? ['alternate_answers is preserved as source metadata; an unlabeled remainder is not assigned an invented response.'] : [])] };
}

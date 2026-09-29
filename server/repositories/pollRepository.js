import { db } from '../db.js';
const current=`SELECT DISTINCT ON (source_id,source_identifier) * FROM poll_questions WHERE source_identifier IS NOT NULL ORDER BY source_id,source_identifier,recorded_at DESC,id DESC`;
export async function pollFacets(req,res) {
  const rows=(await db.query(`WITH current AS (${current}) SELECT DISTINCT q.cycle,q.office_slug,q.stage,q.question_kind,g.abbreviation AS state FROM current q JOIN geographies g ON g.id=q.geography_id`)).rows;
  res.json({data:rows});
}
export async function listPolls(req,res) {
  const params=[];const where=[];
  const filters={state:'g.abbreviation',cycle:'q.cycle::text',office:'q.office_slug',stage:'q.stage',kind:'q.question_kind',race:'q.polling_race_id::text'};
  for(const [key,column] of Object.entries(filters)) if(req.query[key]) {params.push(String(req.query[key]));where.push(`${column}=$${params.length}`);}
  const offset=Math.max(0,Math.min(100000,Number(req.query.offset)||0));
  const limit=Math.max(1,Math.min(100,Number(req.query.limit)||30));
  const rows=(await db.query(`WITH current AS (${current}) SELECT q.id,q.contest_id,q.polling_race_id,q.question_kind,q.cycle,q.office_slug,q.stage,q.field_start::text,q.field_end::text,q.sample_size,q.population,q.metadata,q.revision_of_question_id,
    p.source_identifier AS survey_id,ps.name AS pollster,g.name AS geography,g.abbreviation AS state,s.name AS source,s.homepage_url AS source_url,a.license,
    (SELECT jsonb_agg(jsonb_build_object('label',r.response_label,'share',r.share,'sourceId',r.source_identifier,'candidate',r.metadata->>'candidate_name','party',r.metadata->>'party') ORDER BY r.share DESC) FROM poll_responses r WHERE r.question_id=q.id) AS responses,
    count(*) OVER()::int AS total
    FROM current q JOIN polls p ON p.id=q.poll_id JOIN pollsters ps ON ps.id=p.pollster_id JOIN geographies g ON g.id=q.geography_id JOIN data_sources s ON s.id=q.source_id JOIN source_artifacts a ON a.id=q.source_artifact_id
    ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY q.field_end DESC,q.id LIMIT $${params.length+1} OFFSET $${params.length+2}`,[...params,limit,offset])).rows;
  res.json({data:{rows,total:rows[0]?.total||0,offset,limit}});
}
export async function listPublishedAverages(req,res) {
  const offset=Math.max(0,Math.min(100000,Math.trunc(Number(req.query.offset)||0)));
  const limit=Math.max(1,Math.min(2000,Math.trunc(Number(req.query.limit)||60)));
  const rows=(await db.query(`WITH current AS (SELECT DISTINCT ON(source_id,series_identifier,observed_on,response_label) * FROM published_poll_averages ORDER BY source_id,series_identifier,observed_on,response_label,recorded_at DESC,id DESC)
    SELECT c.id,c.series_identifier,c.observed_on::text,c.response_label,c.share,c.metadata,s.name AS source,s.homepage_url AS source_url,a.license,count(*) OVER()::int AS total FROM current c JOIN data_sources s ON s.id=c.source_id JOIN source_artifacts a ON a.id=c.source_artifact_id ORDER BY observed_on DESC,response_label LIMIT $1 OFFSET $2`,[limit,offset])).rows;
  res.json({data:{rows,total:rows[0]?.total||0,offset,limit}});
}

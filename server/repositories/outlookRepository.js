import {all} from '../db.js';
export async function getOutlook(req,res) {
  const office=String(req.query.office||'us_senate'),cycle=Number(req.query.cycle||2026);
  if(!['us_senate','us_house','governor','president'].includes(office)||!Number.isInteger(cycle)||cycle<1900||cycle>2100) return res.status(400).json({error:'Choose a supported office and cycle.'});
  const [polls,states,districts,averages]=await Promise.all([
    all(`WITH current AS (SELECT DISTINCT ON(source_id,source_identifier) * FROM poll_questions WHERE source_identifier IS NOT NULL ORDER BY source_id,source_identifier,recorded_at DESC,id DESC)
    SELECT q.id,q.polling_race_id AS race_id,q.question_kind AS kind,q.office_slug AS office,q.cycle,q.stage,q.field_start::text,q.field_end::text,q.sample_size,q.population,
    q.metadata->>'seat_number' AS district,q.metadata->>'election_date' AS election_date,q.metadata->>'hypothetical' AS hypothetical,q.metadata->>'subpopulation' AS subpopulation,
    q.metadata->>'ranked_choice_round' AS ranked_choice_round,q.metadata->>'ranked_choice_reallocated' AS ranked_choice_reallocated,q.metadata->>'created_at' AS created_at,
    q.metadata->>'url' AS url,q.metadata->>'partisan' AS partisan,q.metadata->>'methodology' AS methodology,
    p.source_identifier AS survey_id,p.pollster_id,ps.name AS pollster,g.abbreviation AS state,g.name AS state_name,g.state_fips,
    s.name AS source,a.license,
    (SELECT jsonb_agg(jsonb_build_object('label',r.response_label,'candidate',r.metadata->>'candidate_name','share',r.share,'party',r.metadata->>'party','sourceId',r.source_identifier) ORDER BY r.share DESC) FROM poll_responses r WHERE r.question_id=q.id) AS responses
    FROM current q JOIN polls p ON p.id=q.poll_id JOIN pollsters ps ON ps.id=p.pollster_id JOIN geographies g ON g.id=q.geography_id JOIN data_sources s ON s.id=q.source_id JOIN source_artifacts a ON a.id=q.source_artifact_id
    WHERE (q.office_slug=$1 AND q.cycle=$2) OR (q.question_kind='generic_ballot' AND q.cycle=$2) OR q.question_kind='approval'
    ORDER BY q.field_end DESC,q.id`,[office,cycle]),
    all(`SELECT abbreviation AS state,name,state_fips FROM geographies WHERE geography_type='state' ORDER BY name`),
    office==='us_house'?all(`SELECT DISTINCT g.abbreviation,g.state_fips FROM geographies g JOIN geography_versions v ON v.geography_id=g.id WHERE g.geography_type='congressional_district' AND v.valid_from<=make_date($1,11,3) AND (v.valid_to IS NULL OR v.valid_to>=make_date($1,11,3))`,[cycle]):[],
    all(`SELECT DISTINCT ON(source_id,series_identifier,observed_on,response_label) series_identifier,observed_on::text,response_label,share FROM published_poll_averages ORDER BY source_id,series_identifier,observed_on,response_label,recorded_at DESC,id DESC`)
  ]);
  res.json({data:{office,cycle,polls,states,districts,averages}});
}

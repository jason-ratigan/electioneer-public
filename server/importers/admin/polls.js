import { vestStates } from '../vest2020/states.js';
const population = { a:'adults',rv:'registered_voters',lv:'likely_voters' };
const one = async (db,sql,args=[]) => (await db.query(sql,args)).rows[0];

export async function storePolls(client,plan,context) {
  const {sourceId,artifactId,runId}=context;
  const report={newSurveys:0,existingSurveys:0,newQuestions:0,revisedQuestions:0,unchangedQuestions:0,responses:0,newAverages:0,revisedAverages:0,unchangedAverages:0,unresolvedGeographies:[],candidateMapping:'NYT candidate_id retained as a namespaced response identity. No inferred match to official people or ballot choices.',sourceCandidateIdentities:new Set(plan.questions.flatMap(q=>q.responses.map(r=>r.key).filter(k=>k.startsWith('nyt:candidate:')))).size,unlinkedRaces:[]};
  const geoCache=new Map(),pollCache=new Map(),pollsterCache=new Map(),raceCache=new Map();
  async function geography(state) {
    if(geoCache.has(state)) return geoCache.get(state);
    const definition=vestStates.find(s=>s.abbreviation===state);
    if(state!=='US' && !definition) throw new Error(`Unresolved geography ${state}`);
    const g=await one(client,`INSERT INTO geographies(geography_type,name,abbreviation,state_fips)
      VALUES($1,$2,$3,$4) ON CONFLICT(geography_type,state_fips,county_fips,name) DO UPDATE SET name=geographies.name RETURNING id`,
    [state==='US'?'nation':'state',definition?.name||'United States',state,definition?.stateFips||null]);
    geoCache.set(state,g.id);return g.id;
  }
  for(const q of plan.questions) {
    const previous=await one(client,`SELECT id,content_sha256 FROM poll_questions WHERE source_id=$1 AND source_identifier=$2 ORDER BY recorded_at DESC,id DESC LIMIT 1`,[sourceId,q.key]);
    if(previous?.content_sha256===q.hash) {report.unchangedQuestions++;continue;}
    const geoId=await geography(q.state);
    if(!pollsterCache.has(q.pollsterKey)) {
      const p=await one(client,`INSERT INTO pollsters(name,source_id,source_identifier,metadata) VALUES($1,$2,$3,$4)
        ON CONFLICT(source_id,source_identifier) DO UPDATE SET name=pollsters.name RETURNING id`,[q.metadata.pollster,sourceId,q.pollsterKey,JSON.stringify({rawSourceId:q.metadata.pollster_id})]);
      pollsterCache.set(q.pollsterKey,p.id);
    }
    if(!pollCache.has(q.pollKey)) {
      let p=await one(client,'SELECT id FROM polls WHERE source_id=$1 AND source_identifier=$2',[sourceId,q.pollKey]);
      if(p) report.existingSurveys++;
      else {
        p=await one(client,`INSERT INTO polls(pollster_id,source_artifact_id,geography_id,field_start,field_end,population,mode,sponsor,source_id,source_identifier,metadata)
          VALUES($1,$2,$3,$4,$5,'other',$6,$7,$8,$9,$10) RETURNING id`,[pollsterCache.get(q.pollsterKey),artifactId,geoId,q.start,q.end,q.metadata.methodology,q.metadata.sponsors,sourceId,q.pollKey,JSON.stringify({questionLevelSampling:true})]);
        report.newSurveys++;
      }
      pollCache.set(q.pollKey,p.id);
    }
    let raceId=null,contestId=null;
    if(q.raceKey) {
      if(!raceCache.has(q.raceKey)) {
        const race=await one(client,`INSERT INTO polling_races(source_id,source_identifier) VALUES($1,$2) ON CONFLICT(source_id,source_identifier) DO UPDATE SET source_identifier=polling_races.source_identifier RETURNING id`,[sourceId,q.raceKey]);
        raceCache.set(q.raceKey,race.id);
      }
      raceId=raceCache.get(q.raceKey);
      // Only unique exact source date/scope mappings. Never infer primary party from candidate party.
      if(q.kind==='election' && q.metadata.election_date && q.stage==='general' && q.office!=='us_house') {
        const matches=await client.query(`SELECT c.id FROM contests c JOIN election_events e ON e.id=c.election_id JOIN offices o ON o.id=c.office_id
          WHERE e.cycle=$1 AND e.stage=$2 AND e.end_date=$3 AND o.slug=$4 AND c.district_geography_id=$5 AND NOT COALESCE((c.metadata->>'special')::boolean,false)`,[q.cycle,q.stage,q.metadata.election_date,q.office,geoId]);
        if(matches.rows.length===1) contestId=matches.rows[0].id;
      }
      if(!contestId && q.kind==='election') report.unlinkedRaces.push(q.raceKey);
    }
    const question=await one(client,`INSERT INTO poll_questions(poll_id,contest_id,sample_size,source_id,source_identifier,source_artifact_id,ingestion_run_id,revision_of_question_id,content_sha256,question_kind,polling_race_id,geography_id,field_start,field_end,population,cycle,office_slug,stage,metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
    [pollCache.get(q.pollKey),contestId,q.sample,sourceId,q.key,artifactId,runId,previous?.id||null,q.hash,q.kind,raceId,geoId,q.start,q.end,population[q.population]||'other',q.cycle,q.office,q.stage,JSON.stringify(q.metadata)]);
    for(const response of q.responses) {
      await client.query(`INSERT INTO poll_responses(question_id,response_label,share,source_identifier,metadata) VALUES($1,$2,$3,$4,$5)`,[question.id,response.answer,response.share,response.key,JSON.stringify(response.raw)]);
      report.responses++;
    }
    if(previous) report.revisedQuestions++; else report.newQuestions++;
    if((report.newQuestions+report.revisedQuestions)%100===0) await context.progress?.(`Stored ${report.newQuestions+report.revisedQuestions} questions`);
  }
  for(const a of plan.averages) {
    const previous=await one(client,`SELECT id,share FROM published_poll_averages WHERE source_id=$1 AND series_identifier=$2 AND observed_on=$3 AND response_label=$4 ORDER BY recorded_at DESC,id DESC LIMIT 1`,[sourceId,a.series,a.date,a.answer]);
    if(previous && Number(previous.share)===a.share) {report.unchangedAverages++;continue;}
    await client.query(`INSERT INTO published_poll_averages(source_id,source_artifact_id,ingestion_run_id,series_identifier,observed_on,response_label,share,revision_of_id,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[sourceId,artifactId,runId,a.series,a.date,a.answer,a.share,previous?.id||null,JSON.stringify(a.raw)]);
    if(previous) report.revisedAverages++; else report.newAverages++;
  }
  report.unlinkedRaces=[...new Set(report.unlinkedRaces)];
  return report;
}

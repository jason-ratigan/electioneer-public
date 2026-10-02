import {test} from 'node:test';
import assert from 'node:assert/strict';
import {availableOn,visiblePolls,pollingLead,category,controlSummary,mappedSeat} from '../outlook/model.js';
import {officeholderBaseline} from '../outlook/baseline.js';
const poll=(id,changes={})=>({id,survey_id:id,pollster_id:id,field_end:'2026-09-01',stage:'general',kind:'election',office:'us_house',state:'PA',district:'1',population:'likely_voters',responses:[{label:'Democrat',sourceId:'d',party:'DEM',share:48},{label:'Republican',sourceId:'r',party:'REP',share:44},{label:'Undecided',party:'NONE',share:8}],...changes});
test('mapping distinguishes national opinion, states, numbered districts, and at-large seats',()=>{
  const districts=[{abbreviation:'PA-01'},{abbreviation:'AK-AL'}];
  assert.equal(mappedSeat(poll('a'),districts),'PA-01');
  assert.equal(mappedSeat(poll('a',{state:'AK'}),districts),'AK-AL');
  assert.equal(mappedSeat(poll('a',{state:'AK',district:'0'}),districts),'AK-AL');
  assert.equal(mappedSeat(poll('a',{district:'99'}),districts),null);
  assert.equal(mappedSeat(poll('a',{district:''}),districts),null);
  assert.equal(mappedSeat(poll('a',{kind:'generic_ballot',state:'US'}),districts),null);
  assert.equal(mappedSeat(poll('a',{kind:'approval'}),districts),null);
  assert.equal(mappedSeat(poll('a',{office:'us_senate'}),districts),'PA');
  assert.equal(mappedSeat(poll('a',{state:'DC'}),districts),null);
});
test('cutoff respects both fieldwork completion and source creation date',()=>{
  const q=poll('a',{created_at:'9/10/26 08:00'});
  assert.equal(availableOn(q),'2026-09-10');
  assert.equal(visiblePolls([q],'2026-09-09').length,0);
  assert.equal(visiblePolls([q],'2026-09-10').length,1);
  assert.equal(availableOn(poll('b',{created_at:'8/31/2026 08:00'})),'2026-09-01');
  assert.equal(pollingLead([poll('future',{field_end:'2026-10-01'})],'2026-09-28').count,0);
});
test('population variants and repeated surveys from a pollster cannot add weight',()=>{
  const qs=[poll('rv',{survey_id:'same',pollster_id:'one',population:'registered_voters'}),poll('lv',{survey_id:'same',pollster_id:'one'}),poll('old',{pollster_id:'one',field_end:'2026-08-20'}),poll('two')];
  const result=pollingLead(qs,'2026-09-28');
  assert.deepEqual(result.questionIds.sort(),['lv','two']);
  assert.ok(Math.abs(result.margin-4)<1e-10);
  assert.ok(Math.abs(result.d-48)<1e-10);assert.ok(Math.abs(result.r-44)<1e-10);
});
test('distinct candidate pairs are never blended',()=>{
  const alternate=poll('alternate',{field_end:'2026-09-02',responses:[{label:'Other Democrat',sourceId:'d2',party:'DEM',share:40},{label:'Republican',sourceId:'r',party:'REP',share:50}]});
  const result=pollingLead([poll('first'),alternate],'2026-09-28');
  assert.equal(result.count,1);assert.equal(result.matchup.key,'d2|r');assert.ok(Math.abs(result.margin+10)<1e-10);
  assert.equal(pollingLead([poll('first'),alternate],'2026-09-28','d|r').count,1);
});
test('hypotheticals, primaries, old polls, subpopulations, RCV and ambiguous major-party fields stay out of leads',()=>{
  const rows=[poll('hyp',{hypothetical:'TRUE'}),poll('primary',{stage:'primary'}),poll('old',{field_end:'2026-06-01'}),poll('sub',{subpopulation:'Women'}),poll('ranked',{ranked_choice_round:'1'}),poll('multi',{responses:[...poll('x').responses,{label:'Second Democrat',party:'DEM',share:3}]}),poll('ind',{responses:[...poll('x').responses,{label:'Independent',party:'IND',share:50}]})];
  assert.equal(pollingLead(rows,'2026-09-28').margin,null);
  assert.equal(pollingLead(rows,'2026-09-28').excluded,7);
});
test('a poll becomes usable on its creation date and ages out after sixty days',()=>{
  const q=poll('a',{field_end:'2026-07-01',created_at:'7/05/26 10:00'});
  assert.equal(pollingLead([q],'2026-07-04').count,0);
  assert.equal(pollingLead([q],'2026-07-05').count,1);
  assert.equal(pollingLead([q],'2026-08-31').count,0);
});
test('control totals preserve unknown seats, exclude DC and deduplicate ambiguous seats',()=>{
  const races=[{seatKey:'PA-01',state:'PA',lead:{margin:4}},{seatKey:'PA-02',state:'PA',lead:{margin:-4}},{seatKey:'DC-AL',state:'DC',lead:{margin:90}}];
  assert.deepEqual(controlSummary(races),{D:1,R:1,other:0,competitive:0,unknown:433,total:435,majority:218,sources:{picked:0,polled:2,incumbent:0}});
  assert.equal(controlSummary([...races,races[0]]).D,0);
  const shifted=controlSummary(races,{swing:2,overrides:{'PA-01':'R'}});
  assert.equal(shifted.D,0);assert.equal(shifted.R,1);assert.equal(shifted.competitive,1);
  const senate=controlSummary([],{total:100,holdD:34,holdR:31});
  assert.equal(senate.unknown,35);assert.equal(senate.majority,51);
});
test('2026 current-holder snapshot reconciles all voting seats and holdovers',()=>{
  const house=officeholderBaseline('us_house',2026);
  assert.deepEqual(house.current,{D:214,R:218,I:1,vacant:2});
  assert.equal(Object.keys(house.seats).length,433);
  assert.equal(house.seats['FL-20'],undefined);
  assert.equal(house.seats['TX-23'],undefined);
  const senate=officeholderBaseline('us_senate',2026);
  assert.deepEqual(senate.current,{D:45,R:53,I:2,vacant:0});
  assert.deepEqual(senate.holdovers,{D:34,R:31,I:0});
  assert.equal(Object.keys(senate.seats).length,35);
  assert.equal(senate.holdoverSeats.CA.length,2);
  const governors=officeholderBaseline('governor',2026);
  assert.deepEqual(governors.current,{D:24,R:26,I:0,vacant:0});
  assert.deepEqual(governors.holdovers,{D:6,R:8,I:0});
  assert.equal(Object.keys(governors.seats).length,36);
  assert.equal(Object.keys(governors.holdoverSeats).length,14);
  assert.equal(officeholderBaseline('governor',2028),null);
});
test('a pick outranks polling, while polling outranks the current-holder assumption',()=>{
  const races=[
    {seatKey:'A-01',state:'A',lead:{margin:null},incumbent:{party:'D'}},
    {seatKey:'A-02',state:'A',lead:{margin:-4},incumbent:{party:'D'}},
    {seatKey:'A-03',state:'A',lead:{margin:null},incumbent:{party:'I'}}
  ];
  const defaultResult=controlSummary(races,{total:3});
  assert.deepEqual([defaultResult.D,defaultResult.R,defaultResult.other],[1,1,1]);
  assert.deepEqual(defaultResult.sources,{picked:0,polled:1,incumbent:2});
  const picked=controlSummary(races,{total:3,overrides:{'A-02':{party:'D',name:'Chosen candidate'}}});
  assert.equal(picked.D,2);assert.equal(picked.sources.picked,1);
  const noBaseline=controlSummary(races,{total:3,useBaseline:false});
  assert.equal(noBaseline.unknown,2);
});
test('category boundaries tolerate floating point arithmetic',()=>{
  assert.equal(category(2.999999999999997),'D');
  assert.equal(category(-2.999999999999997),'R');
  assert.equal(category(2.99),'competitive');assert.equal(category(null),'unknown');
});

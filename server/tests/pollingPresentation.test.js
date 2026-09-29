import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mapShade,responseColumns,trendDomain,approvalDomain} from '../../src/pollingPresentation.js';

test('map shades distinguish three strengths per party and respect scenario calls',()=>{
  for(const [margin,shade] of [[null,'unknown'],[0,'competitive'],[2.9,'competitive'],[3,'DLight'],[-3,'RLight'],[4.9,'DLight'],[5,'DMedium'],[-5,'RMedium'],[9.9,'DMedium'],[10,'D'],[-10,'R']])assert.equal(mapShade(margin),shade);
  assert.equal(mapShade(2.999999999999997),'DLight');
  assert.equal(mapShade(18,'competitive'),'competitive');
  assert.equal(mapShade(null,'R'),'R');
});
test('table preserves multiple candidates and undecided responses without summing or imputing shares',()=>{
  const responses=[{label:'A',party:'DEM',share:30},{label:'B',party:'DEM',share:12},{label:'C',party:'REP',share:40},{label:'Independent',party:'IND',share:7},{label:'Undecided',party:'NONE',share:8}];
  const cols=responseColumns(responses);
  assert.deepEqual(cols.D,responses.slice(0,2));assert.deepEqual(cols.R,[responses[2]]);assert.deepEqual(cols.other,responses.slice(3));
  assert.equal(cols.D[0].share,30);assert.equal(cols.other[1].share,8);
  assert.deepEqual(responseColumns([{label:'Unknown party',share:40}]).other,[{label:'Unknown party',share:40}]);
});
test('approval classification uses response labels, independent of series order or party metadata',()=>{
  const responses=[{label:'Disapprove',party:'DEM',share:53},{label:'Approve',party:'REP',share:41},{label:'Unsure',share:6}];
  const cols=responseColumns(responses,true);
  assert.deepEqual(cols.D,[responses[1]]);assert.deepEqual(cols.R,[responses[0]]);assert.deepEqual(cols.other,[responses[2]]);
});
test('chart axes fit narrow trends without hiding observations; approval starts at 25–75%',()=>{
  const domain=trendDomain([21,22,24,null]);assert.ok(domain[0]>0&&domain[0]<21);assert.ok(domain[1]>24&&domain[1]<30);
  const negative=trendDomain([-20,-22]);assert.ok(negative[1]<0&&negative[1]>-20);assert.ok(negative[0]<-22);
  const flat=trendDomain([0,0]);assert.ok(flat[0]<0&&flat[1]>0);
  assert.deepEqual(approvalDomain([41,53]),[25,75]);
  assert.deepEqual(approvalDomain([20,80]),[20,80]);
  assert.deepEqual(trendDomain([]),[-3,3]);
});

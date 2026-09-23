import assert from 'node:assert/strict';
import {addConferenceWatches,normalizeSourceUrls,trackingKey,watchSuggestions} from './conference-tracking.ts';
import {emptyPlanning} from './planning-types.ts';
import {validatePlanning} from './planning-validation.ts';

const orgs=[{id:'alpha',name:'Alpha Association'},{id:'beta',name:'Beta Association'}].map(org=>({...org,state:'IN',sector:'K-12',type:'Association',aliases:[]}));
const benefit=(program='Alpha Annual Conference',extra={})=>({id:'benefit',organizationIds:['alpha'],sourceOrganization:'Alpha Association',program,sources:['https://example.org/conference'],paymentRows:[41],...extra});
const expense=(sourceRow,description,organizationId='alpha')=>({sourceRow,description,eventYear:2026,allocations:[{organizationId,amountCents:100}]});
const draft=(name='Alpha Annual Conference',extra={})=>({organizationId:'alpha',name,sourceUrls:['https://example.org/conference'],searchTerms:name,enabled:true,...extra});
let tests=0,counter=0;
const test=(name,fn)=>{fn();tests++;console.log('PASS '+name)};
const id=()=>'watch-'+(++counter);

test('new suggested conference is appended to an empty tracker',()=>{
  const result=addConferenceWatches([], [draft()],id);
  assert.equal(result.watches.length,1);assert.equal(result.added.length,1);assert.equal(result.watches[0].enabled,true);
  assert.equal(watchSuggestions(orgs,[benefit()],[],result.watches).length,0);
});
test('batch adds sourced and missing-source suggestions without inventing monitoring',()=>{
  const result=addConferenceWatches([], [draft(),draft('Beta Forum',{organizationId:'beta',sourceUrls:[]})],id);
  assert.deepEqual(result.added.map(x=>x.enabled),[true,false]);
  const planning={...emptyPlanning(),watches:result.watches};
  assert.equal(validatePlanning(planning,orgs.map(o=>o.id)).watches.length,2);
});
test('existing watches and explicit pauses stay unchanged',()=>{
  const existing={id:'existing',...draft('Other conference',{enabled:false})};const before=structuredClone(existing);
  const result=addConferenceWatches([existing],[draft('Ready conference',{enabled:false})],id);
  assert.deepEqual(existing,before);assert.equal(result.watches[0],existing);assert.equal(result.added[0].enabled,false);
});
test('same organization and normalized names deduplicate existing watches and batch entries',()=>{
  const original={id:'first',...draft()};
  const result=addConferenceWatches([original],[draft('  ALPHA   Annual Conference '),draft('Another Conference'),draft('another conference'),draft('Alpha Annual Conference',{organizationId:'beta'})],id);
  assert.equal(result.skipped,2);assert.equal(result.added.length,2);assert.equal(result.watches.length,3);
  assert.equal(trackingKey('alpha','Ａlpha Conference'),trackingKey('alpha','alpha conference'));
});
test('source addresses normalize, deduplicate and preserve distinct pages',()=>{
  assert.deepEqual(normalizeSourceUrls(' https://EXAMPLE.org\nhttps://example.org/\n\nhttps://example.org/event '),['https://example.org/','https://example.org/event']);
});
test('unsafe, malformed and excessive source links fail with actionable errors',()=>{
  for(const url of ['javascript:alert(1)','file:///tmp/x','https://name:password@example.org','https://example.org/a b','https://example.org/'+ 'x'.repeat(2000)])assert.throws(()=>normalizeSourceUrls([url]),/source links/);
  assert.throws(()=>normalizeSourceUrls(Array.from({length:21},(_,i)=>'https://example.org/'+i)),/20 official/);
});
test('a bad selected item cannot partly mutate or save the batch',()=>{
  const existing=[{id:'first',...draft('Original conference')}],before=structuredClone(existing);
  assert.throws(()=>addConferenceWatches(existing,[draft(),draft('Broken conference',{sourceUrls:['not-a-url']})],id),/source links/);
  assert.deepEqual(existing,before);
});
test('tracker limit applies after deduplication and includes paused entries',()=>{
  const watches=Array.from({length:500},(_,i)=>({id:'existing-'+i,...draft('Conference '+i,{enabled:false})}));
  assert.equal(addConferenceWatches(watches,[draft('Conference 0')],id).watches.length,500);
  assert.throws(()=>addConferenceWatches(watches,[draft('New conference')],id),/500 conferences/);
  assert.equal(watches.length,500);
});
test('invalid names, search terms and generated IDs cannot produce silent success',()=>{
  assert.throws(()=>addConferenceWatches([],[draft(' ')]),/conference name/);
  assert.throws(()=>addConferenceWatches([],[draft('x'.repeat(501))]),/500 characters/);
  assert.throws(()=>addConferenceWatches([],[draft('Conference',{searchTerms:'x'.repeat(1001)})]),/1,000/);
  assert.throws(()=>addConferenceWatches([{id:'same',...draft('First conference')}],[draft()],()=>'same'),/ID/);
});
test('explicit research links consolidate spending rows without guessing other programs',()=>{
  const rows=[expense(41,'2026 Annual Conference Sponsorship'),expense(42,'Regional Leadership Forum'),expense(41,'Beta Conference','beta')];
  const suggestions=watchSuggestions(orgs,[benefit()],rows,[]);
  assert.deepEqual(suggestions.map(x=>x.name),['Alpha Annual Conference','Regional Leadership Forum','Beta Conference']);
  assert.equal(suggestions[1].sourceUrls.length,0);
});
test('a tracked researched program also suppresses its linked spending descriptions',()=>{
  const suggestions=watchSuggestions(orgs,[benefit()],[expense(41,'2026 Annual Conference Sponsorship')],[{id:'tracked',...draft()}]);
  assert.deepEqual(suggestions,[]);
});
test('duplicate research merges sources and drops invalid old URLs without enabling them',()=>{
  const suggestions=watchSuggestions(orgs,[benefit(),benefit(' alpha   annual conference ',{sources:['https://example.org/sponsor','javascript:alert(1)']})],[],[]);
  assert.equal(suggestions.length,1);assert.deepEqual(suggestions[0].sourceUrls,['https://example.org/conference','https://example.org/sponsor']);
});
test('renamed reviewed suggestions stay out of the queue on subsequent loads',()=>{
  const watch={id:'tracked',...draft('Alpha NCE',{searchTerms:'Alpha Annual Conference'})};
  assert.equal(watchSuggestions(orgs,[benefit()],[],[watch]).length,0);
});
test('old or missing organizations and non-conference programs are excluded',()=>{
  assert.equal(watchSuggestions(orgs,[benefit('Membership dues'),benefit(undefined,{organizationIds:['deleted']})],[],[]).length,0);
});
test('long historical names fit the saved watch contract and keep a valid Unicode boundary',()=>{
  const suggestions=watchSuggestions(orgs,[benefit('Conference '+'x'.repeat(488)+'😀')],[],[]);
  assert.equal(suggestions[0].name.length,499);
  const result=addConferenceWatches([],suggestions.map(s=>draft(s.name,{sourceUrls:s.sourceUrls})),id);
  assert.equal(validatePlanning({...emptyPlanning(),watches:result.watches},orgs.map(o=>o.id)).watches.length,1);
});
console.log(`\n${tests} conference-tracking checks passed.`);

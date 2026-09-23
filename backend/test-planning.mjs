import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';

// Synthetic fixtures only; these tests never contact Supabase or modify the ledger.
const db=new PGlite();
let passed=0;
const pass=label=>{passed++;console.log(`PASS ${label}`);};
const clone=value=>structuredClone(value);
const ids={owner:'00000000-0000-0000-0000-000000000001',editor:'00000000-0000-0000-0000-000000000002',viewer:'00000000-0000-0000-0000-000000000003',outsider:'00000000-0000-0000-0000-000000000004'};
await db.exec(`create role anon; create role authenticated; create role service_role;
  create schema auth; create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
  create function auth.role() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.role',true),'') $$;
  grant usage on schema auth to anon,authenticated,service_role;
  grant execute on all functions in schema auth to anon,authenticated,service_role;`);
const legacySql=await readFile(new URL('./supabase.sql',import.meta.url),'utf8');
const planningSql=await readFile(new URL('./planning.sql',import.meta.url),'utf8');
await db.exec(legacySql);await db.exec(planningSql);await db.exec(planningSql);
for(const id of Object.values(ids))await db.query('insert into auth.users(id) values($1)',[id]);
for(const role of ['owner','editor','viewer'])await db.query('insert into public.workspace_members(workspace_id,user_id,role) values($1,$2,$3)',['core-midwest',ids[role],role]);
const org={id:'org-a',name:'Example schools',sector:'K-12',type:'School',state:'IN',aliases:[]};
const payment={id:'PAY-1',sourceRow:1,payee:'Example schools',description:'2026 conference sponsorship',amountCents:20000,originalAmountCents:20000,eventYear:2026,approvalYear:2025,approvalDate:'2025-12-15',sector:'K-12',type:'Sponsorship',state:'IN',allocations:[],confidence:'direct',reason:'Synthetic fixture',note:'',reviewed:false,revision:0};
const ledger={organizations:[org],payments:[payment],benefits:[],meta:{source:'Synthetic',researchAsOf:'2026-09-23',note:'Test only'}};
await db.query('insert into public.workspace_state(workspace_id,payload,revision) values($1,$2,1)',['core-midwest',JSON.stringify(ledger)]);
const stamp='2026-09-23T12:00:00.000Z';
const empty=()=>({expenseYears:[],profiles:[],events:[],watches:[],discoveries:[],settings:{enabled:false,intervalDays:14,nextRunAt:'',lastRunAt:''},runs:[]});
const event=()=>({id:'event-a',organizationId:'org-a',title:'School leadership conference',startDate:'2026-10-10',endDate:'2026-10-11',location:'Indianapolis',state:'IN',sector:'K-12',website:'https://example.org/events',description:'Annual conference',sponsorshipLevel:'Gold',estimatedCostCents:120000,decision:'needs_review',decisionNotes:'',invoice:{status:'not_received',amountCents:null,reference:'',paidOn:'',confirmedBy:'',note:''},tasks:[{id:'task-a',title:'Book booth',owner:'Organizer',dueDate:'2026-10-01',done:false}],plan:{objectives:'Meet school leaders',audience:'',attendees:'',logistics:'',materials:'',followUp:''},debrief:{completedOn:'',attendance:'',meetings:'',leads:'',opportunities:'',whatWorked:'',improvements:'',followUp:'',notes:''},sourceDiscoveryId:'',createdAt:stamp,updatedAt:stamp});
const profile={...org,name:'Updated school organization',description:'Local district',website:'https://example.org',contactName:'School team',contactEmail:'school@example.org',contactPhone:'555-0100',logoUrl:'data:image/png;base64,aGVsbG8=',updatedAt:stamp};
const watch={id:'watch-a',organizationId:'org-a',name:'Annual education conference',sourceUrls:['https://example.org/events'],searchTerms:'education conference',enabled:true};
const candidate=(id='suggestion-a',fingerprint='conference-2027')=>({id,watchId:'watch-a',organizationId:'org-a',title:'Annual education conference 2027',startDate:'2027-05-01',endDate:'2027-05-02',location:'Conference center',state:'IN',url:'https://example.org/events/2027',summary:'Organizer published next year’s date. Review before deciding.',sponsorshipDetails:'Gold package details await confirmation',evidence:[{url:'https://example.org/events/2027',excerpt:'Annual education conference 2027: May 1–2.'}],fingerprint,firstSeenAt:stamp,lastSeenAt:stamp,status:'new',eventId:''});
const run=(id='run-a')=>({id,startedAt:stamp,finishedAt:stamp,status:'success',pagesChecked:1,candidatesFound:1,message:'One organizer page checked.'});
async function as(who,operation){
  const role=who==='service'?'service_role':who==='anon'?'anon':'authenticated';
  await db.exec('begin');
  try{await db.exec(`set local role ${role}`);await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role',$2,true)",[ids[who]??'',role]);const result=await operation();await db.exec('commit');return result;}
  catch(error){await db.exec('rollback');throw error;}
}
const rpc=(who,name,args)=>as(who,async()=>{const params=args.map((_,i)=>`$${i+1}`).join(',');return(await db.query(`select public.${name}(${params}) result`,args.map(arg=>typeof arg==='object'?JSON.stringify(arg):arg))).rows[0].result;});
const get=(who='owner')=>rpc(who,'core_get_planning',['core-midwest']);
const save=(who,data,revision)=>rpc(who,'core_save_planning',['core-midwest',data,revision]);
const ingest=(candidates,r=run())=>rpc('service','core_ingest_discoveries',['core-midwest',candidates,r]);
const denied=async(label,operation,code='PT422')=>{await assert.rejects(operation,error=>error.code===code,label);pass(label);};
await denied('anonymous cannot read planning',()=>get('anon'),'42501');
await denied('nonmember cannot read planning',()=>get('outsider'),'PT403');
assert.deepEqual(await get(),{data:empty(),revision:0,role:'owner'});pass('new planning returns usable empty workspace');
await denied('viewer cannot save planning',()=>save('viewer',empty(),0),'PT403');
await denied('nonmember cannot save planning',()=>save('outsider',empty(),0),'PT403');
await denied('direct planning write prohibited',()=>as('owner',()=>db.exec("insert into public.workspace_planning(workspace_id,payload) values('core-midwest','{}')")),'42501');
await denied('browser cannot read service context',()=>rpc('owner','core_discovery_context',['core-midwest']),'42501');
await denied('browser cannot ingest suggestions',()=>rpc('editor','core_ingest_discoveries',['core-midwest',[],run()]),'42501');
await denied('anonymous cannot use private helper',()=>as('anon',()=>db.exec('select core_planning_private.empty_data()')),'42501');
let data=empty();data.profiles=[profile];data.events=[event()];data.watches=[watch];data.settings.enabled=true;
let state=await save('editor',data,0);assert.equal(state.revision,1);pass('editor initializes profile, event and watch without ledger reimport');
data=clone(state.data);data.expenseYears=[{paymentId:'PAY-1',year:2027}];
await denied('viewer cannot change applicable year',()=>save('viewer',data,state.revision),'PT403');
state=await save('editor',data,state.revision);assert.equal(state.data.expenseYears[0].year,2027);pass('editor assigns applicable year independently of source year');
data=clone(state.data);data.expenseYears[0].year=null;state=await save('owner',data,state.revision);assert.equal(state.data.expenseYears[0].year,null);pass('owner can explicitly mark applicable year unknown');
data=clone(state.data);data.expenseYears=[];state=await save('editor',data,state.revision);assert.equal(state.data.expenseYears.length,0);pass('removing override restores inferred source year without changing source');
data=clone(state.data);data.expenseYears=[{paymentId:'PAY-1',year:2027}];state=await save('editor',data,state.revision);
for(const[label,years]of [
  ['duplicate applicable year',[{paymentId:'PAY-1',year:2027},{paymentId:'PAY-1',year:2028}]],
  ['missing expense reference',[{paymentId:'missing',year:2027}]],
  ['applicable year below range',[{paymentId:'PAY-1',year:1899}]],
  ['applicable year above range',[{paymentId:'PAY-1',year:2201}]],
  ['fractional applicable year',[{paymentId:'PAY-1',year:2027.5}]],
  ['string applicable year',[{paymentId:'PAY-1',year:'2027'}]],
  ['unexpected expense year property',[{paymentId:'PAY-1',year:2027,amountCents:1}]],
]){const invalid=clone(state.data);invalid.expenseYears=years;await denied(label,()=>save('editor',invalid,state.revision));}
assert.deepEqual((await db.query("select payload->'payments' payments from public.workspace_state where workspace_id='core-midwest'")).rows[0].payments,[payment]);pass('year edits preserve amount, inferred event year, approval year and approval date');
assert.equal((await get('viewer')).data.profiles[0].name,profile.name);pass('viewer can read profiles and events');
const hidden=await as('outsider',()=>db.query('select * from public.workspace_planning'));assert.equal(hidden.rows.length,0);pass('planning table RLS hides other workspaces');
await denied('stale browser cannot overwrite planning',()=>save('owner',data,0),'PT409');
const invalidCases=[
  ['bad calendar date',d=>d.events[0].startDate='2026-02-30'],
  ['date with a timestamp',d=>d.events[0].startDate=stamp],
  ['end before start',d=>d.events[0].endDate='2026-01-01'],
  ['end without start',d=>d.events[0].startDate=''],
  ['missing organization',d=>d.events[0].organizationId='missing'],
  ['unknown profile reference',d=>d.profiles[0].id='missing'],
  ['unknown watch reference',d=>d.watches[0].organizationId='missing'],
  ['duplicate event',d=>d.events.push(clone(d.events[0]))],
  ['duplicate profile',d=>d.profiles.push(clone(d.profiles[0]))],
  ['duplicate watch',d=>d.watches.push(clone(d.watches[0]))],
  ['duplicate task',d=>d.events[0].tasks.push(clone(d.events[0].tasks[0]))],
  ['empty event title',d=>d.events[0].title='  '],
  ['empty profile name',d=>d.profiles[0].name=''],
  ['fractional cents',d=>d.events[0].estimatedCostCents=5.5],
  ['negative invoice',d=>d.events[0].invoice.amountCents=-1],
  ['zero estimate',d=>d.events[0].estimatedCostCents=0],
  ['unsafe website',d=>d.profiles[0].website='javascript:alert(1)'],
  ['unsafe source',d=>d.watches[0].sourceUrls=['file:///etc/passwd']],
  ['credentialed URL',d=>d.events[0].website='https://user:password@example.org/'],
  ['SVG logo rejected',d=>d.profiles[0].logoUrl='data:image/svg+xml;base64,PHN2Zz4='],
  ['insecure logo URL rejected',d=>d.profiles[0].logoUrl='http://example.org/logo.png'],
  ['oversize logo',d=>d.profiles[0].logoUrl='data:image/png;base64,'+'a'.repeat(220000)],
  ['unknown root field',d=>d.payments=[]],
  ['unknown invoice field',d=>d.events[0].invoice.fake='claim'],
  ['paid confirmation missing date',d=>{d.events[0].invoice={status:'paid',amountCents:100,reference:'Ref',paidOn:'',confirmedBy:'Brice',note:''};}],
  ['paid confirmation missing name',d=>{d.events[0].invoice={status:'paid',amountCents:100,reference:'Ref',paidOn:'2026-09-23',confirmedBy:'',note:''};}],
  ['paid confirmation missing evidence',d=>{d.events[0].invoice={status:'paid',amountCents:100,reference:'',paidOn:'2026-09-23',confirmedBy:'Brice',note:''};}],
  ['changed event origin',d=>d.events[0].createdAt='2025-01-01T00:00:00Z'],
  ['removed event',d=>d.events=[]],
  ['forged schedule date',d=>d.settings.nextRunAt=stamp],
  ['wrong recurrence interval',d=>d.settings.intervalDays=7],
  ['forged run',d=>d.runs=[run()]],
  ['forged browser discovery',d=>d.discoveries=[candidate()]],
];
for(const[label,mutate]of invalidCases){const invalid=clone(state.data);mutate(invalid);await denied(label,()=>save('editor',invalid,state.revision));}
data=clone(state.data);data.events[0].decision='attend_and_sponsor';data.events[0].decisionNotes='Approved by editor';data.events[0].invoice={status:'paid',amountCents:120000,reference:'Invoice 100',paidOn:'2026-09-23',confirmedBy:'Test editor',note:'Manually confirmed'};
state=await save('editor',data,state.revision);pass('editor can approve sponsorship and manually confirm payment');
data=clone(state.data);data.events[0].tasks[0].done=true;data.events[0].debrief.notes='Productive follow-up conversations';data.events[0].debrief.completedOn='2026-10-12';state=await save('owner',data,state.revision);pass('owner can save planning tasks and debrief');
const beforeSearch=clone(state);
state=await ingest([candidate()]);assert.equal(state.data.discoveries.length,1);assert.equal(state.data.runs.length,1);assert.deepEqual(state.data.events,beforeSearch.data.events);
assert.equal(Date.parse(state.data.settings.nextRunAt)-Date.parse(state.data.settings.lastRunAt),14*24*60*60*1000);pass('scheduled ingest adds source evidence, keeps paid event, and schedules exactly fourteen days later');
await denied('background search makes old browser revision stale',()=>save('editor',beforeSearch.data,beforeSearch.revision),'PT409');
assert.equal((await get()).data.discoveries.length,1);pass('stale save preserves pending search discoveries');
let accepted=clone(state.data),acceptedEvent=event();acceptedEvent.id='accepted-event';acceptedEvent.sourceDiscoveryId='suggestion-a';acceptedEvent.title=accepted.discoveries[0].title;acceptedEvent.startDate='2027-05-01';acceptedEvent.endDate='2027-05-02';accepted.events.push(acceptedEvent);accepted.discoveries[0].status='accepted';accepted.discoveries[0].eventId='accepted-event';state=await save('editor',accepted,state.revision);pass('editor accepts researched proposal into linked event');
for(const[label,mutate]of [
  ['edited discovery evidence',d=>d.discoveries[0].evidence[0].excerpt='Forged sponsor promise'],
  ['deleted discovery',d=>d.discoveries=[]],
  ['accepted suggestion missing event',d=>d.discoveries[0].eventId='missing'],
  ['accepted suggestion wrong source event',d=>d.discoveries[0].eventId='event-a'],
  ['event source changed',d=>d.events[1].sourceDiscoveryId=''],
]){const invalid=clone(state.data);mutate(invalid);await denied(label,()=>save('owner',invalid,state.revision));}
const approved=clone(state.data);let repeated=candidate();repeated.title='Changed unreviewed title';repeated.startDate='2027-06-01';repeated.endDate='2027-06-02';state=await ingest([repeated],run('run-b'));
assert.equal(state.data.discoveries.length,1);assert.equal(state.data.discoveries[0].status,'accepted');assert.equal(state.data.discoveries[0].eventId,'accepted-event');assert.equal(state.data.discoveries[0].title,approved.discoveries[0].title);assert.equal(state.data.discoveries[0].firstSeenAt,approved.discoveries[0].firstSeenAt);assert.deepEqual(state.data.events,approved.events);pass('dedup preserves original evidence, accepted review, planning and payments');
const revision=state.revision;state=await ingest([repeated],run('run-b'));assert.equal(state.revision,revision);pass('retry of the same run is idempotent');
const bad=candidate('bad','bad');bad.organizationId='missing';await denied('ingest rejects unknown organization',()=>ingest([bad],run('bad-run')));
const noEvidence=candidate('bad','bad');noEvidence.evidence=[];await denied('ingest requires source evidence',()=>ingest([noEvidence],run('bad-run')));
const unsafe=candidate('bad','bad');unsafe.url='javascript:alert(1)';await denied('ingest requires safe source URLs',()=>ingest([unsafe],run('bad-run')));
await denied('duplicate batch candidates rejected',()=>ingest([candidate(),candidate()],run('bad-run')));
const idCollision=candidate('suggestion-a','different-fingerprint');await denied('new fingerprint cannot collide on discovery ID',()=>ingest([idCollision],run('bad-run')));
const forgedRun=run('bad-run');forgedRun.status='invented';await denied('invalid run rejected atomically',()=>ingest([candidate('other','other')],forgedRun));
assert.equal((await get()).revision,state.revision);pass('invalid ingestion leaves current planning unchanged');
for(let i=0;i<31;i++)state=await ingest([],run(`retention-${i}`));assert.equal(state.data.runs.length,30);assert.equal(state.data.runs[0].id,'retention-30');pass('search history retains most recent thirty runs');
data=clone(state.data);data.settings.enabled=false;state=await save('editor',data,state.revision);await denied('disabled search rejects server ingestion',()=>ingest([],run('disabled')),'PT409');
const context=await rpc('service','core_discovery_context',['core-midwest']);assert.equal(context.data.settings.enabled,false);assert.ok(!('payments'in context.data));pass('server context has planning only, no spending ledger');
const ledgerAfter=(await db.query("select payload,revision from public.workspace_state where workspace_id='core-midwest'")).rows[0];assert.deepEqual(ledgerAfter.payload,ledger);assert.equal(ledgerAfter.revision,1);pass('profiles, approvals, invoice confirmations and discovery never mutate ledger');
const missingOrg=clone(ledger);missingOrg.organizations=[];
await denied('legacy import cannot remove organization referenced by planning',()=>rpc('owner','core_save_workspace',['core-midwest',missingOrg,1,'import']));
const missingPayment=clone(ledger);missingPayment.payments=[];
await denied('legacy import cannot remove expense referenced by applicable year',()=>rpc('owner','core_save_workspace',['core-midwest',missingPayment,1,'import']));
await denied('administrative ledger deletion cannot orphan planning',()=>db.exec("delete from public.workspace_state where workspace_id='core-midwest'"));
const retained=clone(ledger);retained.meta.note='Compatible replacement keeps all referenced IDs';
const reimport=await rpc('owner','core_save_workspace',['core-midwest',retained,1,'import']);assert.equal(reimport.revision,2);assert.deepEqual((await get()).data,state.data);pass('compatible legacy reimport preserves independent year overrides and event planning');
const reviewedLedger=clone(retained);reviewedLedger.payments[0].reviewed=true;reviewedLedger.payments[0].note='Reviewed through the original spending workflow';reviewedLedger.payments[0].revision=1;
const legacyEdit=await rpc('editor','core_save_workspace',['core-midwest',reviewedLedger,2,'save']);assert.equal(legacyEdit.revision,3);assert.deepEqual((await get()).data,state.data);pass('normal legacy expense review remains compatible with planning reference protection');
await db.exec(legacySql);assert.equal((await get('viewer')).revision,state.revision);pass('rerunning legacy SQL does not revoke planning API access');
await db.exec(planningSql);assert.deepEqual((await get()).data,state.data);pass('rerunning planning migration preserves all saved data');
const beforeUpgrade=clone(state);await db.exec("update public.workspace_planning set payload=payload-'expenseYears' where workspace_id='core-midwest'");
await db.exec(planningSql);state=await get();assert.equal(state.revision,beforeUpgrade.revision+1);assert.deepEqual(state.data,{...beforeUpgrade.data,expenseYears:[]});pass('older preview planning payload receives empty year overrides with revision bump and no other changes');

// The browser uses the same constraints before sending a draft to the database.
const root=fileURLToPath(new URL('../',import.meta.url));
const vite=await createServer({root,configFile:false,mode:'test',appType:'custom',server:{middlewareMode:true,hmr:false,ws:false,watch:null},optimizeDeps:{noDiscovery:true,include:[]},define:{
  'import.meta.env.VITE_SUPABASE_URL':JSON.stringify('https://project.example.invalid'),
  'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY':JSON.stringify('sb_publishable_offline_test'),
  'import.meta.env.VITE_WORKSPACE_ID':JSON.stringify('core-midwest'),
  'import.meta.env.VITE_LOCAL_PREVIEW':JSON.stringify('false'),
}});
try{
  const {validatePlanning,isDateOnly}=await vite.ssrLoadModule('/lib/planning-validation.ts');
  assert.deepEqual(validatePlanning(state.data,['org-a'],['PAY-1']),state.data);pass('browser validator accepts database snapshot');
  for(const years of [[{paymentId:'PAY-1',year:1899}],[{paymentId:'PAY-1',year:2027.5}],[{paymentId:'missing',year:2027}],[{paymentId:'PAY-1',year:2027},{paymentId:'PAY-1',year:null}]]){const invalid=clone(state.data);invalid.expenseYears=years;assert.throws(()=>validatePlanning(invalid,['org-a'],['PAY-1']));}pass('browser rejects invalid, duplicate and missing-reference applicable years');
  for(const[label,mutate]of invalidCases.slice(0,27)){const invalid=clone(beforeSearch.data);mutate(invalid);assert.throws(()=>validatePlanning(invalid,['org-a']),undefined,label);}pass('browser rejects invalid dates, references, money, images and payment evidence');
  assert.equal(isDateOnly('2028-02-29'),true);assert.equal(isDateOnly('2027-02-29'),false);assert.equal(isDateOnly(''),true);pass('date-only validation handles leap years and unknown dates');
  const original=globalThis.window,originalFetch=globalThis.fetch;
  globalThis.window={location:{hash:'',search:'',href:'https://app.example.invalid/',origin:'https://app.example.invalid'},addEventListener(){},removeEventListener(){}};globalThis.fetch=async()=>{throw new Error('Tests cannot access the network');};
  let shared;
  try{
    shared=await vite.ssrLoadModule('/lib/shared-client.ts');
    let authChanged;
    shared.supabase.auth.onAuthStateChange=callback=>{authChanged=callback;return{data:{subscription:{unsubscribe(){}}}};};
    const client=await vite.ssrLoadModule('/lib/planning-client.ts');
    let lastCall;
    shared.supabase.rpc=async(name,args)=>{lastCall={name,args};return{data:clone(state),error:null};};
    assert.deepEqual(await client.loadPlanning(),state);assert.equal(lastCall.name,'core_get_planning');assert.equal(lastCall.args.p_workspace_id,'core-midwest');pass('client loads the configured planning workspace');
    await client.savePlanning(state.data,state.revision);assert.equal(lastCall.name,'core_save_planning');assert.equal(lastCall.args.p_expected_revision,state.revision);pass('client sends captured draft revision when saving');
    const previousCall=lastCall;const invalid=clone(state.data);invalid.events[0].startDate='2026-02-30';
    await assert.rejects(()=>client.savePlanning(invalid,state.revision),/valid date/);assert.equal(lastCall,previousCall);pass('invalid browser draft is rejected before any RPC');
    shared.supabase.rpc=async()=>({data:null,error:{code:'PT409',message:'Changed'}});await assert.rejects(()=>client.savePlanning(state.data,state.revision),/draft was not saved/);pass('stale client error explains unsaved draft');
    shared.supabase.rpc=async()=>({data:null,error:{code:'PGRST202',message:'Function not found'}});await assert.rejects(()=>client.loadPlanning(),/backend\/planning\.sql/);pass('missing migration provides actionable setup instruction');
    let finish;
    shared.supabase.rpc=()=>new Promise(resolve=>{finish=resolve;});
    const pending=client.savePlanning(state.data,state.revision);
    await assert.rejects(()=>client.savePlanning(state.data,state.revision),/still saving/);
    finish({data:clone(state),error:null});await pending;pass('client prevents simultaneous writes from one browser');
    const pendingRead=client.loadPlanning();authChanged('SIGNED_OUT',null);finish({data:clone(state),error:null});await assert.rejects(()=>pendingRead,/sign-in changed/);pass('read completion after sign-out cannot restore old planning');
    authChanged('SIGNED_IN',{user:{id:ids.owner}});const pendingSave=client.savePlanning(state.data,state.revision);authChanged('SIGNED_OUT',null);finish({data:clone(state),error:null});await assert.rejects(()=>pendingSave,/sign-in changed/);pass('save completion after sign-out cannot restore old planning');
  }finally{await shared?.supabase?.auth.stopAutoRefresh();globalThis.window=original;globalThis.fetch=originalFetch;}
}finally{await vite.close();await db.close();}
console.log(`\n${passed} planning checks passed.`);

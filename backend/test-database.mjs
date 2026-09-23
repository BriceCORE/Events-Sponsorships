import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

// SQL-level authorization and validation tests; no remote project or credentials needed.
const db = new PGlite();
const ids = {
  owner: '00000000-0000-0000-0000-000000000001',
  editor: '00000000-0000-0000-0000-000000000002',
  viewer: '00000000-0000-0000-0000-000000000003',
  outsider: '00000000-0000-0000-0000-000000000004',
};
await db.exec(`
  create role anon;
  create role authenticated;
  create schema auth;
  create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  $$;
  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
`);
const sql = await readFile(new URL('./supabase.sql', import.meta.url), 'utf8');
await db.exec(sql);
await db.exec(sql); // Setup script must also be safe to rerun without deleting records.
for (const id of Object.values(ids)) await db.query('insert into auth.users(id) values ($1)', [id]);
for (const role of ['owner','editor','viewer']) {
  await db.query('insert into public.workspace_members(workspace_id,user_id,role) values ($1,$2,$3)',
    ['core-midwest', ids[role], role]);
}

const fixture = {
  organizations: [{id:'org-a', name:'Alpha schools', sector:'K-12', type:'School', state:'IN', aliases:[]}],
  payments: [{id:'PAY-1',sourceRow:1,payee:'School Foundation',description:'2026 sponsorship',
    amountCents:10000,originalAmountCents:10000,eventYear:2026,approvalYear:2026,
    approvalDate:'2026-01-01',sector:'K-12',type:'Sponsorship',state:'IN',
    allocations:[{organizationId:'org-a',amountCents:10000}],confidence:'direct',reason:'Named client',
    note:'',reviewed:false,revision:0}],
  benefits: [{id:'BEN-1',organizationIds:['org-a'],sourceOrganization:'Alpha schools',program:'Annual',
    trackedLevel:'Partner',trackedPackageAmountText:'$100',
    applicability:{text:'2026',years:[2026],currentOrPrior:'current'},benefits:['Recognition'],alternatives:[],
    evidence:{status:'Unverified',flags:[]},potentialValue:'Community support',
    sources:['https://example.org/sponsorship'],openQuestions:[],paymentRows:[1]}],
  meta:{source:'Test fixture',researchAsOf:'2026-09-22',note:'Tests only'},
};
let count = 0;
async function asUser(who, operation) {
  await db.exec('begin');
  try {
    await db.exec(`set local role ${who === 'anon' ? 'anon' : 'authenticated'}`);
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [ids[who] ?? '']);
    const result = await operation();
    await db.exec('commit');
    return result;
  } catch (error) {
    await db.exec('rollback');
    throw error;
  }
}
const get = (who, workspace='core-midwest') => asUser(who, async () =>
  (await db.query('select public.core_get_workspace($1) as result', [workspace])).rows[0].result);
const save = (who, data, revision, action='save', workspace='core-midwest') => asUser(who, async () =>
  (await db.query('select public.core_save_workspace($1,$2::jsonb,$3,$4) as result',
    [workspace, JSON.stringify(data), revision, action])).rows[0].result);
async function denied(label, action, code) {
  await assert.rejects(action, error => error.code === code, label);
  count++; console.log(`PASS ${label}`);
}
function pass(label) {count++; console.log(`PASS ${label}`);}

await denied('anonymous cannot execute get RPC', () => get('anon'), '42501');
await denied('nonmember cannot read workspace', () => get('outsider'), 'PT403');
assert.deepEqual(await get('owner'), {data:null,revision:0,role:'owner'}); pass('uninitialized workspace is explicit');
await denied('editor cannot import', () => save('editor',fixture,0,'import'), 'PT403');
await denied('editor cannot initialize by normal save', () => save('editor',fixture,0), 'PT409');
await denied('viewer cannot save', () => save('viewer',fixture,0), 'PT403');
await denied('direct workspace update forbidden', () => asUser('editor', () =>
  db.exec("update public.workspace_state set revision=99")), '42501');
await denied('direct workspace insert forbidden', () => asUser('owner', () =>
  db.exec("insert into public.workspace_state(workspace_id) values ('bypass')")), '42501');
await denied('membership escalation forbidden', () => asUser('editor', () =>
  db.exec("update public.workspace_members set role='owner'")), '42501');
let state = await save('owner',fixture,0,'import');
assert.equal(state.revision,1); assert.deepEqual(state.data,fixture); pass('owner initializes workspace');
assert.equal((await get('viewer')).role,'viewer'); pass('viewer reads shared data');
const ownRows = await asUser('editor', () => db.query('select * from public.workspace_members'));
assert.equal(ownRows.rows.length,1); assert.equal(ownRows.rows[0].role,'editor'); pass('membership SELECT RLS');
const hiddenRows = await asUser('outsider', () => db.query('select * from public.workspace_state'));
assert.equal(hiddenRows.rows.length,0); pass('state SELECT RLS excludes nonmembers');
await denied('other workspace denied', () => get('editor','not-a-member'), 'PT403');
await denied('nonmember private implementation denied', () => asUser('outsider', () =>
  db.query('select core_private.save_workspace($1,$2::jsonb,1,$3)',
    ['core-midwest',JSON.stringify(fixture),'import'])), 'PT403');

const edited = structuredClone(fixture); edited.payments[0].note='Reviewed together';
edited.payments[0].reviewed=true; edited.payments[0].revision=1;
state = await save('editor',edited,1);
assert.equal(state.revision,2); pass('editor normal save increments workspace revision');
await denied('second client with stale snapshot conflicts', () => save('owner',fixture,1), 'PT409');
assert.deepEqual((await get('viewer')).data,edited); pass('conflict leaves committed data unchanged');

const invalidCases = [
  ['negative amount',d=>d.payments[0].amountCents=-1],
  ['fractional cents',d=>d.payments[0].amountCents=1.5],
  ['amount above cap',d=>d.payments[0].amountCents=100000000001],
  ['missing required field',d=>delete d.payments[0].originalAmountCents],
  ['invalid array shape',d=>d.payments={}],
  ['duplicate organization IDs',d=>d.organizations.push(structuredClone(d.organizations[0]))],
  ['duplicate payment IDs',d=>d.payments.push(structuredClone(d.payments[0]))],
  ['duplicate benefit IDs',d=>d.benefits.push(structuredClone(d.benefits[0]))],
  ['missing allocation organization',d=>d.payments[0].allocations[0].organizationId='missing'],
  ['duplicate allocation',d=>d.payments[0].allocations.push(structuredClone(d.payments[0].allocations[0]))],
  ['overallocated payment',d=>d.payments[0].allocations[0].amountCents=10001],
  ['null amount with allocation',d=>d.payments[0].amountCents=null],
  ['missing benefit organization',d=>d.benefits[0].organizationIds=['missing']],
  ['non-web source URL',d=>d.benefits[0].sources=['javascript:alert(1)']],
  ['missing nested field',d=>delete d.benefits[0].applicability.text],
  ['null mandatory field',d=>d.organizations[0].id=null],
];
for (const [label, mutate] of invalidCases) {
  const d=structuredClone(edited); mutate(d);
  await denied(label,()=>save('owner',d,2,'import'),'PT422');
}
for (const [label,mutate] of [
  ['immutable original amount',d=>d.payments[0].originalAmountCents=9999],
  ['immutable payee',d=>d.payments[0].payee='Rewritten'],
  ['immutable source row',d=>d.payments[0].sourceRow=88],
  ['payment deletion',d=>d.payments=[]],
  ['payment ID replacement',d=>d.payments[0].id='PAY-OTHER'],
  ['source metadata mutation',d=>d.meta.source='Different ledger'],
  ['existing organization rename',d=>d.organizations[0].name='Rewritten name'],
  ['existing organization aliases mutation',d=>d.organizations[0].aliases=['New alias']],
  ['benefit research mutation',d=>d.benefits[0].benefits=['Unverified new benefit']],
  ['benefit source mutation',d=>d.benefits[0].sources=['https://other.example.org']],
  ['benefit deletion',d=>d.benefits=[]],
  ['benefit ID replacement',d=>d.benefits[0].id='BEN-OTHER'],
  ['changed payment without revision increment',d=>d.payments[0].note='Changed again'],
  ['changed payment skips a revision',d=>{d.payments[0].note='Changed again';d.payments[0].revision=3;}],
  ['unchanged payment revision increment',d=>d.payments[0].revision=2],
  ['normal correction without note',d=>{d.payments[0].amountCents=12000;d.payments[0].note='  ';d.payments[0].revision=2;}],
  ['normal empty sector',d=>{d.payments[0].sector='';d.payments[0].revision=2;}],
  ['normal sector untrimmed',d=>{d.payments[0].sector=' K-12 ';d.payments[0].revision=2;}],
  ['normal expense note too long',d=>{d.payments[0].note='x'.repeat(4001);d.payments[0].revision=2;}],
  ['normal benefit note too long',d=>d.benefits[0].note='x'.repeat(4001)],
  ['normal benefit status invalid',d=>d.benefits[0].utilization='Invented'],
]) {
  const d=structuredClone(edited);mutate(d);
  await denied(label,()=>save('owner',d,2),'PT422');
}
assert.equal((await get('owner')).revision,2); pass('all rejected writes roll back revision and payload');
const corrected=structuredClone(edited); corrected.payments[0].amountCents=12000;
corrected.payments[0].allocations[0].amountCents=12000;corrected.payments[0].sector='Community';
corrected.payments[0].revision=2;corrected.payments[0].note='Corrected after invoice review';
corrected.organizations.push({id:'org-b',name:'New client',sector:'K-12',type:'School',state:'IL',aliases:[]});
corrected.benefits[0].note='Seats used';corrected.benefits[0].utilization='Fully used';
state=await save('editor',corrected,2); assert.equal(state.revision,3);
assert.equal(state.data.payments[0].originalAmountCents,10000);pass('current amount and sector correction preserves source amount');
assert.equal(state.data.organizations.length,2);pass('editor may append new organization');
assert.equal(state.data.benefits[0].note,'Seats used');assert.equal(state.data.benefits[0].utilization,'Fully used');pass('benefit notes and utilization can change');
await denied('editor replacement denied after initialization',()=>save('editor',fixture,3,'import'),'PT403');
state=await save('owner',fixture,3,'import'); assert.equal(state.revision,4);pass('owner replacement requires explicit import');
await denied('stale owner import conflicts',()=>save('owner',edited,3,'import'),'PT409');
await db.query('delete from public.workspace_members where user_id=$1',[ids.editor]);
await denied('revoked member immediately loses access',()=>get('editor'),'PT403');
await denied('revoked member cannot save',()=>save('editor',fixture,4),'PT403');
const exposed = await db.query("select proname,prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname like 'core_%'");
assert.equal(exposed.rows.length,2);assert.ok(exposed.rows.every(r=>!r.prosecdef));pass('public RPCs are security invoker');

if (process.argv[2]) {
  const raw=JSON.parse(await readFile(process.argv[2],'utf8'));
  const full=raw.format ? raw.data : raw;
  state=await save('owner',full,4,'import');
  assert.deepEqual(state.data,full); pass(`complete fixture validates and round-trips (${full.organizations.length} organizations / ${full.payments.length} payments / ${full.benefits.length} benefits)`);
}
console.log(`\n${count} database checks passed. PGlite tests simulate stale clients sequentially; run the documented two-session check against hosted PostgreSQL before production.`);
await db.close();

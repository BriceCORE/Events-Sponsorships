import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';

const root=fileURLToPath(new URL('../',import.meta.url));
const originalWindow=globalThis.window, originalFetch=globalThis.fetch;
globalThis.window={location:{hash:'',search:'',href:'https://app.example.invalid/',origin:'https://app.example.invalid'},addEventListener(){},removeEventListener(){}};
globalThis.fetch=async()=>{throw new Error('Unexpected network request: adapter tests must be offline.');};
const vite=await createServer({root,configFile:false,mode:'test',appType:'custom',
  server:{middlewareMode:true,hmr:false,ws:false,watch:null},
  optimizeDeps:{noDiscovery:true,include:[]},
  resolve:{alias:{'@':root}},
  define:{'import.meta.env.VITE_SUPABASE_URL':JSON.stringify('https://project.example.invalid'),
    'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY':JSON.stringify('sb_publishable_offline_test'),
    'import.meta.env.VITE_WORKSPACE_ID':JSON.stringify('core-midwest'),
    'import.meta.env.VITE_LOCAL_PREVIEW':JSON.stringify('false')},
});
let client;
let passed=0;
const pass=label=>{passed++;console.log(`PASS ${label}`);};
const fixture={
  organizations:[{id:'org-a',name:'Example schools',sector:'K-12',type:'School',state:'IN',aliases:[]}],
  payments:[{id:'PAY-1',sourceRow:1,payee:'Example foundation',description:'2026 support',amountCents:10000,
    originalAmountCents:10000,eventYear:2026,approvalYear:2026,approvalDate:'2026-01-01',sector:'K-12',type:'Sponsor',state:'IN',
    allocations:[{organizationId:'org-a',amountCents:10000}],confidence:'direct',reason:'Named client',note:'',reviewed:false,revision:0}],
  benefits:[{id:'BEN-1',organizationIds:['org-a'],sourceOrganization:'Example schools',program:'Annual support',trackedLevel:'Partner',
    trackedPackageAmountText:'$100',applicability:{text:'2026',years:[2026],currentOrPrior:'current'},benefits:['Recognition'],alternatives:[],
    evidence:{status:'Unverified',flags:[]},potentialValue:'Community support',sources:['https://example.org'],openQuestions:[],paymentRows:[1]}],
  meta:{source:'Synthetic fixture',researchAsOf:'2026-09-22',note:'Tests only'},
};
let remote,calls=[],handler=null;
const clone=v=>structuredClone(v);
const expenseInput=(overrides={})=>({sector:'K-12',amountCents:10000,allocations:[{organizationId:'org-a',amountCents:10000}],note:'Reviewed',reviewed:true,revision:0,...overrides});
const benefitInput=(overrides={})=>({expectedNote:'',expectedUtilization:'Not reviewed',note:'Used the seats',utilization:'Fully used',...overrides});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
async function reset(role='editor'){
  client.clearSnapshot();remote={data:clone(fixture),revision:1,role};calls=[];handler=null;
  await client.api('/api/workspace');calls=[];
}
async function defaultRpc(name,args){
  if(name==='core_get_workspace')return {data:clone(remote),error:null};
  if(name!=='core_save_workspace')throw new Error(`Unexpected RPC: ${name}`);
  if(args.p_expected_revision!==remote.revision)return{data:null,error:{code:'PT409',message:'stale'}};
  remote={data:clone(args.p_payload),revision:remote.revision+1,role:remote.role};
  return{data:clone(remote),error:null};
}
async function rejectNoSave(label,operation,pattern){
  const before=calls.filter(c=>c.name==='core_save_workspace').length;
  await assert.rejects(operation,pattern);
  assert.equal(calls.filter(c=>c.name==='core_save_workspace').length,before);
  pass(label);
}
try{
  client=await vite.ssrLoadModule('/lib/shared-client.ts');
  assert.ok(client.supabase);assert.equal(client.localPreview,false);
  client.supabase.rpc=async(name,args)=>{
    calls.push({name,args:clone(args)});
    return handler?handler(name,args):defaultRpc(name,args);
  };
  await reset();
  assert.equal(client.workspaceRevision(),1);assert.equal(client.workspaceRole(),'editor');assert.equal(client.canEdit(),true);
  pass('shared snapshot supplies role and workspace revision');
  await client.api('/api/benefits/BEN-1','PUT',benefitInput());
  assert.equal(remote.data.benefits[0].note,'Used the seats');assert.equal(remote.revision,2);
  assert.equal(calls[0].args.p_expected_revision,1);assert.equal(calls[0].args.p_action,'save');
  pass('benefit defaults match expected empty note and Not reviewed status');
  await rejectNoSave('stale benefit note rejected locally',()=>client.api('/api/benefits/BEN-1','PUT',benefitInput()),/benefit review changed/);
  await rejectNoSave('stale benefit status rejected locally',()=>client.api('/api/benefits/BEN-1','PUT',benefitInput({expectedNote:'Used the seats'})),/benefit review changed/);
  await rejectNoSave('invalid benefit status rejected before RPC',()=>client.api('/api/benefits/BEN-1','PUT',benefitInput({expectedNote:'Used the seats',expectedUtilization:'Fully used',utilization:'Invented'})),/Choose a benefit use status/);
  await rejectNoSave('oversized benefit note rejected before RPC',()=>client.api('/api/benefits/BEN-1','PUT',benefitInput({expectedNote:'Used the seats',expectedUtilization:'Fully used',note:'x'.repeat(4001)})),/4,000/);

  await reset();
  await client.api('/api/expenses/PAY-1','PUT',expenseInput());
  assert.equal(remote.data.payments[0].revision,1);assert.equal(remote.data.payments[0].originalAmountCents,10000);
  pass('expense edit increments record revision and preserves original amount');
  const writesBeforeNoop=calls.filter(c=>c.name==='core_save_workspace').length;
  await client.api('/api/expenses/PAY-1','PUT',expenseInput({revision:1}));
  assert.equal(calls.filter(c=>c.name==='core_save_workspace').length,writesBeforeNoop);
  assert.equal(remote.data.payments[0].revision,1);pass('unchanged expense does not increment revision or call save');
  await rejectNoSave('stale expense revision rejected locally',()=>client.api('/api/expenses/PAY-1','PUT',expenseInput()),/expense changed/);
  await rejectNoSave('over-allocation rejected locally',()=>client.api('/api/expenses/PAY-1','PUT',expenseInput({revision:1,allocations:[{organizationId:'org-a',amountCents:10001}]})),/cannot exceed/);
  await rejectNoSave('amount correction requires a note',()=>client.api('/api/expenses/PAY-1','PUT',expenseInput({revision:1,amountCents:12000,note:''})),/explaining the amount correction/);

  await reset();remote.revision=2;remote.data.benefits[0].note='Someone else saved';
  await assert.rejects(()=>client.api('/api/benefits/BEN-1','PUT',benefitInput()),/draft has not been saved/);
  assert.equal(remote.data.benefits[0].note,'Someone else saved');assert.equal(client.workspaceRevision(),1);
  pass('backend workspace conflict preserves remote data and reports unsaved draft');
  await client.api('/api/workspace');
  await rejectNoSave('refresh then stale benefit draft still rejected',()=>client.api('/api/benefits/BEN-1','PUT',benefitInput()),/benefit review changed/);

  await reset('viewer');
  assert.equal(client.canEdit(),false);
  await rejectNoSave('viewer edit rejected before RPC',()=>client.api('/api/expenses/PAY-1','PUT',expenseInput()),/read-only/);
  await rejectNoSave('viewer import rejected before RPC',()=>client.importSharedWorkspace(fixture,1),/Only a workspace owner/);
  await reset('editor');
  await rejectNoSave('editor import rejected before RPC',()=>client.importSharedWorkspace(fixture,1),/Only a workspace owner/);
  await reset('owner');
  await client.importSharedWorkspace(fixture,1);
  assert.equal(calls[0].args.p_action,'import');assert.equal(calls[0].args.p_expected_revision,1);
  pass('owner import sends explicit captured workspace revision and import action');

  await reset();
  await client.api('/api/organizations','POST',{name:' New schools ',sector:'K-12'});
  assert.equal(remote.data.organizations[1].name,'New schools');assert.match(remote.data.organizations[1].id,/^org-custom-/);
  pass('organization append sends validated shared payload');
  await rejectNoSave('duplicate organization name rejected',()=>client.api('/api/organizations','POST',{name:'NEW SCHOOLS',sector:'K-12'}),/already exists/);

  await reset();
  const hold=deferred();
  handler=(name,args)=>name==='core_save_workspace'?hold.promise:defaultRpc(name,args);
  const firstSave=client.api('/api/expenses/PAY-1','PUT',expenseInput());
  await Promise.resolve();
  await rejectNoSave('second simultaneous save blocked locally',()=>client.api('/api/benefits/BEN-1','PUT',benefitInput()),/still saving/);
  const getCount=calls.filter(c=>c.name==='core_get_workspace').length;
  await client.api('/api/workspace');assert.equal(calls.filter(c=>c.name==='core_get_workspace').length,getCount);
  pass('background read does not race an in-flight save');
  const pending=calls.find(c=>c.name==='core_save_workspace');hold.resolve(await defaultRpc(pending.name,pending.args));await firstSave;

  await reset();
  const slow=deferred();let reads=0;
  handler=(name,args)=>name==='core_get_workspace'&&reads++===0?slow.promise:defaultRpc(name,args);
  const slowRead=client.api('/api/workspace');
  const old=clone(remote);
  await client.api('/api/expenses/PAY-1','PUT',expenseInput());
  slow.resolve({data:old,error:null});await slowRead;
  assert.equal(client.workspaceRevision(),2);pass('slow old read cannot replace a newer committed save');

  await reset();
  handler=async()=>({data:null,error:{code:'NETWORK',message:'Temporary connection failure'}});
  await assert.rejects(()=>client.api('/api/expenses/PAY-1','PUT',expenseInput()),/Temporary connection failure/);
  handler=null;await client.api('/api/expenses/PAY-1','PUT',expenseInput());
  assert.equal(remote.revision,2);pass('save lock releases after RPC failure');

  client.clearSnapshot();assert.equal(client.workspaceRevision(),0);assert.equal(client.canEdit(),false);
  pass('sign-out snapshot clearing removes cached edit permission');

  await reset();
  const oldRead=deferred();const oldSnapshot=clone(remote);
  handler=()=>oldRead.promise;
  const readBeforeSignout=client.api('/api/workspace');
  client.clearSnapshot();oldRead.resolve({data:oldSnapshot,error:null});
  await assert.rejects(()=>readBeforeSignout,/session changed/);
  assert.equal(client.workspaceRevision(),0);assert.equal(client.canEdit(),false);
  pass('read completed after sign-out cannot restore old session data');

  await reset();
  const oldSave=deferred();handler=()=>oldSave.promise;
  const saveBeforeSignout=client.api('/api/expenses/PAY-1','PUT',expenseInput());
  client.clearSnapshot();oldSave.resolve({data:{data:clone(fixture),revision:2,role:'editor'},error:null});
  await assert.rejects(()=>saveBeforeSignout,/session changed/);
  assert.equal(client.workspaceRevision(),0);assert.equal(client.canEdit(),false);
  pass('save completed after sign-out cannot restore old session data');
  if(process.argv[2]){
    const raw=JSON.parse(await readFile(process.argv[2],'utf8'));
    remote={data:raw.format?raw.data:raw,revision:7,role:'owner'};handler=null;
    const data=await client.api('/api/workspace');
    assert.equal(data.payments.length,remote.data.payments.length);
    pass(`real private fixture loads without bundling (${data.organizations.length}/${data.payments.length}/${data.benefits.length})`);
  }
  console.log(`\n${passed} shared-adapter checks passed. RPC and Auth networking were not used.`);
}finally{
  if(client?.supabase)await client.supabase.auth.stopAutoRefresh();
  await vite.close();
  if(originalWindow===undefined)delete globalThis.window;else globalThis.window=originalWindow;
  globalThis.fetch=originalFetch;
}

import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';

let passed=0;
const pass=label=>{passed++;console.log('PASS '+label)};
const vite=await createServer({root:fileURLToPath(new URL('../',import.meta.url)),configFile:false,mode:'test',appType:'custom',server:{middlewareMode:true,hmr:false,ws:false,watch:null},optimizeDeps:{noDiscovery:true,include:[]},define:{
  'import.meta.env.VITE_SUPABASE_URL':JSON.stringify('https://project.example.invalid'),
  'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY':JSON.stringify('sb_publishable_offline_test'),
  'import.meta.env.VITE_WORKSPACE_ID':JSON.stringify('core-midwest'),
  'import.meta.env.VITE_LOCAL_PREVIEW':JSON.stringify('false'),
}});
const previousWindow=globalThis.window,previousFetch=globalThis.fetch;
globalThis.window={location:{hash:'',search:'',href:'https://app.example.invalid/',origin:'https://app.example.invalid'},addEventListener(){},removeEventListener(){}};
globalThis.fetch=async()=>{throw new Error('Network access blocked during tests');};
const queued={job:{id:'request-a',status:'queued',requestedAt:'2026-09-23T12:00:00.000Z',startedAt:null,finishedAt:null,message:'Waiting for a worker.',pagesChecked:0,candidatesFound:0,runId:null,leaseUntil:null},cooldownUntil:'2026-09-23T12:01:00.000Z'};
let shared;
try{
  shared=await vite.ssrLoadModule('/lib/shared-client.ts');
  let authChanged;
  shared.supabase.auth.onAuthStateChange=callback=>{authChanged=callback;return{data:{subscription:{unsubscribe(){}}}}};
  const client=await vite.ssrLoadModule('/lib/discovery-requests.ts');
  let lastCall,calls=0;
  shared.supabase.rpc=async(name,args)=>{calls++;lastCall={name,args};return{data:{job:null,cooldownUntil:null},error:null}};
  assert.deepEqual(await client.getDiscoveryRequest(),{job:null,cooldownUntil:null});
  assert.deepEqual(lastCall,{name:'core_get_discovery_request',args:{p_workspace_id:'core-midwest'}});pass('load checks the configured workspace and accepts no previous request');
  shared.supabase.rpc=async(name,args)=>{lastCall={name,args};return{data:queued,error:null}};
  assert.deepEqual(await client.requestDiscoveryCheck(),queued);
  assert.deepEqual(lastCall,{name:'core_request_discovery',args:{p_workspace_id:'core-midwest'}});pass('request sends only the workspace, with no privileged key or client-chosen job fields');
  for(const status of ['queued','running','success','partial','failed','cancelled']){
    const data=structuredClone(queued);data.job.status=status;
    shared.supabase.rpc=async()=>({data,error:null});assert.equal((await client.getDiscoveryRequest()).job.status,status);
  }pass('all queue and completion states validate');
  for(const mutate of [x=>x.job.status='approved',x=>x.job.pagesChecked=-1,x=>x.job.candidatesFound=1.5,x=>x.job.requestedAt='not a date',x=>x.job.secret='no',x=>x.job.id='',x=>delete x.job.leaseUntil]){
    const data=structuredClone(queued);mutate(data);shared.supabase.rpc=async()=>({data,error:null});await assert.rejects(()=>client.getDiscoveryRequest(),/invalid status/);
  }pass('malformed responses are rejected');
  for(const code of ['PGRST202','42883','42P01']){
    shared.supabase.rpc=async()=>({data:null,error:{code,message:'Missing'}});
    await assert.rejects(()=>client.getDiscoveryRequest(),e=>e instanceof client.DiscoveryRequestSetupError&&/discovery-requests.sql/.test(e.message));
  }pass('missing database update has a typed actionable setup error');
  for(const message of ['Editor or owner access is required.','Enable conference tracking before checking.']){
    shared.supabase.rpc=async()=>({data:null,error:{code:'PT403',message}});
    await assert.rejects(()=>client.requestDiscoveryCheck(),e=>e.message===message);
  }pass('permission and prerequisite errors remain visible');
  let resolve;
  calls=0;shared.supabase.rpc=()=>{calls++;return new Promise(done=>{resolve=done})};
  const first=client.requestDiscoveryCheck(),second=client.requestDiscoveryCheck();assert.equal(first,second);assert.equal(calls,1);
  resolve({data:queued,error:null});await first;pass('repeated clicks share one in-flight request');
  const failed=client.requestDiscoveryCheck();resolve({data:null,error:{code:'PT429',message:'Try again shortly.'}});await assert.rejects(()=>failed,/Try again/);
  const retry=client.requestDiscoveryCheck();resolve({data:queued,error:null});await retry;assert.equal(calls,3);pass('failed requests release the local lock for retry');
  const lateRead=client.getDiscoveryRequest();authChanged('SIGNED_OUT',null);resolve({data:queued,error:null});await assert.rejects(()=>lateRead,/sign-in changed/);pass('late reads after sign-out are rejected');
  authChanged('SIGNED_IN',{user:{id:'user-a'}});const old=client.requestDiscoveryCheck(),resolveOld=resolve;
  authChanged('SIGNED_IN',{user:{id:'user-b'}});const current=client.requestDiscoveryCheck(),resolveCurrent=resolve;
  resolveOld({data:queued,error:null});await assert.rejects(()=>old,/sign-in changed/);
  assert.equal(client.requestDiscoveryCheck(),current);resolveCurrent({data:queued,error:null});await current;pass('previous account replies cannot clear a new account request');
}finally{await shared?.supabase?.auth.stopAutoRefresh();globalThis.window=previousWindow;globalThis.fetch=previousFetch;await vite.close();}
console.log(`\n${passed} discovery-request client checks passed.`);

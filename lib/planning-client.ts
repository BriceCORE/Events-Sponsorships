import {supabase,workspaceId} from './shared-client';
import type {PlanningData,PlanningSnapshot} from './planning-types';
import {validatePlanning} from './planning-validation';

let saving=false,sessionGeneration=0;
let userId:string|null|undefined;
supabase?.auth.onAuthStateChange((event,session)=>{
  const next=session?.user.id??null;
  if(event==='SIGNED_OUT'||userId!==undefined&&next!==userId){sessionGeneration++;saving=false;}
  userId=next;
});
async function planningRpc(name:string,args:Record<string,unknown>):Promise<PlanningSnapshot>{
  if(!supabase)throw new Error('The shared workspace connection has not been configured.');
  const generation=sessionGeneration;
  const {data,error}=await supabase.rpc(name,args);
  if(generation!==sessionGeneration)throw new Error('Your sign-in changed. Refresh the workspace before continuing.');
  if(error){
    if(['PGRST202','42883','42P01'].includes(error.code))throw new Error('Event planning needs one database update. Ask the workspace owner to run backend/planning.sql in the Supabase SQL Editor, then refresh.');
    if(error.code==='PT409')throw new Error('Event planning changed while you were editing, possibly from another teammate or the conference search. Your draft was not saved. Close this editor, refresh, and review the latest details.');
    throw new Error(error.message||'Event planning could not be reached.');
  }
  if(!data||!Number.isSafeInteger(data.revision)||data.revision<0||!['owner','editor','viewer'].includes(data.role))throw new Error('Event planning returned an invalid response. Refresh and try again.');
  return {...data,data:validatePlanning(data.data)} as PlanningSnapshot;
}
export function loadPlanning():Promise<PlanningSnapshot>{return planningRpc('core_get_planning',{p_workspace_id:workspaceId});}
export async function savePlanning(data:PlanningData,expectedRevision:number):Promise<PlanningSnapshot>{
  if(saving)throw new Error('Another event planning change is still saving. Try again shortly.');
  if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0)throw new Error('Refresh event planning before saving.');
  const payload=validatePlanning(data),generation=sessionGeneration;
  saving=true;
  try{return await planningRpc('core_save_planning',{p_workspace_id:workspaceId,p_payload:payload,p_expected_revision:expectedRevision});}
  finally{if(generation===sessionGeneration)saving=false;}
}

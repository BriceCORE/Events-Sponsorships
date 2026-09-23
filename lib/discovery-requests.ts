import {z} from 'zod';
import {supabase,workspaceId} from './shared-client';

const timestamp=z.string().datetime({offset:true}).max(40);
const jobSchema=z.object({
  id:z.string().min(1).max(200),
  status:z.enum(['queued','running','success','partial','failed','cancelled']),
  requestedAt:timestamp,startedAt:timestamp.nullable(),finishedAt:timestamp.nullable(),
  message:z.string().max(4000),
  pagesChecked:z.number().int().min(0).max(100000),
  candidatesFound:z.number().int().min(0).max(100000),
  runId:z.string().min(1).max(200).nullable(),leaseUntil:timestamp.nullable(),
}).strict();
const responseSchema=z.object({job:jobSchema.nullable(),cooldownUntil:timestamp.nullable()}).strict();
export type DiscoveryJob=z.infer<typeof jobSchema>;
export type DiscoveryRequestState=z.infer<typeof responseSchema>;
export class DiscoveryRequestSetupError extends Error{
  constructor(){super('Check now needs one database update. Ask the workspace owner to run backend/discovery-requests.sql in Supabase, then refresh.');this.name='DiscoveryRequestSetupError';}
}

let generation=0,userId:string|null|undefined;
let pending:Promise<DiscoveryRequestState>|null=null;
supabase?.auth.onAuthStateChange((event,session)=>{
  const next=session?.user.id??null;
  if(event==='SIGNED_OUT'||userId!==undefined&&userId!==next){generation++;pending=null;}
  userId=next;
});

async function rpc(name:'core_get_discovery_request'|'core_request_discovery'):Promise<DiscoveryRequestState>{
  if(!supabase)throw new Error('The shared workspace connection has not been configured.');
  const startedGeneration=generation;
  const {data,error}=await supabase.rpc(name,{p_workspace_id:workspaceId});
  if(startedGeneration!==generation)throw new Error('Your sign-in changed. Refresh before checking conferences.');
  if(error){
    if(['PGRST202','42883','42P01'].includes(error.code))throw new DiscoveryRequestSetupError();
    throw new Error(error.message||'The conference search could not be reached. Try again.');
  }
  const parsed=responseSchema.safeParse(data);
  if(!parsed.success)throw new Error('The conference search returned an invalid status. Refresh and try again.');
  return parsed.data;
}

export function getDiscoveryRequest():Promise<DiscoveryRequestState>{return rpc('core_get_discovery_request');}
export function requestDiscoveryCheck():Promise<DiscoveryRequestState>{
  if(pending)return pending;
  const startedGeneration=generation;
  const request=rpc('core_request_discovery').finally(()=>{if(generation===startedGeneration&&pending===request)pending=null;});
  pending=request;
  return request;
}

"use client";
import {useCallback,useEffect,useRef,useState} from 'react';
import {ArrowRight,CheckCircle2,Clock3,RefreshCw,Search,TriangleAlert} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {DiscoveryRequestSetupError,getDiscoveryRequest,requestDiscoveryCheck,type DiscoveryJob,type DiscoveryRequestState} from '@/lib/discovery-requests';

type Props={canEdit:boolean;scheduleEnabled:boolean;enabledCount:number;onComplete:()=>Promise<void>;onReview:()=>void};
const active=(job:DiscoveryJob|null|undefined)=>job?.status==='queued'||job?.status==='running';
const finished=(job:DiscoveryJob|null|undefined)=>!!job&&!active(job);
const labels:Record<DiscoveryJob['status'],string>={queued:'Queued',running:'Running',success:'Complete',partial:'Partially complete',failed:'Check failed',cancelled:'Cancelled'};
const errorMessage=(error:unknown)=>error instanceof Error?error.message:'Check status could not be loaded. Try again.';
const timestamp=(value:string|null)=>value?new Date(value).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'';

export function DiscoveryCheck({canEdit,scheduleEnabled,enabledCount,onComplete,onReview}:Props){
 const [state,setState]=useState<DiscoveryRequestState|null>(null),[loading,setLoading]=useState(true),[requesting,setRequesting]=useState(false),[setupMissing,setSetupMissing]=useState(false),[error,setError]=useState(''),[refreshError,setRefreshError]=useState(''),[now,setNow]=useState(Date.now());
 const job=state?.job;
 const queuedOverdue=job?.status==='queued'&&now-new Date(job.requestedAt).getTime()>=15*60*1000;
 const stateRef=useRef<DiscoveryRequestState|null>(null),requestingRef=useRef(false),mounted=useRef(false),sequence=useRef(0),completedJobs=useRef(new Set<string>()),onCompleteRef=useRef(onComplete);
 onCompleteRef.current=onComplete;
 const applyState=useCallback((value:DiscoveryRequestState)=>{stateRef.current=value;setState(value);setSetupMissing(false);setError('');setNow(Date.now())},[]);
 const readStatus=useCallback(async()=>{
  if(requestingRef.current)return;
  const current=++sequence.current;
  try{const value=await getDiscoveryRequest();if(mounted.current&&current===sequence.current)applyState(value)}
  catch(error){if(mounted.current&&current===sequence.current){setSetupMissing(error instanceof DiscoveryRequestSetupError);setError(error instanceof DiscoveryRequestSetupError?'':errorMessage(error))}}
  finally{if(mounted.current&&current===sequence.current)setLoading(false)}
 },[applyState]);
 useEffect(()=>{
  mounted.current=true;let stopped=false,inFlight=false,timer:ReturnType<typeof setTimeout>|undefined;
  const tick=async()=>{if(stopped||inFlight)return;inFlight=true;try{if(document.visibilityState==='visible')await readStatus()}finally{inFlight=false;if(!stopped)timer=setTimeout(tick,active(stateRef.current?.job)?10000:30000)}};
  const visibility=()=>{if(document.visibilityState==='visible'){if(timer)clearTimeout(timer);void tick()}};
  void tick();document.addEventListener('visibilitychange',visibility);
  return()=>{stopped=true;mounted.current=false;sequence.current++;if(timer)clearTimeout(timer);document.removeEventListener('visibilitychange',visibility)};
 },[readStatus,active(job)]);
 const cooldownAt=state?.cooldownUntil?new Date(state.cooldownUntil).getTime():0,cooldownSeconds=Math.max(0,Math.ceil((cooldownAt-now)/1000));
 useEffect(()=>{if(!cooldownAt||cooldownAt<=Date.now())return;const timer=setInterval(()=>{const current=Date.now();setNow(current);if(current>=cooldownAt)clearInterval(timer)},1000);return()=>clearInterval(timer)},[cooldownAt]);
 useEffect(()=>{
  if(!finished(job)||!job)return;
  const key=[job.id,job.status,job.finishedAt].join('|');
  if(completedJobs.current.has(key))return;
  completedJobs.current.add(key);setRefreshError('');
  void onCompleteRef.current().catch(()=>{if(mounted.current)setRefreshError('The check finished, but the event list could not refresh. Use Refresh events to load the results.')});
 },[job?.id,job?.status,job?.finishedAt]);
 const queue=async()=>{
  if(!canEdit||!scheduleEnabled||!enabledCount||requestingRef.current||active(stateRef.current?.job)||cooldownSeconds>0||setupMissing)return;
  requestingRef.current=true;setRequesting(true);setError('');setRefreshError('');const current=++sequence.current;
  try{const value=await requestDiscoveryCheck();if(mounted.current&&current===sequence.current)applyState(value)}
  catch(error){if(mounted.current&&current===sequence.current){setSetupMissing(error instanceof DiscoveryRequestSetupError);setError(error instanceof DiscoveryRequestSetupError?'':errorMessage(error))}}
  finally{requestingRef.current=false;if(mounted.current){setRequesting(false);setLoading(false)}};
 };
 const retryResults=async()=>{setRefreshError('');try{await onCompleteRef.current()}catch{if(mounted.current)setRefreshError('The event list could not refresh. Please try again.')}};
 const disabled=!canEdit||!scheduleEnabled||enabledCount===0||loading||requesting||active(job)||cooldownSeconds>0||setupMissing||state===null;
 const idleHint=active(job)?'This request checks the enabled conferences in your tracker.':!canEdit?'An owner or editor can start a conference check.':!scheduleEnabled?'Enable the schedule in Conference tracking to start a check.':!enabledCount?'Add an official source and enable at least one conference in your tracker.':cooldownSeconds>0?'Another check can be requested after the short cooldown.':`Check ${enabledCount} enabled ${enabledCount===1?'conference':'conferences'} now, without waiting for the next two-week check.`;
 const buttonLabel=requesting?'Queuing…':loading?'Checking status…':job?.status==='queued'?'Check queued':job?.status==='running'?'Check running':cooldownSeconds>0?`Check again in ${cooldownSeconds}s`:'Check now';
 return <section className={'discovery-check '+(job?'discovery-check-'+job.status:'')} aria-label="Check conferences now">
  <div className="discovery-check-top"><div><p className="eyebrow">FIND YOUR NEXT CONFERENCE</p><h3>Check known conferences now.</h3><p className="discovery-check-intro">Tracking finds possible events. Review each result before adding it to your schedule.</p></div><Button onClick={queue} disabled={disabled} className="check-now-button">{active(job)||requesting?<RefreshCw size={16} className={job?.status==='running'||requesting?'spin':''}/>:<Search size={16}/>} {buttonLabel}</Button></div>
  {setupMissing?<div className="discovery-check-setup"><TriangleAlert size={16}/><div><strong>Check now needs one database update.</strong><p>Your scheduled conference tracking is still available. Ask your workspace owner to finish this setup.</p><a href="https://github.com/BriceCORE/Events-Sponsorships/blob/main/backend/discovery-requests.sql" target="_blank" rel="noopener noreferrer">Open the database update</a><Button variant="ghost" onClick={()=>void readStatus()}>Retry status</Button></div></div>:<>
   <p className="discovery-check-hint">{idleHint}</p>
   {job&&<div className="discovery-check-job" role="status"><div className="discovery-job-heading">{job.status==='success'?<CheckCircle2 size={17}/>:job.status==='failed'||job.status==='partial'?<TriangleAlert size={17}/>:<Clock3 size={17}/>}<strong>{labels[job.status]}</strong><span>{job.finishedAt?'Finished '+timestamp(job.finishedAt):job.startedAt?'Started '+timestamp(job.startedAt):'Requested '+timestamp(job.requestedAt)}</span></div><p>{job.status==='queued'?(queuedOverdue?'This request has been queued for 15 minutes or longer. The worker has not started it yet.':'Your request is queued. The worker is scheduled to check for requests every 5 minutes; GitHub may delay the start.'):job.status==='running'?'Checking the enabled conference sources. Results will appear in Discovery review when the check finishes.':job.message||'The check has finished. Review the findings before adding events.'}</p>{queuedOverdue&&<div className="discovery-check-setup overdue-queue-notice"><TriangleAlert size={16}/><div><strong>Start the existing queued check</strong>{canEdit?<p>Open the workflow, choose <strong>Run workflow</strong>, and leave <strong>force</strong> unchecked. This processes the existing queue.</p>:<p>Ask a workspace owner or editor with GitHub repository access to start the existing queued check.</p>}<p>This step requires write or administrator access to the GitHub repository. App editing access alone does not provide it.</p><a href="https://github.com/BriceCORE/Events-Sponsorships/actions/workflows/discovery.yml" target="_blank" rel="noopener noreferrer">Open discovery workflow</a></div></div>}{active(job)&&!queuedOverdue&&job.message&&<p className="discovery-job-message">{job.message}</p>}{(finished(job)||job.pagesChecked>0)&&<div className="discovery-job-counts"><span><strong>{job.pagesChecked}</strong> {job.pagesChecked===1?'page':'pages'} checked</span><span><strong>{job.candidatesFound}</strong> {job.candidatesFound===1?'discovery':'discoveries'} found</span></div>}{finished(job)&&<Button variant="outline" onClick={onReview}>Review discoveries<ArrowRight size={14}/></Button>}</div>}
  </>}
  {(error||refreshError)&&<div className="discovery-check-error" role="alert"><span>{error||refreshError}</span>{error?<Button variant="ghost" onClick={()=>void readStatus()} disabled={requesting}>Retry status</Button>:<Button variant="ghost" onClick={()=>void retryResults()}>Retry results</Button>}</div>}
  <ol className="discovery-process" aria-label="Conference planning steps"><li><span>1</span>Track conferences</li><li><span>2</span>Check now</li><li><span>3</span>Discovery review</li><li><span>4</span>Review & add event</li><li><span>5</span>Overview</li></ol>
 </section>;
}

import {z} from 'zod';
import type {PlanningData} from './planning-types';

const id=z.string().trim().min(1).max(200), short=z.string().max(500), text=z.string().max(10000);
const named=z.string().trim().min(1).max(500);
export const isDateOnly=(value:string)=>value==='' || /^\d{4}-\d{2}-\d{2}$/.test(value) && value>='1900-01-01' && value<='2200-12-31' && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value;
const date=z.string().refine(isDateOnly,'Use a valid date between 1900 and 2200.');
const timestamp=z.union([z.literal(''),z.string().datetime({offset:true}).max(40)]);
const requiredTimestamp=z.string().datetime({offset:true}).max(40);
const safeUrl=(value:string)=>{try{const url=new URL(value);return /^https?:$/.test(url.protocol)&&!!url.hostname&&!url.username&&!url.password&&!/[\s\\]/.test(value);}catch{return false;}};
const url=z.string().max(2000).refine(value=>value===''||safeUrl(value),'Use a complete http or https address without a username or password.');
const sourceUrl=url.refine(Boolean,'Enter a source address.');
const logo=z.string().max(220000).refine(value=>value==='' || value.length<=2000 && safeUrl(value) && value.startsWith('https://') || /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(value),'Choose a PNG, JPEG, WebP, or GIF image, or an https image address.');
const cents=z.number().int().positive().max(100000000000).nullable();
const profile=z.object({id,name:named,sector:named,type:short,state:short,aliases:z.array(short).max(500),description:text,website:url,contactName:short,contactEmail:short,contactPhone:short,logoUrl:logo,updatedAt:requiredTimestamp}).strict();
const task=z.object({id,title:named,owner:short,dueDate:date,done:z.boolean()}).strict();
const invoice=z.object({status:z.enum(['not_received','awaiting_payment','paid']),amountCents:cents,reference:short,paidOn:date,confirmedBy:short,note:text}).strict().superRefine((value,ctx)=>{
  if(value.status==='paid'&&(!value.paidOn||!value.confirmedBy.trim()||!value.reference.trim()&&!value.note.trim()))ctx.addIssue({code:'custom',message:'Paid invoices need a payment date, confirmation name, and reference or note.'});
});
const event=z.object({id,organizationId:id,title:named,startDate:date,endDate:date,location:short,state:short,sector:named,website:url,description:text,sponsorshipLevel:short,estimatedCostCents:cents,decision:z.enum(['needs_review','attend','sponsor','attend_and_sponsor','decline']),decisionNotes:text,invoice,tasks:z.array(task).max(100),plan:z.object({objectives:text,audience:text,attendees:text,logistics:text,materials:text,followUp:text}).strict(),debrief:z.object({completedOn:date,attendance:text,meetings:text,leads:text,opportunities:text,whatWorked:text,improvements:text,followUp:text,notes:text}).strict(),sourceDiscoveryId:z.string().max(200),createdAt:requiredTimestamp,updatedAt:requiredTimestamp}).strict().superRefine((value,ctx)=>{
  if(value.endDate&&(!value.startDate||value.endDate<value.startDate))ctx.addIssue({code:'custom',path:['endDate'],message:'The end date must be on or after the start date.'});
  if(new Set(value.tasks.map(task=>task.id)).size!==value.tasks.length)ctx.addIssue({code:'custom',path:['tasks'],message:'Planning task IDs must be unique.'});
});
const watch=z.object({id,organizationId:id,name:named,sourceUrls:z.array(sourceUrl).max(20),searchTerms:z.string().max(1000),enabled:z.boolean()}).strict();
const discovery=z.object({id,watchId:id,organizationId:id,title:named,startDate:date,endDate:date,location:short,state:short,url:sourceUrl,summary:text,sponsorshipDetails:text,evidence:z.array(z.object({url:sourceUrl,excerpt:z.string().max(4000)}).strict()).min(1).max(20),fingerprint:z.string().min(1).max(200),firstSeenAt:requiredTimestamp,lastSeenAt:requiredTimestamp,status:z.enum(['new','accepted','dismissed']),eventId:z.string().max(200)}).strict().superRefine((value,ctx)=>{
  if(value.endDate&&(!value.startDate||value.endDate<value.startDate))ctx.addIssue({code:'custom',path:['endDate'],message:'The end date must be on or after the start date.'});
  if(value.status==='accepted'&&!value.eventId)ctx.addIssue({code:'custom',path:['eventId'],message:'An accepted suggestion must link to an event.'});
  if(value.status!=='accepted'&&value.eventId)ctx.addIssue({code:'custom',path:['eventId'],message:'Only accepted suggestions can link to an event.'});
});
const run=z.object({id,startedAt:requiredTimestamp,finishedAt:requiredTimestamp,status:z.enum(['success','partial','failed']),pagesChecked:z.number().int().min(0).max(100000),candidatesFound:z.number().int().min(0).max(100000),message:z.string().max(4000)}).strict();
export const planningSchema=z.object({expenseYears:z.array(z.object({paymentId:id,year:z.number().int().min(1900).max(2200).nullable()}).strict()).max(50000),profiles:z.array(profile).max(10000),events:z.array(event).max(5000),watches:z.array(watch).max(500),discoveries:z.array(discovery).max(5000),settings:z.object({enabled:z.boolean(),intervalDays:z.literal(14),nextRunAt:timestamp,lastRunAt:timestamp}).strict(),runs:z.array(run).max(30)}).strict();

export function validatePlanning(value:unknown,organizationIds?:Iterable<string>,paymentIds?:Iterable<string>):PlanningData{
  const parsed=planningSchema.safeParse(value);
  if(!parsed.success){const issue=parsed.error.issues[0];throw new Error(`Check ${issue.path.join('.') || 'event planning'}: ${issue.message}`);}
  const d=parsed.data;
  if(new TextEncoder().encode(JSON.stringify(d)).length>20971520)throw new Error('The event planning workspace exceeds its 20 MiB limit.');
  for(const key of ['profiles','events','watches','discoveries','runs'] as const)if(new Set(d[key].map(item=>item.id)).size!==d[key].length)throw new Error(`${key} contains duplicate IDs.`);
  if(new Set(d.expenseYears.map(item=>item.paymentId)).size!==d.expenseYears.length)throw new Error('An expense has more than one applicable year override.');
  if(paymentIds){const payments=new Set(paymentIds);if(d.expenseYears.some(item=>!payments.has(item.paymentId)))throw new Error('An applicable year refers to an expense that is no longer available. Refresh the workspace.');}
  if(new Set(d.discoveries.map(item=>item.fingerprint)).size!==d.discoveries.length)throw new Error('Conference suggestions contain duplicate fingerprints.');
  if(organizationIds){const orgs=new Set(organizationIds);if(d.profiles.some(item=>!orgs.has(item.id))||[...d.events,...d.watches,...d.discoveries].some(item=>!orgs.has(item.organizationId)))throw new Error('A planning record refers to an organization that is no longer available. Refresh the workspace.');}
  const events=new Map(d.events.map(item=>[item.id,item])),discoveries=new Map(d.discoveries.map(item=>[item.id,item]));
  for(const item of d.discoveries)if(item.eventId&&(!events.has(item.eventId)||events.get(item.eventId)!.organizationId!==item.organizationId||events.get(item.eventId)!.sourceDiscoveryId!==item.id))throw new Error('An accepted suggestion must link to its matching organization and event.');
  for(const item of d.events)if(item.sourceDiscoveryId&&(!discoveries.has(item.sourceDiscoveryId)||discoveries.get(item.sourceDiscoveryId)!.organizationId!==item.organizationId))throw new Error('An event refers to a missing or different organization’s conference suggestion.');
  return d;
}

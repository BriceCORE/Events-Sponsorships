import {z} from "zod";
import type {Data} from "./types";
const text=z.string().max(20000),short=z.string().max(500),id=z.string().min(1).max(200);
const cents=z.number().int().nonnegative().max(100000000000).nullable();
const year=z.number().int().min(1900).max(2200).nullable();
const organization=z.object({id,name:short,sector:short,type:short,state:short,aliases:z.array(short).max(500)});
const allocation=z.object({organizationId:id,amountCents:z.number().int().positive().max(100000000000)});
const payment=z.object({id,sourceRow:z.number().int().nonnegative(),payee:short,description:text,amountCents:cents,originalAmountCents:cents,eventYear:year,approvalYear:year,approvalDate:short.nullable(),sector:short,type:short,state:short,allocations:z.array(allocation).max(50),confidence:short,reason:text,note:text.default(""),reviewed:z.boolean().default(false),revision:z.number().int().nonnegative().default(0)});
const benefit=z.object({id,organizationIds:z.array(id).max(50),sourceOrganization:short,program:text,trackedLevel:text,trackedPackageAmountText:text,applicability:z.object({text,years:z.array(z.number().int()),currentOrPrior:short}),benefits:z.array(text).max(500),alternatives:z.array(text).max(500),evidence:z.object({status:text,flags:z.array(text)}),potentialValue:text,sources:z.array(z.string().url().refine(u=>/^https?:\/\//i.test(u),"Sources must use http or https")).max(100),openQuestions:z.array(text).max(500),paymentRows:z.array(z.number().int()),note:text.optional(),utilization:short.optional()});
const schema=z.object({organizations:z.array(organization).max(10000),payments:z.array(payment).max(50000),benefits:z.array(benefit).max(10000),meta:z.object({source:text,researchAsOf:short,note:text})});
export function validateWorkspace(value:unknown):Data{
 const envelope=value as {format?:string;version?:number;data?:unknown};
 if(envelope?.format && (envelope.format!=="CORE Midwest workspace"||envelope.version!==1))throw new Error("This workspace file uses an unsupported format or version.");
 const parsed=schema.safeParse(envelope?.format?envelope.data:value);
 if(!parsed.success){const issue=parsed.error.issues[0];throw new Error(`This is not a valid workspace file: ${issue.path.join(".")} — ${issue.message}`)}
 const d=parsed.data;const orgs=new Set(d.organizations.map(o=>o.id));
 if(orgs.size!==d.organizations.length)throw new Error("The file contains duplicate organization IDs.");
 if(new Set(d.payments.map(p=>p.id)).size!==d.payments.length)throw new Error("The file contains duplicate expense IDs.");
 if(new Set(d.benefits.map(b=>b.id)).size!==d.benefits.length)throw new Error("The file contains duplicate benefit IDs.");
 for(const p of d.payments){
   if(p.allocations.some(a=>!orgs.has(a.organizationId)))throw new Error(`Expense ${p.id} refers to a missing organization.`);
   if(new Set(p.allocations.map(a=>a.organizationId)).size!==p.allocations.length)throw new Error(`Expense ${p.id} assigns the same organization more than once.`);
   if(p.allocations.reduce((s,a)=>s+a.amountCents,0)>(p.amountCents??0))throw new Error(`Expense ${p.id} assigns more than its recorded amount.`);
 }
 if(d.benefits.some(b=>b.organizationIds.some(o=>!orgs.has(o))))throw new Error("A benefit refers to a missing organization.");
 return d;
}
export function workspaceEnvelope(data:Data){return {format:"CORE Midwest workspace",version:1,exportedAt:new Date().toISOString(),data};}
export function exportWorkspace(data:Data){
 const blob=new Blob([JSON.stringify(workspaceEnvelope(data),null,2)],{type:"application/json"});
 const url=URL.createObjectURL(blob);const link=document.createElement("a");link.href=url;link.download=`CORE-Midwest-${new Date().toISOString().slice(0,10)}.core-workspace.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

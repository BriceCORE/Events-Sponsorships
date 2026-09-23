import type {Allocation, Payment} from "./types";
export function validateReview(input:unknown,payment:Payment,orgIds:Set<string>){
  if(!input || typeof input!=="object") throw new Error("Enter an expense assignment.");
  const x=input as Record<string,unknown>; const amount=x.amountCents;
  if(amount!==null && (!Number.isSafeInteger(amount) || Number(amount)<0 || Number(amount)>100000000000)) throw new Error("Enter a valid nonnegative amount with no more than two decimal places.");
  if(!Array.isArray(x.allocations) || x.allocations.length>50) throw new Error("Choose up to 50 organizations.");
  const ids=new Set<string>();let total=0;
  const allocations:Allocation[]=x.allocations.map((a:unknown)=>{
    if(!a || typeof a!=="object")throw new Error("Invalid assignment.");
    const v=a as Allocation;
    if(!orgIds.has(v.organizationId) || ids.has(v.organizationId))throw new Error("Choose each organization only once.");
    if(!Number.isSafeInteger(v.amountCents)||v.amountCents<=0)throw new Error("Each assignment must be greater than zero.");
    ids.add(v.organizationId);total+=v.amountCents;
    return {organizationId:v.organizationId,amountCents:v.amountCents};
  });
  if(total>Number(amount??0))throw new Error("Assigned dollars cannot exceed the expense amount.");
  if(typeof x.note!=="string"||x.note.length>4000)throw new Error("Keep the note under 4,000 characters.");
  if(amount!==payment.originalAmountCents && !x.note.trim())throw new Error("Add a note explaining the amount correction.");
  if(!Number.isInteger(x.revision)||Number(x.revision)<0)throw new Error("Reload this expense and try again.");
  if(typeof x.sector!=="string" || !x.sector.trim() || x.sector.length>80)throw new Error("Choose a market sector.");
  return {sector:x.sector.trim(),amountCents:amount as number|null,allocations,note:x.note.trim(),reviewed:x.reviewed===true,revision:Number(x.revision)};
}
export function unassigned(p:Payment){return (p.amountCents??0)-p.allocations.reduce((s,a)=>s+a.amountCents,0)}
export function applicableYear(p:Payment){return p.applicableYear===undefined?p.eventYear:p.applicableYear}
export function matchesPeriod(p:Payment,year:string,basis:string){return year==="all" || String(basis==="event"?applicableYear(p):p.approvalYear)===(year==="unknown"?"null":year)}

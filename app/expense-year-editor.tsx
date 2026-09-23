import {useState} from 'react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription,DialogFooter} from '@/components/ui/dialog';
import type {Payment} from '@/lib/types';
import type {PlanningData,PlanningSnapshot} from '@/lib/planning-types';
import {applicableYear} from '@/lib/review';

export function ExpenseYearEditor({payment,snapshot,onClose,onSave}:{payment:Payment;snapshot:PlanningSnapshot;onClose:()=>void;onSave:(data:PlanningData,expectedRevision:number)=>Promise<void>}){
  const [opening]=useState(()=>structuredClone(snapshot));
  const [year,setYear]=useState(applicableYear(payment)?.toString()??''),[useSource,setUseSource]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const save=async()=>{setBusy(true);setError('');try{
    const clean=year.trim();
    if(!useSource&&clean&&(!/^\d{4}$/.test(clean)||Number(clean)<1900||Number(clean)>2200))throw new Error('Enter a year between 1900 and 2200, or leave it blank if unknown.');
    const expenseYears=opening.data.expenseYears.filter(item=>item.paymentId!==payment.id);
    if(!useSource)expenseYears.push({paymentId:payment.id,year:clean?Number(clean):null});
    await onSave({...opening.data,expenseYears},opening.revision);onClose();
  }catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  return <Dialog open onOpenChange={open=>!open&&!busy&&onClose()}><DialogContent><DialogHeader><DialogTitle>Change applicable year</DialogTitle><DialogDescription>{payment.description||payment.payee}</DialogDescription></DialogHeader>
    <div className="source-context"><span><strong>Original cost / approval date</strong>{payment.approvalDate?.slice(0,10)||'Not recorded'}</span><span><strong>Year from source description</strong>{payment.eventYear??'Not recorded'}</span></div>
    <label className="field-label">Applicable year<Input aria-label="Applicable year" inputMode="numeric" maxLength={4} placeholder="e.g., 2026" value={year} disabled={useSource} onChange={event=>setYear(event.target.value)}/></label>
    <p className="profile-help">Choose the year this expense supports. For example, dues paid in 2025 for a 2026 membership belong to applicable year 2026. The original date and amount stay unchanged.</p>
    <label className="checkbox-line"><input type="checkbox" checked={useSource} onChange={event=>setUseSource(event.target.checked)}/>Use the source description’s year ({payment.eventYear??'unknown'})</label>
    {error&&<p role="alert" className="form-error">{error}</p>}
    <DialogFooter><Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button><Button disabled={busy} onClick={save}>{busy?'Saving…':'Save applicable year'}</Button></DialogFooter>
  </DialogContent></Dialog>;
}

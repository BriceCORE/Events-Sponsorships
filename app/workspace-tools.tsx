import {useRef, useState} from 'react';
import {Download, Upload, RefreshCw, LogOut} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter} from '@/components/ui/dialog';
import {exportWorkspace, validateWorkspace} from '@/lib/workspace-file';
import {importSharedWorkspace, localPreview, supabase, workspaceRole, workspaceRevision} from '@/lib/shared-client';
import type {Data} from '@/lib/types';
import type {PlanningData} from '@/lib/planning-types';

function exportPlanning(data:PlanningData){
  const blob=new Blob([JSON.stringify({format:'CORE Midwest event planning',version:1,exportedAt:new Date().toISOString(),data},null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`CORE-Midwest-planning-${new Date().toISOString().slice(0,10)}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

export function WorkspaceTools({data, planning, onReload}: {data: Data | null; planning?:PlanningData|null; onReload: () => Promise<void>}) {
  const [open, setOpen] = useState(false), [candidate, setCandidate] = useState<Data | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [importRevision, setImportRevision] = useState(0);
  const fileSelection = useRef(0);
  const role = workspaceRole();
  return <><div className="workspace-actions">
    <span className="connection-label"><span/>{localPreview ? 'Local preview' : role === 'viewer' ? 'Shared · view only' : 'Shared workspace'}</span>
    <Button variant="ghost" size="sm" onClick={onReload}><RefreshCw size={15}/>Refresh</Button>
    <Button variant="ghost" size="sm" disabled={!data?.payments.length} onClick={() => data && exportWorkspace(data)}><Download size={15}/>Spending backup</Button>
    {planning&&<Button variant="ghost" size="sm" onClick={()=>exportPlanning(planning)}><Download size={15}/>Planning backup</Button>}
    {role === 'owner' && !localPreview && <Button variant="ghost" size="sm" onClick={() => {setImportRevision(workspaceRevision());setOpen(true);setCandidate(null);setError('');}}><Upload size={15}/>Import workspace</Button>}
    {!localPreview && <Button variant="ghost" size="sm" onClick={async () => {const {error} = await supabase!.auth.signOut();if (error) setError(error.message);}}><LogOut size={15}/>Sign out</Button>}
  </div>{error && !open && <p role="alert" className="form-error">{error}</p>}
  <Dialog open={open} onOpenChange={v => !busy && setOpen(v)}><DialogContent><DialogHeader><DialogTitle>{data?.payments.length ? 'Replace shared workspace' : 'Import your workspace'}</DialogTitle><DialogDescription>{data?.payments.length ? 'This replaces the data for everyone in this workspace. Download a backup first, then select the workspace file you want to restore.' : 'Choose the private workspace file included with your handoff. It contains the organizations, source expenses, assignments, and researched benefits.'}</DialogDescription></DialogHeader>
    <Input aria-label="Workspace file" type="file" accept=".json,.core-workspace.json" disabled={busy} onChange={async e => {
      const selection = ++fileSelection.current;
      const file = e.target.files?.[0];setCandidate(null);setError('');if (!file) return;
      try {if (file.size > 20_000_000) throw new Error('Choose a workspace file smaller than 20 MB.');const parsed = validateWorkspace(JSON.parse(await file.text()));if (selection === fileSelection.current) setCandidate(parsed);} catch (e) {if (selection === fileSelection.current) setError((e as Error).message);}
    }}/>
    {candidate && <div className="import-summary"><strong>{candidate.organizations.length} organizations · {candidate.payments.length} expenses</strong><p>{candidate.benefits.length} benefit profiles</p><p>Recorded spending: {new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD'}).format(candidate.payments.reduce((s, p) => s + (p.amountCents || 0), 0) / 100)}</p></div>}
    {error && <p role="alert" className="form-error">{error}</p>}
    <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button><Button disabled={!candidate || busy} onClick={async () => {
      setBusy(true);setError('');try {
        if(candidate&&planning){
          const organizations=new Set(candidate.organizations.map(item=>item.id)),payments=new Set(candidate.payments.map(item=>item.id));
          const referenced=[...planning.profiles.map(item=>item.id),...planning.events.map(item=>item.organizationId),...planning.watches.map(item=>item.organizationId),...planning.discoveries.map(item=>item.organizationId)];
          if(referenced.some(id=>!organizations.has(id))||planning.expenseYears.some(item=>!payments.has(item.paymentId)))throw new Error('This file removes organizations or expenses used by your event plans, profiles, or applicable-year adjustments. Keep those original IDs in the replacement file.');
        }
        await importSharedWorkspace(candidate, importRevision);await onReload();setOpen(false);
      } catch (e) {setError((e as Error).message);} finally {setBusy(false);}
    }}>{busy ? 'Importing…' : data?.payments.length ? 'Replace workspace for everyone' : 'Import shared workspace'}</Button></DialogFooter>
  </DialogContent></Dialog></>;
}

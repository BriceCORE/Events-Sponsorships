import {useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription,DialogFooter} from '@/components/ui/dialog';
import type {Organization} from '@/lib/types';
import type {OrganizationProfile,PlanningSnapshot,PlanningData} from '@/lib/planning-types';
import {OrganizationLogo} from './organization-logo';

export function applyOrganizationProfiles(organizations:Organization[],profiles:OrganizationProfile[]):OrganizationProfile[]{
  const overrides=new Map(profiles.map(p=>[p.id,p]));
  return organizations.map(o=>overrides.get(o.id)??({...o,description:'',website:'',contactName:'',contactEmail:'',contactPhone:'',logoUrl:'',updatedAt:''}));
}

async function prepareLogo(file:File):Promise<string>{
  if(!['image/png','image/jpeg','image/webp'].includes(file.type))throw new Error('Choose a PNG, JPG, or WebP image.');
  if(file.size>8_000_000)throw new Error('Choose an image smaller than 8 MB.');
  const url=URL.createObjectURL(file);
  try{
    const img=new Image();img.src=url;
    await img.decode();
    if(!img.naturalWidth||!img.naturalHeight)throw new Error('This image could not be opened.');
    const scale=Math.min(1,480/img.naturalWidth,480/img.naturalHeight);
    const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));
    const context=canvas.getContext('2d');if(!context)throw new Error('Image processing is unavailable in this browser.');
    context.drawImage(img,0,0,canvas.width,canvas.height);
    for(const quality of [.9,.75,.55,.35]){const result=canvas.toDataURL('image/webp',quality);if(result.length<=220000)return result;}
    throw new Error('This image is too detailed. Try a smaller logo.');
  }finally{URL.revokeObjectURL(url);}
}

export function OrganizationProfileEditor({organization,snapshot,onClose,onSave}:{organization:OrganizationProfile;snapshot:PlanningSnapshot;onClose:()=>void;onSave:(data:PlanningData,expectedRevision:number)=>Promise<void>}){
  const [draft,setDraft]=useState(()=>structuredClone(organization));
  const [opening]=useState(()=>structuredClone(snapshot));
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[imageBusy,setImageBusy]=useState(false);
  const imageGeneration=useRef(0);
  const set=(key:keyof OrganizationProfile,value:string)=>setDraft(d=>({...d,[key]:value}));
  const save=async()=>{
    setBusy(true);setError('');
    try{
      const profile={...draft,name:draft.name.trim(),sector:draft.sector.trim(),updatedAt:new Date().toISOString()};
      if(!profile.name||!profile.sector)throw new Error('Enter an organization name and market sector.');
      profile.aliases=[...new Set([...profile.aliases,organization.name].map(s=>s.trim()).filter(Boolean))];
      const profiles=opening.data.profiles.filter(p=>p.id!==profile.id).concat(profile);
      await onSave({...opening.data,profiles},opening.revision);onClose();
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  };
  return <Dialog open onOpenChange={open=>!open&&!busy&&!imageBusy&&onClose()}><DialogContent className="organization-profile-dialog"><DialogHeader><DialogTitle>Edit organization</DialogTitle><DialogDescription>Update the shared name, picture, and contact details for this organization.</DialogDescription></DialogHeader>
    <div className="profile-picture-editor"><OrganizationLogo organization={draft} size="large"/><div><label className="field-label">Upload a picture<Input aria-label="Organization picture" type="file" accept="image/png,image/jpeg,image/webp" disabled={busy||imageBusy} onChange={async e=>{
      const generation=++imageGeneration.current;const file=e.target.files?.[0];if(!file)return;setImageBusy(true);setError('');
      try{const image=await prepareLogo(file);if(generation===imageGeneration.current)set('logoUrl',image);}catch(e){if(generation===imageGeneration.current)setError((e as Error).message);}finally{if(generation===imageGeneration.current)setImageBusy(false);}
    }}/></label><p className="profile-help">PNG, JPG, or WebP. Images are resized for the app.</p><Button variant="ghost" size="sm" disabled={busy||imageBusy} onClick={()=>{imageGeneration.current++;set('logoUrl','')}}>Use original picture</Button></div></div>
    <label className="field-label">Picture URL<Input type="url" aria-label="Picture URL" value={draft.logoUrl.startsWith('data:')?'':draft.logoUrl} placeholder={draft.logoUrl.startsWith('data:')?'Uploaded picture selected':'https://…'} disabled={imageBusy} onChange={e=>set('logoUrl',e.target.value)}/></label>
    <div className="profile-form-grid"><label className="field-label">Organization name<Input value={draft.name} onChange={e=>set('name',e.target.value)}/></label><label className="field-label">Organization type<Input value={draft.type} onChange={e=>set('type',e.target.value)}/></label><label className="field-label">Market sector<Input value={draft.sector} onChange={e=>set('sector',e.target.value)}/></label><label className="field-label">Organization state<Input value={draft.state} placeholder="IN, IL…" onChange={e=>set('state',e.target.value)}/></label></div>
    <label className="field-label">Details<Textarea rows={3} value={draft.description} onChange={e=>set('description',e.target.value)}/></label>
    <label className="field-label">Website<Input type="url" value={draft.website} placeholder="https://…" onChange={e=>set('website',e.target.value)}/></label>
    <div className="profile-form-grid"><label className="field-label">Contact name<Input value={draft.contactName} onChange={e=>set('contactName',e.target.value)}/></label><label className="field-label">Contact email<Input type="email" value={draft.contactEmail} onChange={e=>set('contactEmail',e.target.value)}/></label><label className="field-label">Contact phone<Input type="tel" value={draft.contactPhone} onChange={e=>set('contactPhone',e.target.value)}/></label></div>
    <p className="profile-help">Historical expense states and original tracker names stay in the source records. This profile is shared with everyone.</p>
    {error&&<p role="alert" className="form-error">{error}</p>}
    <DialogFooter><Button variant="outline" disabled={busy||imageBusy} onClick={onClose}>Cancel</Button><Button disabled={busy||imageBusy} onClick={save}>{imageBusy?'Preparing picture…':busy?'Saving…':'Save organization'}</Button></DialogFooter>
  </DialogContent></Dialog>;
}

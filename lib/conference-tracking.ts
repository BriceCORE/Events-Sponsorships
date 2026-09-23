import type {Benefit,Organization,Payment} from './types';
import type {ConferenceWatch} from './planning-types';

export type WatchSuggestion={key:string;organizationId:string;name:string;sourceUrls:string[];evidence:string};
export type WatchDraft=Omit<ConferenceWatch,'id'>;
const conferencePattern=/\b(conference|summit|convention|expo|annual meeting|symposium|forum)\b/i;
const shortName=(value:string)=>value.trim().slice(0,500).replace(/[\uD800-\uDBFF]$/,'');

export function trackingKey(organizationId:string,name:string):string{
  return JSON.stringify([organizationId,name.normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase()]);
}

export function normalizeSourceUrls(input:string|string[]):string[]{
  const values=typeof input==='string'?input.split(/\r?\n/):input;
  const urls:string[]=[];
  for(const value of values){
    const clean=value.trim();
    if(!clean)continue;
    try{
      const url=new URL(clean);
      if(clean.length>2000||url.href.length>2000||!/^https?:$/.test(url.protocol)||!url.hostname||url.username||url.password||/[\s\\]/.test(clean))throw new Error();
      if(!urls.includes(url.href))urls.push(url.href);
    }catch{throw new Error('Use complete source links starting with https:// or http://, without spaces or passwords (up to 2,000 characters each).');}
  }
  if(urls.length>20)throw new Error('Use up to 20 official source pages per conference.');
  return urls;
}

export function addConferenceWatches(watches:ConferenceWatch[],drafts:WatchDraft[],makeId=()=>'watch-'+crypto.randomUUID()):{watches:ConferenceWatch[];added:ConferenceWatch[];skipped:number}{
  const known=new Set(watches.map(watch=>trackingKey(watch.organizationId,watch.name))),ids=new Set(watches.map(watch=>watch.id));
  const added:ConferenceWatch[]=[];
  let skipped=0;
  for(const draft of drafts){
    const name=draft.name.trim();
    if(!draft.organizationId.trim()||draft.organizationId.length>200||!name||name.length>500)throw new Error('Choose an organization and enter a conference name of up to 500 characters.');
    const key=trackingKey(draft.organizationId,name);
    if(known.has(key)){skipped++;continue;}
    if(draft.searchTerms.length>1000)throw new Error('Keep conference search terms within 1,000 characters.');
    const sourceUrls=normalizeSourceUrls(draft.sourceUrls);
    const id=makeId();
    if(!id||id.length>200||ids.has(id))throw new Error('The conference ID could not be created. Please try again.');
    added.push({id,organizationId:draft.organizationId,name,sourceUrls,searchTerms:draft.searchTerms.trim(),enabled:draft.enabled&&sourceUrls.length>0});
    known.add(key);ids.add(id);
  }
  if(watches.length+added.length>500)throw new Error('The tracker supports up to 500 conferences. Select fewer conferences to add.');
  return {watches:[...watches,...added],added,skipped};
}

export function watchSuggestions(organizations:Organization[],benefits:Benefit[],payments:Payment[],watches:ConferenceWatch[]):WatchSuggestion[]{
  const orgIds=new Set(organizations.map(org=>org.id)),tracked=new Set(watches.flatMap(watch=>[
    trackingKey(watch.organizationId,watch.name),
    ...(conferencePattern.test(watch.searchTerms)?[trackingKey(watch.organizationId,watch.searchTerms)]:[]),
  ])),suggestions=new Map<string,WatchSuggestion>();
  // Only an explicit research-to-source-row relationship suppresses a spending description.
  // Similar titles or a shared organization alone do not prove two conferences are the same.
  const linkedRows=new Set<string>();
  const add=(organizationId:string,rawName:string,sources:string[],evidence:string)=>{
    const name=shortName(rawName),key=trackingKey(organizationId,name);
    if(!orgIds.has(organizationId)||!conferencePattern.test(rawName)||tracked.has(key))return;
    const sourceUrls:string[]=[];
    for(const source of sources){try{sourceUrls.push(...normalizeSourceUrls([source]));}catch{/* Invalid old research links need a replacement before tracking. */}}
    const previous=suggestions.get(key);
    if(previous){previous.sourceUrls=[...new Set([...previous.sourceUrls,...sourceUrls])].slice(0,20);return;}
    suggestions.set(key,{key,organizationId,name,sourceUrls:[...new Set(sourceUrls)].slice(0,20),evidence});
  };
  for(const benefit of benefits){
    if(!conferencePattern.test(benefit.program))continue;
    for(const organizationId of benefit.organizationIds){
      if(!orgIds.has(organizationId))continue;
      for(const row of benefit.paymentRows)linkedRows.add(JSON.stringify([organizationId,row]));
      add(organizationId,benefit.program,benefit.sources,'From existing benefit research: '+benefit.sourceOrganization);
    }
  }
  for(const payment of payments){
    if(!conferencePattern.test(payment.description))continue;
    for(const allocation of payment.allocations){
      if(linkedRows.has(JSON.stringify([allocation.organizationId,payment.sourceRow])))continue;
      add(allocation.organizationId,payment.description,[],'From a historical spending description'+(payment.eventYear?' ('+payment.eventYear+')':'')+'. Confirm the recurring conference name and organizer page.');
    }
  }
  return [...suggestions.values()];
}

import {useEffect,useState} from "react";
import catalog from "@/lib/logo-catalog.json";
import type {Organization} from "@/lib/types";
export type LogoEntry={path:string;sourcePage:string;assetUrl:string;kind:string;identityScope?:string;requiresDarkBackground?:boolean;note?:string};
export function OrganizationLogo({organization,size="small"}:{organization:Organization&{logoUrl?:string};size?:"small"|"large"}){
 const entry=(catalog as Record<string,LogoEntry>)[organization.id];const [failed,setFailed]=useState(false);
 const custom=organization.logoUrl&&/^(https:\/\/|data:image\/(png|jpeg|webp|gif);base64,)/i.test(organization.logoUrl)?organization.logoUrl:'';
 const src=custom||(entry?import.meta.env.BASE_URL+entry.path:'');
 useEffect(()=>setFailed(false),[src]);
 const initials=organization.name.split(/\s+/).filter(w=>!['of','and','the','&'].includes(w.toLowerCase())).slice(0,2).map(w=>w[0]).join("").toUpperCase();
 return <span className={"organization-logo "+size+(!custom&&entry?.requiresDarkBackground?" dark-logo":"")} title={custom?organization.name+" — workspace picture":entry&&!failed?organization.name+" — "+(entry.identityScope&&entry.identityScope!=="organization"?"related organization or program mark":"sourced from its organization website"):organization.name+" — logo not yet verified"}>{src&&!failed?<img src={src} alt={organization.name+" organization mark"} loading="lazy" referrerPolicy="no-referrer" onError={()=>setFailed(true)}/>:<span aria-label={organization.name}>{initials}</span>}</span>
}
export function LogoSource({organization}:{organization:Organization&{logoUrl?:string}}){
 if(organization.logoUrl)return <p className="logo-source">Picture provided by your workspace.</p>;
 const entry=(catalog as Record<string,LogoEntry>)[organization.id];
 if(!entry)return null;
 const related=entry.identityScope&&entry.identityScope!=="organization";
 return <p className="logo-source"><a href={entry.sourcePage} target="_blank" rel="noreferrer">{related?"Related organization / program mark":"Organization logo source"}</a>{related&&entry.note?<span> · {entry.note}</span>:null}</p>;
}

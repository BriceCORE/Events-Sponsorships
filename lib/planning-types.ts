import type {Organization} from './types';

export type OrganizationProfile = Organization & {
  description:string; website:string; contactName:string; contactEmail:string; contactPhone:string;
  logoUrl:string; updatedAt:string;
};
export type EventDecision = 'needs_review'|'attend'|'sponsor'|'attend_and_sponsor'|'decline';
export type EventTask = {id:string;title:string;owner:string;dueDate:string;done:boolean};
export type EventRecord = {
  id:string; organizationId:string; title:string; startDate:string; endDate:string;
  location:string; state:string; sector:string; website:string; description:string;
  sponsorshipLevel:string; estimatedCostCents:number|null; decision:EventDecision; decisionNotes:string;
  invoice:{status:'not_received'|'awaiting_payment'|'paid';amountCents:number|null;reference:string;paidOn:string;confirmedBy:string;note:string};
  tasks:EventTask[];
  plan:{objectives:string;audience:string;attendees:string;logistics:string;materials:string;followUp:string};
  debrief:{completedOn:string;attendance:string;meetings:string;leads:string;opportunities:string;whatWorked:string;improvements:string;followUp:string;notes:string};
  sourceDiscoveryId:string; createdAt:string; updatedAt:string;
};
export type ConferenceWatch = {id:string;organizationId:string;name:string;sourceUrls:string[];searchTerms:string;enabled:boolean};
export type Discovery = {
  id:string;watchId:string;organizationId:string;title:string;startDate:string;endDate:string;
  location:string;state:string;url:string;summary:string;sponsorshipDetails:string;
  evidence:{url:string;excerpt:string}[];fingerprint:string;firstSeenAt:string;lastSeenAt:string;
  status:'new'|'accepted'|'dismissed';eventId:string;
};
export type DiscoveryRun = {id:string;startedAt:string;finishedAt:string;status:'success'|'partial'|'failed';pagesChecked:number;candidatesFound:number;message:string};
export type DiscoverySettings = {enabled:boolean;intervalDays:14;nextRunAt:string;lastRunAt:string};
export type ExpenseYear = {paymentId:string;year:number|null};
export type PlanningData = {profiles:OrganizationProfile[];expenseYears:ExpenseYear[];events:EventRecord[];watches:ConferenceWatch[];discoveries:Discovery[];settings:DiscoverySettings;runs:DiscoveryRun[]};
export type PlanningSnapshot = {data:PlanningData;revision:number;role:'owner'|'editor'|'viewer'};
export const emptyPlanning = ():PlanningData=>({profiles:[],expenseYears:[],events:[],watches:[],discoveries:[],settings:{enabled:false,intervalDays:14,nextRunAt:'',lastRunAt:''},runs:[]});
export const newEvent = (organizationId='',sector='K-12'):EventRecord=>({
  id:'event-'+crypto.randomUUID(),organizationId,title:'',startDate:'',endDate:'',location:'',state:'',sector,website:'',description:'',
  sponsorshipLevel:'',estimatedCostCents:null,decision:'needs_review',decisionNotes:'',
  invoice:{status:'not_received',amountCents:null,reference:'',paidOn:'',confirmedBy:'',note:''},tasks:[],
  plan:{objectives:'',audience:'',attendees:'',logistics:'',materials:'',followUp:''},
  debrief:{completedOn:'',attendance:'',meetings:'',leads:'',opportunities:'',whatWorked:'',improvements:'',followUp:'',notes:''},
  sourceDiscoveryId:'',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),
});

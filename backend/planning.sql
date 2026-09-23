-- CORE Midwest event planning, organization profiles, and conference discovery.
-- Run AFTER backend/supabase.sql. Safe to rerun; existing spending data is untouched.
-- Keep core_planning_private OUT of the Supabase Data API exposed schemas.
begin;
create schema if not exists core_planning_private;
revoke all on schema core_planning_private from public, anon, authenticated, service_role;
grant usage on schema core_planning_private to authenticated, service_role;
create table if not exists public.workspace_planning (
  workspace_id text primary key check (length(workspace_id) between 1 and 200),
  payload jsonb not null,
  revision bigint not null default 0 check (revision >= 0),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);
alter table public.workspace_planning enable row level security;
revoke all on public.workspace_planning from public, anon, authenticated;
grant select on public.workspace_planning to authenticated;
drop policy if exists core_planning_member_read on public.workspace_planning;
create policy core_planning_member_read on public.workspace_planning for select to authenticated
  using (workspace_id in (select m.workspace_id from public.workspace_members m where m.user_id=(select auth.uid())));
-- Upgrade an earlier local preview payload without overwriting its saved planning.
update public.workspace_planning set payload=payload||'{"expenseYears":[]}'::jsonb,
  revision=revision+1,updated_at=now() where not payload ? 'expenseYears';

create or replace function core_planning_private.empty_data()
returns jsonb language sql immutable security invoker set search_path = '' as $$
  select '{"expenseYears":[],"profiles":[],"events":[],"watches":[],"discoveries":[],"settings":{"enabled":false,"intervalDays":14,"nextRunAt":"","lastRunAt":""},"runs":[]}'::jsonb;
$$;

-- Strict recursive validation; unknown fields are rejected, including nested objects.
create or replace function core_planning_private.assert_shape(v jsonb, spec jsonb, path text)
returns void language plpgsql security invoker set search_path = '' as $$
declare k text; child jsonb; typ text; n numeric; s text; ix integer := 0; fmt text; parsed_date date; parsed_ts timestamptz;
begin
  if v is null then raise sqlstate 'PT422' using message='Missing value: '||path; end if;
  if v='null'::jsonb and coalesce((spec->>'nullable')::boolean,false) then return; end if;
  typ:=spec->>'type';
  if jsonb_typeof(v)<>typ then raise sqlstate 'PT422' using message='Invalid type: '||path; end if;
  if spec ? 'enum' and not (spec->'enum' @> jsonb_build_array(v)) then raise sqlstate 'PT422' using message='Invalid choice: '||path; end if;
  if typ='object' then
    for k in select jsonb_object_keys(v) loop
      if not (spec->'fields' ? k) then raise sqlstate 'PT422' using message='Unexpected field: '||path||'.'||k; end if;
    end loop;
    for k,child in select key,value from jsonb_each(spec->'fields') loop
      perform core_planning_private.assert_shape(v->k,child,path||'.'||k);
    end loop;
  elsif typ='array' then
    if jsonb_array_length(v)>coalesce((spec->>'max')::integer,500) or jsonb_array_length(v)<coalesce((spec->>'min')::integer,0) then
      raise sqlstate 'PT422' using message='Invalid item count: '||path;
    end if;
    for child in select value from jsonb_array_elements(v) loop
      perform core_planning_private.assert_shape(child,spec->'items',path||'['||ix||']'); ix:=ix+1;
    end loop;
  elsif typ='number' then
    n:=(v #>> '{}')::numeric;
    if n<>trunc(n) or n<coalesce((spec->>'min')::numeric,0) or n>coalesce((spec->>'max')::numeric,9007199254740991) then
      raise sqlstate 'PT422' using message='Invalid integer or amount: '||path;
    end if;
  elsif typ='string' then
    s:=v #>> '{}'; fmt:=spec->>'format';
    if length(s)>coalesce((spec->>'max')::integer,10000) or length(btrim(s))<coalesce((spec->>'min')::integer,0) then
      raise sqlstate 'PT422' using message='Invalid text length: '||path;
    end if;
    if fmt in ('date','timestamp','url','logo') and s<>'' then
      if fmt='date' then
        if s !~ '^\d{4}-\d{2}-\d{2}$' or s<'1900-01-01' or s>'2200-12-31' then raise sqlstate 'PT422' using message='Invalid date: '||path; end if;
        begin parsed_date:=s::date;
          exception when invalid_datetime_format or datetime_field_overflow then raise sqlstate 'PT422' using message='Invalid date: '||path;
        end;
        if to_char(parsed_date,'YYYY-MM-DD')<>s then raise sqlstate 'PT422' using message='Invalid date: '||path; end if;
      elsif fmt='timestamp' then
        if s !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$' then raise sqlstate 'PT422' using message='Invalid timestamp: '||path; end if;
        begin parsed_ts:=s::timestamptz;
          exception when invalid_datetime_format or datetime_field_overflow then raise sqlstate 'PT422' using message='Invalid timestamp: '||path;
        end;
      elsif fmt='logo' and s ~ '^data:image/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$' then null;
      elsif s !~ '^https?://(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?)(:[0-9]{1,5})?([/?#][^[:space:]\\]*)?$'
        or (fmt='logo' and (s !~ '^https://' or length(s)>2000)) then
        raise sqlstate 'PT422' using message='Use a safe http or https address, or an approved image format: '||path;
      end if;
    end if;
  end if;
end;
$$;

create or replace function core_planning_private.validate_data(d jsonb, p_workspace_id text)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  st jsonb:='{"type":"string","max":10000}'; sh jsonb:='{"type":"string","max":500}';
  named jsonb:='{"type":"string","min":1,"max":500}'; ident jsonb:='{"type":"string","min":1,"max":200}';
  date_spec jsonb:='{"type":"string","max":10,"format":"date"}';
  timestamp_spec jsonb:='{"type":"string","min":1,"max":40,"format":"timestamp"}';
  url_spec jsonb:='{"type":"string","max":2000,"format":"url"}';
  cents jsonb:='{"type":"number","min":1,"max":100000000000,"nullable":true}';
  bool jsonb:='{"type":"boolean"}'; profile_spec jsonb; task_spec jsonb; event_spec jsonb; watch_spec jsonb; discovery_spec jsonb; run_spec jsonb; spec jsonb;
  item jsonb; subitem jsonb; oid text; category text; key text; seen jsonb; tasks_seen jsonb;
  orgids jsonb; paymentids jsonb; eventids jsonb; discoveryids jsonb; fingerprints jsonb:='{}';
begin
  if d is null or octet_length(d::text)>20971520 then raise sqlstate 'PT422' using message='Event planning must fit within 20 MiB.'; end if;
  profile_spec:=jsonb_build_object('type','object','fields',jsonb_build_object(
    'id',ident,'name',named,'sector',named,'type',sh,'state',sh,'aliases',jsonb_build_object('type','array','max',500,'items',sh),
    'description',st,'website',url_spec,'contactName',sh,'contactEmail',sh,'contactPhone',sh,
    'logoUrl','{"type":"string","max":220000,"format":"logo"}'::jsonb,'updatedAt',timestamp_spec));
  task_spec:=jsonb_build_object('type','object','fields',jsonb_build_object('id',ident,'title',named,'owner',sh,'dueDate',date_spec,'done',bool));
  event_spec:=jsonb_build_object('type','object','fields',jsonb_build_object(
    'id',ident,'organizationId',ident,'title',named,'startDate',date_spec,'endDate',date_spec,'location',sh,'state',sh,'sector',named,
    'website',url_spec,'description',st,'sponsorshipLevel',sh,'estimatedCostCents',cents,
    'decision','{"type":"string","enum":["needs_review","attend","sponsor","attend_and_sponsor","decline"]}'::jsonb,'decisionNotes',st,
    'invoice',jsonb_build_object('type','object','fields',jsonb_build_object('status','{"type":"string","enum":["not_received","awaiting_payment","paid"]}'::jsonb,'amountCents',cents,'reference',sh,'paidOn',date_spec,'confirmedBy',sh,'note',st)),
    'tasks',jsonb_build_object('type','array','max',100,'items',task_spec),
    'plan',jsonb_build_object('type','object','fields',jsonb_build_object('objectives',st,'audience',st,'attendees',st,'logistics',st,'materials',st,'followUp',st)),
    'debrief',jsonb_build_object('type','object','fields',jsonb_build_object('completedOn',date_spec,'attendance',st,'meetings',st,'leads',st,'opportunities',st,'whatWorked',st,'improvements',st,'followUp',st,'notes',st)),
    'sourceDiscoveryId','{"type":"string","max":200}'::jsonb,'createdAt',timestamp_spec,'updatedAt',timestamp_spec));
  watch_spec:=jsonb_build_object('type','object','fields',jsonb_build_object('id',ident,'organizationId',ident,'name',named,'sourceUrls',jsonb_build_object('type','array','max',20,'items',url_spec||'{"min":1}'),'searchTerms','{"type":"string","max":1000}'::jsonb,'enabled',bool));
  discovery_spec:=jsonb_build_object('type','object','fields',jsonb_build_object(
    'id',ident,'watchId',ident,'organizationId',ident,'title',named,'startDate',date_spec,'endDate',date_spec,'location',sh,'state',sh,
    'url',url_spec||'{"min":1}','summary',st,'sponsorshipDetails',st,
    'evidence',jsonb_build_object('type','array','min',1,'max',20,'items',jsonb_build_object('type','object','fields',jsonb_build_object('url',url_spec||'{"min":1}','excerpt','{"type":"string","max":4000}'::jsonb))),
    'fingerprint',ident,'firstSeenAt',timestamp_spec,'lastSeenAt',timestamp_spec,
    'status','{"type":"string","enum":["new","accepted","dismissed"]}'::jsonb,'eventId','{"type":"string","max":200}'::jsonb));
  run_spec:=jsonb_build_object('type','object','fields',jsonb_build_object('id',ident,'startedAt',timestamp_spec,'finishedAt',timestamp_spec,
    'status','{"type":"string","enum":["success","partial","failed"]}'::jsonb,'pagesChecked','{"type":"number","max":100000}'::jsonb,'candidatesFound','{"type":"number","max":100000}'::jsonb,'message','{"type":"string","max":4000}'::jsonb));
  spec:=jsonb_build_object('type','object','fields',jsonb_build_object(
    'expenseYears',jsonb_build_object('type','array','max',50000,'items',jsonb_build_object('type','object','fields',jsonb_build_object('paymentId',ident,'year','{"type":"number","min":1900,"max":2200,"nullable":true}'::jsonb))),
    'profiles',jsonb_build_object('type','array','max',10000,'items',profile_spec),
    'events',jsonb_build_object('type','array','max',5000,'items',event_spec),
    'watches',jsonb_build_object('type','array','max',500,'items',watch_spec),
    'discoveries',jsonb_build_object('type','array','max',5000,'items',discovery_spec),
    'runs',jsonb_build_object('type','array','max',30,'items',run_spec),
    'settings',jsonb_build_object('type','object','fields',jsonb_build_object('enabled',bool,'intervalDays','{"type":"number","enum":[14]}'::jsonb,'nextRunAt',timestamp_spec||'{"min":0}','lastRunAt',timestamp_spec||'{"min":0}'))));
  perform core_planning_private.assert_shape(d,spec,'planning');
  select coalesce(jsonb_object_agg(o->>'id',true),'{}'::jsonb) into orgids
    from public.workspace_state s cross join lateral jsonb_array_elements(s.payload->'organizations') o where s.workspace_id=p_workspace_id;
  select coalesce(jsonb_object_agg(p->>'id',true),'{}'::jsonb) into paymentids
    from public.workspace_state s cross join lateral jsonb_array_elements(s.payload->'payments') p where s.workspace_id=p_workspace_id;
  seen:='{}';
  for item in select value from jsonb_array_elements(d->'expenseYears') loop
    key:=item->>'paymentId';
    if seen ? key then raise sqlstate 'PT422' using message='Duplicate applicable year for expense: '||key; end if;
    if not paymentids ? key then raise sqlstate 'PT422' using message='Applicable year refers to an unavailable expense: '||key; end if;
    seen:=seen||jsonb_build_object(key,true);
  end loop;
  foreach category in array array['profiles','events','watches','discoveries','runs'] loop
    seen:='{}';
    for item in select value from jsonb_array_elements(d->category) loop
      key:=item->>'id';
      if seen ? key then raise sqlstate 'PT422' using message='Duplicate ID in '||category||': '||key; end if;
      seen:=seen||jsonb_build_object(key,true);
      if category<>'runs' then
        oid:=case when category='profiles' then key else item->>'organizationId' end;
        if not orgids ? oid then raise sqlstate 'PT422' using message='Planning references an unavailable organization: '||oid; end if;
      end if;
    end loop;
  end loop;
  select coalesce(jsonb_object_agg(v->>'id',v),'{}'::jsonb) into eventids from jsonb_array_elements(d->'events') v;
  select coalesce(jsonb_object_agg(v->>'id',v),'{}'::jsonb) into discoveryids from jsonb_array_elements(d->'discoveries') v;
  for item in select value from jsonb_array_elements(d->'events') loop
    if item->>'endDate'<>'' and (item->>'startDate'='' or item->>'endDate'<item->>'startDate') then raise sqlstate 'PT422' using message='Event end date must follow its start date.'; end if;
    subitem:=item->'invoice';
    if subitem->>'status'='paid' and (subitem->>'paidOn'='' or btrim(subitem->>'confirmedBy')='' or (btrim(subitem->>'reference')='' and btrim(subitem->>'note')='')) then raise sqlstate 'PT422' using message='Paid invoices require a date, confirmation name, and reference or note.'; end if;
    if item->>'sourceDiscoveryId'<>'' and (not discoveryids ? (item->>'sourceDiscoveryId') or discoveryids->(item->>'sourceDiscoveryId')->>'organizationId'<>item->>'organizationId') then raise sqlstate 'PT422' using message='Event must link to a matching conference suggestion.'; end if;
    tasks_seen:='{}';
    for subitem in select value from jsonb_array_elements(item->'tasks') loop
      if tasks_seen ? (subitem->>'id') then raise sqlstate 'PT422' using message='Duplicate event task ID.'; end if;
      tasks_seen:=tasks_seen||jsonb_build_object(subitem->>'id',true);
    end loop;
  end loop;
  for item in select value from jsonb_array_elements(d->'discoveries') loop
    if fingerprints ? (item->>'fingerprint') then raise sqlstate 'PT422' using message='Duplicate conference suggestion fingerprint.'; end if;
    fingerprints:=fingerprints||jsonb_build_object(item->>'fingerprint',true);
    if item->>'endDate'<>'' and (item->>'startDate'='' or item->>'endDate'<item->>'startDate') then raise sqlstate 'PT422' using message='Suggestion end date must follow its start date.'; end if;
    if item->>'status'='accepted' then
      subitem:=eventids->(item->>'eventId');
      if subitem is null or subitem->>'organizationId'<>item->>'organizationId' or subitem->>'sourceDiscoveryId'<>item->>'id' then raise sqlstate 'PT422' using message='Accepted suggestion must link to its matching event.'; end if;
    elsif item->>'eventId'<>'' then raise sqlstate 'PT422' using message='Only accepted suggestions can link to an event.';
    end if;
  end loop;
end;
$$;

create or replace function core_planning_private.get_planning(p_workspace_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare member_role text; s public.workspace_planning%rowtype;
begin
  if auth.uid() is null then raise sqlstate 'PT401' using message='Sign in to open event planning.'; end if;
  select m.role into member_role from public.workspace_members m where m.workspace_id=p_workspace_id and m.user_id=auth.uid();
  if member_role is null then raise sqlstate 'PT403' using message='You are not a member of this workspace.'; end if;
  select * into s from public.workspace_planning where workspace_id=p_workspace_id;
  return jsonb_build_object('data',coalesce(s.payload,core_planning_private.empty_data()),'revision',coalesce(s.revision,0),'role',member_role);
end;
$$;

create or replace function core_planning_private.save_planning(p_workspace_id text,p_payload jsonb,p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare member_role text; s public.workspace_planning%rowtype; old_item jsonb; new_item jsonb; old_map jsonb; new_map jsonb;
begin
  if auth.uid() is null then raise sqlstate 'PT401' using message='Sign in to save event planning.'; end if;
  if p_workspace_id is null or length(p_workspace_id) not between 1 and 200 or p_expected_revision is null or p_expected_revision<0 then raise sqlstate 'PT422' using message='Invalid workspace or expected revision.'; end if;
  select m.role into member_role from public.workspace_members m where m.workspace_id=p_workspace_id and m.user_id=auth.uid() for share;
  if member_role is null or member_role='viewer' then raise sqlstate 'PT403' using message='Editor or owner access is required to change event planning.'; end if;
  -- Source workspace first, then planning: this matches the import trigger lock order.
  -- An import cannot remove a reference between validation and committing this save.
  perform 1 from public.workspace_state where workspace_id=p_workspace_id for share;
  insert into public.workspace_planning(workspace_id,payload) values(p_workspace_id,core_planning_private.empty_data()) on conflict do nothing;
  select * into s from public.workspace_planning where workspace_id=p_workspace_id for update;
  if s.revision<>p_expected_revision then raise sqlstate 'PT409' using message='Event planning changed. Refresh before saving; your draft was not written.'; end if;
  perform core_planning_private.validate_data(p_payload,p_workspace_id);
  if s.payload->'runs' is distinct from p_payload->'runs' or ((s.payload->'settings')-'enabled') is distinct from ((p_payload->'settings')-'enabled') then raise sqlstate 'PT422' using message='Conference search history and run dates are maintained by the scheduled search.'; end if;
  if jsonb_array_length(s.payload->'discoveries')<>jsonb_array_length(p_payload->'discoveries') then raise sqlstate 'PT422' using message='Conference suggestions cannot be added or removed manually; dismiss a suggestion instead.'; end if;
  select coalesce(jsonb_object_agg(v->>'id',v),'{}'::jsonb) into new_map from jsonb_array_elements(p_payload->'discoveries') v;
  for old_item in select value from jsonb_array_elements(s.payload->'discoveries') loop
    new_item:=new_map->(old_item->>'id');
    if new_item is null or (old_item-array['status','eventId']) is distinct from (new_item-array['status','eventId']) then raise sqlstate 'PT422' using message='Conference source details and evidence must remain unchanged.'; end if;
  end loop;
  select coalesce(jsonb_object_agg(v->>'id',v),'{}'::jsonb) into new_map from jsonb_array_elements(p_payload->'events') v;
  for old_item in select value from jsonb_array_elements(s.payload->'events') loop
    new_item:=new_map->(old_item->>'id');
    if new_item is null then raise sqlstate 'PT422' using message='Events cannot be removed; record a decline decision instead.'; end if;
    if old_item->'createdAt' is distinct from new_item->'createdAt' or old_item->'sourceDiscoveryId' is distinct from new_item->'sourceDiscoveryId' then raise sqlstate 'PT422' using message='Event creation and discovery provenance must remain unchanged.'; end if;
  end loop;
  update public.workspace_planning set payload=p_payload,revision=revision+1,updated_at=now(),updated_by=auth.uid() where workspace_id=p_workspace_id returning * into s;
  return jsonb_build_object('data',s.payload,'revision',s.revision,'role',member_role);
end;
$$;

create or replace function core_planning_private.discovery_context(p_workspace_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.workspace_planning%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise sqlstate 'PT403' using message='The scheduled conference search requires a server credential.'; end if;
  if p_workspace_id is null or length(p_workspace_id) not between 1 and 200 then raise sqlstate 'PT422' using message='Invalid workspace.'; end if;
  select * into s from public.workspace_planning where workspace_id=p_workspace_id;
  return jsonb_build_object('data',coalesce(s.payload,core_planning_private.empty_data()),'revision',coalesce(s.revision,0),'role','owner');
end;
$$;

create or replace function core_planning_private.ingest_discoveries(p_workspace_id text,p_candidates jsonb,p_run jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.workspace_planning%rowtype; d jsonb; candidate jsonb; existing jsonb; merged jsonb; watch jsonb;
  candidate_ids jsonb:='{}'; candidate_fingerprints jsonb:='{}'; by_fingerprint jsonb; watches jsonb;
  seen_at text:=to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'); old_events jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise sqlstate 'PT403' using message='The scheduled conference search requires a server credential.'; end if;
  if p_workspace_id is null or length(p_workspace_id) not between 1 and 200 then raise sqlstate 'PT422' using message='Invalid workspace.'; end if;
  if p_candidates is null or jsonb_typeof(p_candidates)<>'array' or jsonb_array_length(p_candidates)>500 or octet_length(p_candidates::text)>10485760 then raise sqlstate 'PT422' using message='A conference search may submit at most 500 candidates and 10 MiB.'; end if;
  perform 1 from public.workspace_state where workspace_id=p_workspace_id for share;
  select * into s from public.workspace_planning where workspace_id=p_workspace_id for update;
  if not found or not (s.payload->'settings'->>'enabled')::boolean then raise sqlstate 'PT409' using message='Conference search is not enabled for this workspace.'; end if;
  d:=s.payload;
  if exists(select 1 from jsonb_array_elements(d->'runs') v where v->>'id'=p_run->>'id') then
    return jsonb_build_object('data',d,'revision',s.revision,'role','owner');
  end if;
  select coalesce(jsonb_object_agg(v->>'id',v),'{}'::jsonb) into watches from jsonb_array_elements(d->'watches') v;
  select coalesce(jsonb_object_agg(v->>'fingerprint',v),'{}'::jsonb) into by_fingerprint from jsonb_array_elements(d->'discoveries') v;
  for candidate in select value from jsonb_array_elements(p_candidates) loop
    watch:=watches->(candidate->>'watchId');
    if watch is null or not (watch->>'enabled')::boolean or watch->>'organizationId' is distinct from candidate->>'organizationId' then raise sqlstate 'PT422' using message='Conference candidate must refer to a matching enabled watch.'; end if;
    if candidate->>'id' is null or candidate->>'fingerprint' is null or candidate_ids ? (candidate->>'id') or candidate_fingerprints ? (candidate->>'fingerprint') then raise sqlstate 'PT422' using message='Conference candidates require unique IDs and fingerprints.'; end if;
    candidate_ids:=candidate_ids||jsonb_build_object(candidate->>'id',true);
    candidate_fingerprints:=candidate_fingerprints||jsonb_build_object(candidate->>'fingerprint',true);
    -- Validate every candidate before deduplication, including those already known.
    candidate:=candidate||jsonb_build_object('status','new','eventId','','firstSeenAt',seen_at,'lastSeenAt',seen_at);
    perform core_planning_private.validate_data(jsonb_set(jsonb_set(d,'{discoveries}',jsonb_build_array(candidate)),'{events}','[]'::jsonb),p_workspace_id);
    existing:=by_fingerprint->(candidate->>'fingerprint');
    if existing is not null then
      if existing->>'organizationId'<>candidate->>'organizationId' or existing->>'watchId'<>candidate->>'watchId' then raise sqlstate 'PT422' using message='A conference fingerprint cannot move to another organization or watch.'; end if;
      by_fingerprint:=jsonb_set(by_fingerprint,array[candidate->>'fingerprint'],existing||jsonb_build_object('lastSeenAt',seen_at));
    else
      if (select count(*) from jsonb_object_keys(by_fingerprint))>=5000 then raise sqlstate 'PT422' using message='Conference suggestion capacity reached. Ask the workspace owner to archive older research.'; end if;
      by_fingerprint:=by_fingerprint||jsonb_build_object(candidate->>'fingerprint',candidate);
    end if;
  end loop;
  -- Keep the original array order, then append new records in deterministic order.
  select coalesce(jsonb_agg(by_fingerprint->(v->>'fingerprint') order by ord),'[]'::jsonb) into merged from jsonb_array_elements(d->'discoveries') with ordinality old(v,ord);
  for candidate in select value from jsonb_array_elements(p_candidates) loop
    if not exists(select 1 from jsonb_array_elements(merged) v where v->>'fingerprint'=candidate->>'fingerprint') then merged:=merged||jsonb_build_array(by_fingerprint->(candidate->>'fingerprint')); end if;
  end loop;
  d:=jsonb_set(d,'{discoveries}',merged);
  select coalesce(jsonb_agg(v order by ord),'[]'::jsonb) into merged from jsonb_array_elements(jsonb_build_array(p_run)||(d->'runs')) with ordinality r(v,ord) where ord<=30;
  d:=jsonb_set(d,'{runs}',merged);
  d:=jsonb_set(d,'{settings,lastRunAt}',to_jsonb(seen_at));
  d:=jsonb_set(d,'{settings,nextRunAt}',to_jsonb(to_char((now()+interval '14 days') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  perform core_planning_private.validate_data(d,p_workspace_id);
  update public.workspace_planning set payload=d,revision=revision+1,updated_at=now(),updated_by=null where workspace_id=p_workspace_id returning * into s;
  return jsonb_build_object('data',s.payload,'revision',s.revision,'role','owner');
end;
$$;

-- Protect planning references even when an older browser uses the legacy import RPC.
-- This additive trigger also applies to direct administrative ledger replacement.
create or replace function core_planning_private.protect_ledger_references()
returns trigger language plpgsql security definer set search_path = '' as $$
declare d jsonb; orgids jsonb; paymentids jsonb; item jsonb; category text; key text; source_payload jsonb;
begin
  select payload into d from public.workspace_planning where workspace_id=old.workspace_id for share;
  if d is null then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  if tg_op='DELETE' then source_payload:='{"organizations":[],"payments":[]}'::jsonb;
  else
    if new.workspace_id is distinct from old.workspace_id then raise sqlstate 'PT422' using message='A workspace with event planning cannot change its ID.'; end if;
    source_payload:=new.payload;
  end if;
  select coalesce(jsonb_object_agg(o->>'id',true),'{}'::jsonb) into orgids from jsonb_array_elements(source_payload->'organizations') o;
  select coalesce(jsonb_object_agg(p->>'id',true),'{}'::jsonb) into paymentids from jsonb_array_elements(source_payload->'payments') p;
  foreach category in array array['profiles','events','watches','discoveries'] loop
    for item in select value from jsonb_array_elements(d->category) loop
      key:=case when category='profiles' then item->>'id' else item->>'organizationId' end;
      if not orgids ? key then raise sqlstate 'PT422' using message='This import would remove an organization used in event planning. Keep organization ID: '||key; end if;
    end loop;
  end loop;
  for item in select value from jsonb_array_elements(d->'expenseYears') loop
    key:=item->>'paymentId';
    if not paymentids ? key then raise sqlstate 'PT422' using message='This import would remove an expense with an applicable year. Keep expense ID: '||key; end if;
  end loop;
  if tg_op='DELETE' then return old; else return new; end if;
end;
$$;
drop trigger if exists core_protect_planning_references on public.workspace_state;
create trigger core_protect_planning_references before update or delete on public.workspace_state
  for each row execute function core_planning_private.protect_ledger_references();

create or replace function public.core_get_planning(p_workspace_id text)
returns jsonb language sql security invoker set search_path = '' as $$ select core_planning_private.get_planning(p_workspace_id); $$;
create or replace function public.core_save_planning(p_workspace_id text,p_payload jsonb,p_expected_revision bigint)
returns jsonb language sql security invoker set search_path = '' as $$ select core_planning_private.save_planning(p_workspace_id,p_payload,p_expected_revision); $$;
create or replace function public.core_discovery_context(p_workspace_id text)
returns jsonb language sql security invoker set search_path = '' as $$ select core_planning_private.discovery_context(p_workspace_id); $$;
create or replace function public.core_ingest_discoveries(p_workspace_id text,p_candidates jsonb,p_run jsonb)
returns jsonb language sql security invoker set search_path = '' as $$ select core_planning_private.ingest_discoveries(p_workspace_id,p_candidates,p_run); $$;

revoke all on all functions in schema core_planning_private from public,anon,authenticated,service_role;
grant execute on function core_planning_private.get_planning(text),core_planning_private.save_planning(text,jsonb,bigint) to authenticated;
grant execute on function core_planning_private.discovery_context(text),core_planning_private.ingest_discoveries(text,jsonb,jsonb) to service_role;
revoke all on function public.core_get_planning(text),public.core_save_planning(text,jsonb,bigint),public.core_discovery_context(text),public.core_ingest_discoveries(text,jsonb,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.core_get_planning(text),public.core_save_planning(text,jsonb,bigint) to authenticated;
grant execute on function public.core_discovery_context(text),public.core_ingest_discoveries(text,jsonb,jsonb) to service_role;
commit;

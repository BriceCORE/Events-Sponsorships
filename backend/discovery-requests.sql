-- CORE Midwest: request a conference check from the app.
-- Run once AFTER backend/supabase.sql and backend/planning.sql; safe to rerun.
-- Keep core_discovery_private OUT of the Data API's exposed schemas.
-- No secret is stored here or sent to the browser. The trusted worker claims requests.
begin;
create schema if not exists core_discovery_private;
revoke all on schema core_discovery_private from public,anon,authenticated,service_role;
grant usage on schema core_discovery_private to authenticated,service_role;
create table if not exists core_discovery_private.queue_state (
  workspace_id text primary key check(length(workspace_id) between 1 and 200),
  last_requested_at timestamptz
);
create table if not exists public.workspace_discovery_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null check(length(workspace_id) between 1 and 200),
  status text not null check(status in ('queued','running','success','partial','failed','cancelled')),
  requested_at timestamptz not null default now(),
  requested_by uuid references auth.users(id) on delete set null,
  started_at timestamptz,
  finished_at timestamptz,
  message text not null default '' check(length(message)<=4000),
  pages_checked integer not null default 0 check(pages_checked between 0 and 100000),
  candidates_found integer not null default 0 check(candidates_found between 0 and 100000),
  run_id text check(length(run_id) between 1 and 200),
  lease_until timestamptz,
  check((status='queued' and started_at is null and finished_at is null and lease_until is null)
    or (status='running' and started_at is not null and finished_at is null and lease_until is not null)
    or (status in ('success','partial','failed','cancelled') and finished_at is not null and lease_until is null))
);
create unique index if not exists core_discovery_one_active_per_workspace
  on public.workspace_discovery_requests(workspace_id) where status in ('queued','running');
create index if not exists core_discovery_recent_requests
  on public.workspace_discovery_requests(workspace_id,requested_at desc,id desc);
alter table public.workspace_discovery_requests enable row level security;
alter table core_discovery_private.queue_state enable row level security;
revoke all on public.workspace_discovery_requests,core_discovery_private.queue_state from public,anon,authenticated,service_role;

create or replace function core_discovery_private.job_json(j public.workspace_discovery_requests)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select case when j.id is null then null else jsonb_build_object(
    'id',j.id,'status',j.status,'requestedAt',j.requested_at,'startedAt',j.started_at,
    'finishedAt',j.finished_at,'message',j.message,'pagesChecked',j.pages_checked,
    'candidatesFound',j.candidates_found,'runId',j.run_id,'leaseUntil',j.lease_until) end;
$$;

create or replace function core_discovery_private.expire_requests(p_workspace_id text)
returns void language sql security invoker set search_path = '' as $$
  update public.workspace_discovery_requests set status='failed',finished_at=lease_until,
    lease_until=null,message='The conference check timed out. You can request another check.'
    where workspace_id=p_workspace_id and status='running' and lease_until<=now();
$$;

create or replace function core_discovery_private.get_request(p_workspace_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare j public.workspace_discovery_requests%rowtype; last_requested timestamptz; result jsonb;
begin
  if auth.uid() is null then raise sqlstate 'PT401' using message='Sign in to view conference checks.'; end if;
  if not exists(select 1 from public.workspace_members m where m.workspace_id=p_workspace_id and m.user_id=auth.uid()) then raise sqlstate 'PT403' using message='You are not a member of this workspace.'; end if;
  select * into j from public.workspace_discovery_requests where workspace_id=p_workspace_id order by requested_at desc,id desc limit 1;
  select last_requested_at into last_requested from core_discovery_private.queue_state where workspace_id=p_workspace_id;
  result:=core_discovery_private.job_json(j);
  -- Reads never mutate the queue. Expose a timed-out lease as failed immediately.
  if j.status='running' and j.lease_until<=now() then
    result:=result||jsonb_build_object('status','failed','finishedAt',j.lease_until,'leaseUntil',null,
      'message','The conference check timed out. You can request another check.');
  end if;
  return jsonb_build_object('job',result,'cooldownUntil',last_requested+interval '60 seconds');
end;
$$;

create or replace function core_discovery_private.request_check(p_workspace_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare member_role text; j public.workspace_discovery_requests%rowtype; last_requested timestamptz; planning jsonb;
begin
  if auth.uid() is null then raise sqlstate 'PT401' using message='Sign in to request a conference check.'; end if;
  if p_workspace_id is null or length(p_workspace_id) not between 1 and 200 then raise sqlstate 'PT422' using message='Invalid workspace.'; end if;
  select m.role into member_role from public.workspace_members m where m.workspace_id=p_workspace_id and m.user_id=auth.uid() for share;
  if member_role is null or member_role='viewer' then raise sqlstate 'PT403' using message='Editor or owner access is required to request a conference check.'; end if;
  insert into core_discovery_private.queue_state(workspace_id) values(p_workspace_id) on conflict do nothing;
  select last_requested_at into last_requested from core_discovery_private.queue_state where workspace_id=p_workspace_id for update;
  perform core_discovery_private.expire_requests(p_workspace_id);
  select payload into planning from public.workspace_planning where workspace_id=p_workspace_id for share;
  if planning is null or not coalesce((planning->'settings'->>'enabled')::boolean,false) then raise sqlstate 'PT422' using message='Enable the conference search schedule before checking now.'; end if;
  if not exists(select 1 from jsonb_array_elements(planning->'watches') w where (w->>'enabled')::boolean and jsonb_array_length(w->'sourceUrls')>0) then raise sqlstate 'PT422' using message='Enable at least one conference with an official source page before checking now.'; end if;
  select * into j from public.workspace_discovery_requests where workspace_id=p_workspace_id and status in ('queued','running') limit 1;
  if j.id is not null then return jsonb_build_object('job',core_discovery_private.job_json(j),'cooldownUntil',last_requested+interval '60 seconds'); end if;
  if last_requested+interval '60 seconds'>now() then raise sqlstate 'PT429' using message='Please wait one minute between conference check requests.'; end if;
  insert into public.workspace_discovery_requests(workspace_id,status,requested_by,message)
    values(p_workspace_id,'queued',auth.uid(),'Queued. The scheduled worker will pick up this check shortly.') returning * into j;
  update core_discovery_private.queue_state set last_requested_at=j.requested_at where workspace_id=p_workspace_id;
  -- Keep approximately thirty recent jobs, including the active request.
  delete from public.workspace_discovery_requests where workspace_id=p_workspace_id and status not in ('queued','running') and id not in
    (select id from public.workspace_discovery_requests where workspace_id=p_workspace_id order by requested_at desc,id desc limit 30);
  return jsonb_build_object('job',core_discovery_private.job_json(j),'cooldownUntil',j.requested_at+interval '60 seconds');
end;
$$;

create or replace function core_discovery_private.claim_request(p_workspace_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare j public.workspace_discovery_requests%rowtype; last_requested timestamptz;
begin
  if auth.role() is distinct from 'service_role' then raise sqlstate 'PT403' using message='Only the trusted conference worker can claim a request.'; end if;
  if p_workspace_id is null or length(p_workspace_id) not between 1 and 200 then raise sqlstate 'PT422' using message='Invalid workspace.'; end if;
  select last_requested_at into last_requested from core_discovery_private.queue_state where workspace_id=p_workspace_id for update;
  if not found then return jsonb_build_object('job',null,'busy',false,'cooldownUntil',null); end if;
  perform core_discovery_private.expire_requests(p_workspace_id);
  if exists(select 1 from public.workspace_discovery_requests where workspace_id=p_workspace_id and status='running') then
    return jsonb_build_object('job',null,'busy',true,'cooldownUntil',last_requested+interval '60 seconds');
  end if;
  select * into j from public.workspace_discovery_requests where workspace_id=p_workspace_id and status='queued' order by requested_at,id limit 1;
  if j.id is null then return jsonb_build_object('job',null,'busy',false,'cooldownUntil',last_requested+interval '60 seconds'); end if;
  update public.workspace_discovery_requests set status='running',started_at=now(),lease_until=now()+interval '35 minutes',
    message='Checking the enabled conference sources.' where id=j.id returning * into j;
  return jsonb_build_object('job',core_discovery_private.job_json(j),'busy',false,'cooldownUntil',last_requested+interval '60 seconds');
end;
$$;

create or replace function core_discovery_private.finish_request(
  p_workspace_id text,p_request_id text,p_status text,p_run_id text,p_pages_checked integer,p_candidates_found integer,p_message text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare j public.workspace_discovery_requests%rowtype; last_requested timestamptz; run jsonb; rid text:=nullif(p_run_id,'');
begin
  if auth.role() is distinct from 'service_role' then raise sqlstate 'PT403' using message='Only the trusted conference worker can finish a request.'; end if;
  if p_workspace_id is null or length(p_workspace_id) not between 1 and 200 or p_request_id is null
    or p_status is null or p_status not in ('success','partial','failed','cancelled')
    or p_pages_checked is null or p_pages_checked not between 0 and 100000
    or p_candidates_found is null or p_candidates_found not between 0 and 100000
    or p_message is null or length(p_message)>4000 or (rid is not null and length(rid)>200) then
    raise sqlstate 'PT422' using message='Invalid conference check completion details.';
  end if;
  select last_requested_at into last_requested from core_discovery_private.queue_state where workspace_id=p_workspace_id for update;
  select * into j from public.workspace_discovery_requests where workspace_id=p_workspace_id and id::text=p_request_id;
  if j.id is null then raise sqlstate 'PT404' using message='Conference check request not found.'; end if;
  -- Identical completion retry is harmless, even after the original lease expires.
  if j.status in ('success','partial','failed','cancelled') then
    if j.status=p_status and j.run_id is not distinct from rid and j.pages_checked=p_pages_checked and j.candidates_found=p_candidates_found and j.message=p_message then
      return jsonb_build_object('job',core_discovery_private.job_json(j),'cooldownUntil',last_requested+interval '60 seconds');
    end if;
    raise sqlstate 'PT409' using message='This conference check has already finished with different details.';
  end if;
  if j.status<>'running' or j.lease_until<=now() then raise sqlstate 'PT409' using message='This conference check is not running or its worker lease expired.'; end if;
  if rid is null then
    if p_status not in ('failed','cancelled') or p_pages_checked<>0 or p_candidates_found<>0 then raise sqlstate 'PT422' using message='A successful check and any result counts must reference a stored conference search run.'; end if;
  else
    if p_status='cancelled' then raise sqlstate 'PT422' using message='A cancelled check cannot reference a completed search run.'; end if;
    select r into run from public.workspace_planning s cross join lateral jsonb_array_elements(s.payload->'runs') r where s.workspace_id=p_workspace_id and r->>'id'=rid;
    if run is null or run->>'status'<>p_status or (run->>'pagesChecked')::integer<>p_pages_checked
      or (run->>'candidatesFound')::integer<>p_candidates_found or (run->>'startedAt')::timestamptz<j.requested_at then
      raise sqlstate 'PT422' using message='Completion must match this workspace’s stored search run, status and counts.';
    end if;
    if exists(select 1 from public.workspace_discovery_requests where workspace_id=p_workspace_id and run_id=rid and id<>j.id) then raise sqlstate 'PT422' using message='This search run already belongs to another check request.'; end if;
  end if;
  update public.workspace_discovery_requests set status=p_status,finished_at=now(),lease_until=null,message=p_message,
    pages_checked=p_pages_checked,candidates_found=p_candidates_found,run_id=rid where id=j.id returning * into j;
  return jsonb_build_object('job',core_discovery_private.job_json(j),'cooldownUntil',last_requested+interval '60 seconds');
end;
$$;

create or replace function public.core_get_discovery_request(p_workspace_id text)
returns jsonb language sql security invoker set search_path = '' as $$ select core_discovery_private.get_request(p_workspace_id); $$;
create or replace function public.core_request_discovery(p_workspace_id text)
returns jsonb language sql security invoker set search_path = '' as $$ select core_discovery_private.request_check(p_workspace_id); $$;
create or replace function public.core_claim_discovery_request(p_workspace_id text)
returns jsonb language sql security invoker set search_path = '' as $$ select core_discovery_private.claim_request(p_workspace_id); $$;
create or replace function public.core_finish_discovery_request(p_workspace_id text,p_request_id text,p_status text,p_run_id text,p_pages_checked integer,p_candidates_found integer,p_message text)
returns jsonb language sql security invoker set search_path = '' as $$ select core_discovery_private.finish_request(p_workspace_id,p_request_id,p_status,p_run_id,p_pages_checked,p_candidates_found,p_message); $$;

revoke all on all functions in schema core_discovery_private from public,anon,authenticated,service_role;
grant execute on function core_discovery_private.get_request(text),core_discovery_private.request_check(text) to authenticated;
grant execute on function core_discovery_private.claim_request(text),core_discovery_private.finish_request(text,text,text,text,integer,integer,text) to service_role;
revoke all on function public.core_get_discovery_request(text),public.core_request_discovery(text),public.core_claim_discovery_request(text),public.core_finish_discovery_request(text,text,text,text,integer,integer,text) from public,anon,authenticated,service_role;
grant execute on function public.core_get_discovery_request(text),public.core_request_discovery(text) to authenticated;
grant execute on function public.core_claim_discovery_request(text),public.core_finish_discovery_request(text,text,text,text,integer,integer,text) to service_role;
commit;

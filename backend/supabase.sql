-- CORE Midwest shared workspace. Run as the database owner in Supabase SQL Editor.
-- Keep core_private OUT of the Data API's exposed schemas.
begin;

create schema if not exists core_private;
revoke all on schema core_private from public, anon, authenticated;
grant usage on schema core_private to authenticated;

create table if not exists public.workspace_members (
  workspace_id text not null default 'core-midwest',
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'editor', 'viewer')),
  primary key (workspace_id, user_id),
  check (length(workspace_id) between 1 and 200)
);
create table if not exists public.workspace_state (
  workspace_id text primary key default 'core-midwest',
  payload jsonb,
  revision bigint not null default 0 check (revision >= 0),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  check (length(workspace_id) between 1 and 200),
  check ((payload is null and revision = 0) or (payload is not null and revision > 0))
);
alter table public.workspace_members enable row level security;
alter table public.workspace_state enable row level security;
revoke all on public.workspace_members, public.workspace_state from public, anon, authenticated;
grant select on public.workspace_members, public.workspace_state to authenticated;
drop policy if exists core_own_membership on public.workspace_members;
create policy core_own_membership on public.workspace_members for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists core_member_read on public.workspace_state;
create policy core_member_read on public.workspace_state for select to authenticated
  using (workspace_id in (
    select m.workspace_id from public.workspace_members m where m.user_id = (select auth.uid())
  ));

-- A small recursive shape validator. No extension or client-supplied schema is used.
create or replace function core_private.assert_shape(v jsonb, spec jsonb, path text)
returns void language plpgsql security invoker set search_path = '' as $$
declare k text; child jsonb; typ text; n numeric; ix integer := 0;
begin
  if v is null then
    raise sqlstate 'PT422' using message = 'Missing required value: ' || path;
  end if;
  if v = 'null'::jsonb and coalesce((spec->>'nullable')::boolean, false) then return; end if;
  typ := spec->>'type';
  if jsonb_typeof(v) <> typ then
    raise sqlstate 'PT422' using message = 'Invalid type: ' || path;
  end if;
  if typ = 'object' then
    for k, child in select key, value from jsonb_each(spec->'fields') loop
      if not (v ? k) and coalesce(spec->'optional', '[]'::jsonb) ? k then continue; end if;
      perform core_private.assert_shape(v->k, child, path || '.' || k);
    end loop;
  elsif typ = 'array' then
    if jsonb_array_length(v) > coalesce((spec->>'max')::integer, 500) then
      raise sqlstate 'PT422' using message = 'Too many items: ' || path;
    end if;
    for child in select value from jsonb_array_elements(v) loop
      perform core_private.assert_shape(child, spec->'items', path || '[' || ix || ']');
      ix := ix + 1;
    end loop;
  elsif typ = 'string' then
    if length(v #>> '{}') > coalesce((spec->>'max')::integer, 20000)
      or length(v #>> '{}') < coalesce((spec->>'min')::integer, 0) then
      raise sqlstate 'PT422' using message = 'Invalid text length: ' || path;
    end if;
    if coalesce((spec->>'url')::boolean, false)
      and (v #>> '{}') !~* '^https?://[^[:space:]/?#]+([/?#][^[:space:]]*)?$' then
      raise sqlstate 'PT422' using message = 'Source must be an http or https URL: ' || path;
    end if;
  elsif typ = 'number' then
    n := (v #>> '{}')::numeric;
    if n <> trunc(n) or n < coalesce((spec->>'min')::numeric, -9007199254740991)
      or n > coalesce((spec->>'max')::numeric, 9007199254740991) then
      raise sqlstate 'PT422' using message = 'Invalid integer or amount: ' || path;
    end if;
  end if;
end;
$$;

create or replace function core_private.validate_workspace(d jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  st jsonb := '{"type":"string","max":20000}';
  sh jsonb := '{"type":"string","max":500}';
  ident jsonb := '{"type":"string","min":1,"max":200}';
  cents jsonb := '{"type":"number","min":0,"max":100000000000,"nullable":true}';
  yr jsonb := '{"type":"number","min":1900,"max":2200,"nullable":true}';
  nonneg jsonb := '{"type":"number","min":0,"max":9007199254740991}';
  orgspec jsonb; payspec jsonb; benspec jsonb; spec jsonb;
  o jsonb; p jsonb; b jsonb; a jsonb; oid text; pid text;
  orgids jsonb := '{}'; payids jsonb := '{}'; benids jsonb := '{}'; allocids jsonb;
  total numeric;
begin
  -- Large enough for the current ledger and substantial growth; prevents unbounded RPC bodies.
  if d is null or octet_length(d::text) > 20971520 then
    raise sqlstate 'PT422' using message = 'Workspace must be a JSON object of at most 20 MiB.';
  end if;
  orgspec := jsonb_build_object('type','object','fields',jsonb_build_object(
    'id',ident,'name',sh,'sector',sh,'type',sh,'state',sh,
    'aliases',jsonb_build_object('type','array','max',500,'items',sh)));
  payspec := jsonb_build_object('type','object','fields',jsonb_build_object(
    'id',ident,'sourceRow',nonneg,'payee',sh,'description',st,
    'amountCents',cents,'originalAmountCents',cents,'eventYear',yr,'approvalYear',yr,
    'approvalDate',sh || '{"nullable":true}', 'sector',sh,'type',sh,'state',sh,
    'allocations',jsonb_build_object('type','array','max',50,'items',jsonb_build_object(
      'type','object','fields',jsonb_build_object('organizationId',ident,
      'amountCents','{"type":"number","min":1,"max":100000000000}'::jsonb))),
    'confidence',sh,'reason',st,'note',st,'reviewed','{"type":"boolean"}'::jsonb,'revision',nonneg));
  benspec := jsonb_build_object('type','object','optional',jsonb_build_array('note','utilization'),
    'fields',jsonb_build_object(
    'id',ident,'organizationIds',jsonb_build_object('type','array','max',50,'items',ident),
    'sourceOrganization',sh,'program',st,'trackedLevel',st,'trackedPackageAmountText',st,
    'applicability',jsonb_build_object('type','object','fields',jsonb_build_object('text',st,
      'years',jsonb_build_object('type','array','max',500,'items',jsonb_build_object('type','number')),
      'currentOrPrior',sh)),
    'benefits',jsonb_build_object('type','array','max',500,'items',st),
    'alternatives',jsonb_build_object('type','array','max',500,'items',st),
    'evidence',jsonb_build_object('type','object','fields',jsonb_build_object('status',st,
      'flags',jsonb_build_object('type','array','max',500,'items',st))),
    'potentialValue',st,'sources',jsonb_build_object('type','array','max',100,'items',st || '{"url":true}'),
    'openQuestions',jsonb_build_object('type','array','max',500,'items',st),
    'paymentRows',jsonb_build_object('type','array','max',50000,'items',nonneg),
    'note',st,'utilization',sh));
  spec := jsonb_build_object('type','object','fields',jsonb_build_object(
    'organizations',jsonb_build_object('type','array','max',10000,'items',orgspec),
    'payments',jsonb_build_object('type','array','max',50000,'items',payspec),
    'benefits',jsonb_build_object('type','array','max',10000,'items',benspec),
    'meta',jsonb_build_object('type','object','fields',jsonb_build_object('source',st,'researchAsOf',sh,'note',st))));
  perform core_private.assert_shape(d,spec,'workspace');
  for o in select value from jsonb_array_elements(d->'organizations') loop
    oid := o->>'id';
    if orgids ? oid then raise sqlstate 'PT422' using message = 'Duplicate organization ID: ' || oid; end if;
    orgids := orgids || jsonb_build_object(oid,true);
  end loop;
  for p in select value from jsonb_array_elements(d->'payments') loop
    pid := p->>'id';
    if payids ? pid then raise sqlstate 'PT422' using message = 'Duplicate payment ID: ' || pid; end if;
    payids := payids || jsonb_build_object(pid,true);
    allocids := '{}'; total := 0;
    for a in select value from jsonb_array_elements(p->'allocations') loop
      oid := a->>'organizationId';
      if not (orgids ? oid) then raise sqlstate 'PT422' using message = 'Payment references missing organization: ' || pid; end if;
      if allocids ? oid then raise sqlstate 'PT422' using message = 'Duplicate allocation in payment: ' || pid; end if;
      allocids := allocids || jsonb_build_object(oid,true);
      total := total + (a->>'amountCents')::numeric;
    end loop;
    if total > coalesce((p->>'amountCents')::numeric,0) then
      raise sqlstate 'PT422' using message = 'Allocations exceed payment amount: ' || pid;
    end if;
  end loop;
  for b in select value from jsonb_array_elements(d->'benefits') loop
    pid := b->>'id';
    if benids ? pid then raise sqlstate 'PT422' using message = 'Duplicate benefit ID: ' || pid; end if;
    benids := benids || jsonb_build_object(pid,true);
    for oid in select value from jsonb_array_elements_text(b->'organizationIds') loop
      if not (orgids ? oid) then raise sqlstate 'PT422' using message = 'Benefit references missing organization: ' || pid; end if;
    end loop;
  end loop;
end;
$$;

create or replace function core_private.get_workspace(p_workspace_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare member_role text; s public.workspace_state%rowtype;
begin
  if auth.uid() is null then raise sqlstate 'PT401' using message = 'Sign in to open this workspace.'; end if;
  select m.role into member_role from public.workspace_members m
    where m.workspace_id = p_workspace_id and m.user_id = auth.uid();
  if member_role is null then raise sqlstate 'PT403' using message = 'You are not a member of this workspace.'; end if;
  select * into s from public.workspace_state where workspace_id = p_workspace_id;
  return jsonb_build_object('data',s.payload,'revision',coalesce(s.revision,0),'role',member_role);
end;
$$;

create or replace function core_private.save_workspace(
  p_workspace_id text, p_payload jsonb, p_expected_revision bigint, p_action text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare member_role text; s public.workspace_state%rowtype; oldp jsonb; newp jsonb; newpayments jsonb;
  neworganizations jsonb; newbenefits jsonb;
  mutable_fields text[] := array['amountCents','sector','allocations','note','reviewed','revision'];
begin
  if auth.uid() is null then raise sqlstate 'PT401' using message = 'Sign in to save this workspace.'; end if;
  if p_workspace_id is null or length(p_workspace_id) not between 1 and 200
    or p_expected_revision is null or p_expected_revision < 0
    or p_action is null or p_action not in ('save','import') then
    raise sqlstate 'PT422' using message = 'Invalid workspace, action, or expected revision.';
  end if;
  -- Hold the membership row while saving, so a concurrent revocation cannot race this authorization.
  select m.role into member_role from public.workspace_members m
    where m.workspace_id = p_workspace_id and m.user_id = auth.uid() for share;
  if member_role is null or member_role = 'viewer' then
    raise sqlstate 'PT403' using message = 'Editor or owner access is required to save.';
  end if;
  if p_action = 'import' and member_role <> 'owner' then
    raise sqlstate 'PT403' using message = 'Only an owner can import or replace a workspace.';
  end if;
  perform core_private.validate_workspace(p_payload);
  -- A unique key plus row lock serializes simultaneous initial imports and subsequent saves.
  insert into public.workspace_state(workspace_id) values (p_workspace_id) on conflict do nothing;
  select * into s from public.workspace_state where workspace_id = p_workspace_id for update;
  if s.revision <> p_expected_revision then
    raise sqlstate 'PT409' using message = 'Workspace changed. Reload before saving; your changes were not written.';
  end if;
  if s.payload is null and p_action <> 'import' then
    raise sqlstate 'PT409' using message = 'An owner must import the initial workspace first.';
  end if;
  if p_action = 'save' then
    if jsonb_array_length(s.payload->'payments') <> jsonb_array_length(p_payload->'payments') then
      raise sqlstate 'PT422' using message = 'Normal saves cannot add or remove source payments. Use an owner import.';
    end if;
    select coalesce(jsonb_object_agg(v->>'id',v),'{}'::jsonb) into newpayments
      from jsonb_array_elements(p_payload->'payments') v;
    for oldp in select value from jsonb_array_elements(s.payload->'payments') loop
      newp := newpayments->(oldp->>'id');
      if newp is null or (oldp - mutable_fields) is distinct from (newp - mutable_fields) then
        raise sqlstate 'PT422' using message = 'Source payment fields must remain unchanged: ' || (oldp->>'id');
      end if;
      if (oldp - 'revision') is distinct from (newp - 'revision') then
        if (newp->>'revision')::numeric <> (oldp->>'revision')::numeric + 1 then
          raise sqlstate 'PT422' using message = 'Changed payment must increment its revision exactly once: ' || (oldp->>'id');
        end if;
        if length(newp->>'note') > 4000 or length(btrim(newp->>'sector')) not between 1 and 80
          or (newp->>'sector') <> btrim(newp->>'sector') then
          raise sqlstate 'PT422' using message = 'Changed payment needs a valid sector and a note of at most 4000 characters: ' || (oldp->>'id');
        end if;
        if newp->'amountCents' is distinct from newp->'originalAmountCents'
          and length(btrim(newp->>'note')) = 0 then
          raise sqlstate 'PT422' using message = 'Add a note explaining the amount correction: ' || (oldp->>'id');
        end if;
      elsif oldp->'revision' is distinct from newp->'revision' then
        raise sqlstate 'PT422' using message = 'Unchanged payment must preserve its revision: ' || (oldp->>'id');
      end if;
    end loop;
    if s.payload->'meta' is distinct from p_payload->'meta' then
      raise sqlstate 'PT422' using message = 'Source metadata can only change through an owner import.';
    end if;
    select coalesce(jsonb_object_agg(v->>'id',v),'{}'::jsonb) into neworganizations
      from jsonb_array_elements(p_payload->'organizations') v;
    for oldp in select value from jsonb_array_elements(s.payload->'organizations') loop
      if oldp is distinct from neworganizations->(oldp->>'id') then
        raise sqlstate 'PT422' using message = 'Existing organizations must remain unchanged: ' || (oldp->>'id');
      end if;
    end loop;
    if jsonb_array_length(s.payload->'benefits') <> jsonb_array_length(p_payload->'benefits') then
      raise sqlstate 'PT422' using message = 'Research profiles can only be added or removed through an owner import.';
    end if;
    select coalesce(jsonb_object_agg(v->>'id',v),'{}'::jsonb) into newbenefits
      from jsonb_array_elements(p_payload->'benefits') v;
    for oldp in select value from jsonb_array_elements(s.payload->'benefits') loop
      newp := newbenefits->(oldp->>'id');
      if newp is null or (oldp - array['note','utilization']) is distinct from (newp - array['note','utilization']) then
        raise sqlstate 'PT422' using message = 'Original benefit research must remain unchanged: ' || (oldp->>'id');
      end if;
      if oldp is distinct from newp then
        if length(coalesce(newp->>'note','')) > 4000
          or coalesce(newp->>'utilization','Not reviewed') not in
            ('Not reviewed','Planned','Partly used','Fully used','Not used','Needs confirmation') then
          raise sqlstate 'PT422' using message = 'Benefit review needs a valid status and a note of at most 4000 characters: ' || (oldp->>'id');
        end if;
      end if;
    end loop;
  end if;
  update public.workspace_state set payload = p_payload, revision = revision + 1,
    updated_at = now(), updated_by = auth.uid() where workspace_id = p_workspace_id returning * into s;
  return jsonb_build_object('data',s.payload,'revision',s.revision,'role',member_role);
end;
$$;

create or replace function public.core_get_workspace(p_workspace_id text)
returns jsonb language sql security invoker set search_path = '' as $$
  select core_private.get_workspace(p_workspace_id);
$$;
create or replace function public.core_save_workspace(
  p_workspace_id text, p_payload jsonb, p_expected_revision bigint, p_action text default 'save'
) returns jsonb language sql security invoker set search_path = '' as $$
  select core_private.save_workspace(p_workspace_id,p_payload,p_expected_revision,p_action);
$$;

revoke all on all functions in schema core_private from public, anon, authenticated;
grant execute on function core_private.get_workspace(text),
  core_private.save_workspace(text,jsonb,bigint,text) to authenticated;
revoke all on function public.core_get_workspace(text),
  public.core_save_workspace(text,jsonb,bigint,text) from public, anon, authenticated;
grant execute on function public.core_get_workspace(text),
  public.core_save_workspace(text,jsonb,bigint,text) to authenticated;

commit;

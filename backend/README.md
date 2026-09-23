# Shared database setup

This backend keeps the workspace in Supabase PostgreSQL. GitHub Pages serves the app; Supabase Auth identifies each person, and database rules control access. No Supabase project, account, SMTP service, or user invitation is created by these files.

## 1. Create and secure the project

1. Create a Supabase project and open its **SQL Editor**. Run `supabase.sql` as the database owner. It is safe to run again; it does not replace stored workspace data or memberships.
2. In Data API settings, keep **`core_private` out of Exposed schemas**. The public RPCs are thin security-invoker wrappers. Their private implementations check membership and permissions before accessing data.
3. In Authentication settings, enable email/password login; disable **Allow new users to sign up** and anonymous sign-ins. Keep email confirmation enabled. No OAuth provider is required.
4. Set **Site URL** and the allowed redirect URL to the app's exact GitHub Pages address, including any repository path and trailing slash. Use the same address for invitation and password-recovery callbacks. The frontend must handle invitation sessions and let users set a password with `auth.updateUser({password})`.
5. Configure custom SMTP before inviting ordinary app users. Supabase's default SMTP is for project-team addresses only and currently limits email to two messages an hour. App users do not need project-administrator access.

Official guidance: [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [database functions](https://supabase.com/docs/guides/database/functions), [Auth configuration](https://supabase.com/docs/guides/auth/general-configuration), [redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls), [SMTP](https://supabase.com/docs/guides/auth/auth-smtp).

## 2. Configure the app

The browser uses the project's HTTPS URL and **publishable key** (`sb_publishable_...`). These are public application configuration. Never put a secret key, service-role key, database password, or SMTP password in the browser, repository, or GitHub Pages build. The publishable key grants no workspace access without an authorized user session. [Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys)

Private ledger/import JSON belongs in the protected workspace, not the site's public assets. A sign-in screen does not make bundled files private. The app should display the initial-import screen when `data` is null and should not supply an embedded financial-data fallback.

## 3. Invite people and grant membership

Use **Authentication → Users → Add user → Send invitation** in the Supabase dashboard. After creating the invited account, copy its user UUID and add an explicit membership in SQL Editor:

```sql
insert into public.workspace_members (workspace_id, user_id, role)
values ('core-midwest', 'REPLACE-WITH-AUTH-USER-UUID', 'owner')
on conflict (workspace_id, user_id) do update set role = excluded.role;
```

Replace the example role with `editor` or `viewer` for other users. These are application roles, separate from Supabase project roles. Never paste a password or secret API key into this statement. A successful Auth login without a membership row does not grant access. Memberships are administered through SQL Editor, not through this version of the app. [Inviting users](https://supabase.com/docs/guides/auth/users)

| Role | Read | Assign expenses, correct current amounts, add organizations, annotate benefits | Import or replace workspace |
|---|---|---|---|
| Viewer | Yes | No | No |
| Editor | Yes | Yes | No |
| Owner | Yes | Yes | Yes |

Remove a person's membership to revoke workspace access:

```sql
delete from public.workspace_members
where workspace_id = 'core-midwest' and user_id = 'REPLACE-WITH-AUTH-USER-UUID';
```

The next database request checks current membership rather than relying on a role cached in the user's JWT. A save that already acquired the membership lock finishes before a simultaneous removal; requests after removal fail.

## 4. Import the initial workspace

Sign in as an owner and import the private `.core-workspace.json` file using the app. The frontend validates and unwraps the export envelope. The RPC receives the underlying `Data` object, not the envelope. The server independently validates it. No seed file is included in this backend directory.

Initial import uses `p_expected_revision: 0` and `p_action: 'import'`. An existing workspace replacement uses its current revision. There is no unconditional overwrite path: even an owner import rejects an outdated revision.

## RPC contract

```ts
supabase.rpc('core_get_workspace', {p_workspace_id: 'core-midwest'})
// result: {data: Data | null, revision: number, role: 'owner' | 'editor' | 'viewer'}

supabase.rpc('core_save_workspace', {
  p_workspace_id: 'core-midwest',
  p_payload: workspaceData,
  p_expected_revision: lastReadRevision,
  p_action: 'save', // 'import' requires owner
})
// result: same object, with the committed data and incremented workspace revision
```

`data: null` and revision `0` mean that an authorized owner has not imported the initial workspace. The save revision covers the **whole workspace**, independent of a payment's `revision` field. Changes to different records can therefore conflict when submitted from the same stale workspace snapshot.

On `PT409` / HTTP 409, preserve the draft and offer to reload the current workspace. Do not silently resend the stale payload with a new revision. `PT403` means missing membership or insufficient role, `PT401` means no signed-in identity, and `PT422` indicates invalid data or a forbidden normal-save change. Anonymous RPC calls are denied EXECUTE permission before function logic; PostgREST may surface its standard permission error instead.

## What the server preserves

- Normal saves keep all existing payment IDs and source fields, including `originalAmountCents`, payee, description, row, dates, original assignment reason, and confidence. Editable payment fields are `amountCents`, `sector`, `allocations`, `note`, `reviewed`, and `revision`.
- Each changed payment must increment its record revision exactly once; unchanged payments preserve their revision. A changed payment needs a trimmed sector of 1–80 characters and a note of at most 4,000 characters. A current amount different from its original amount requires a nonblank explanation.
- Existing organizations cannot be changed or deleted through a normal save. New organizations can be appended.
- Benefit IDs and original research cannot change through a normal save; only `note` and `utilization` can change.
- Changed benefit reviews accept notes up to 4,000 characters and these statuses: Not reviewed, Planned, Partly used, Fully used, Not used, or Needs confirmation.
- Source `meta` stays unchanged on normal saves. An explicit owner import can replace all data, but still must pass validation and the expected-revision check.
- Every amount is an integer number of cents, nonnegative, and at most 100,000,000,000 cents. Unknown payment amounts may be null. Allocations must be positive, unique per organization within a payment, reference existing organizations, and total no more than the current payment amount. Organization, payment and benefit IDs must be unique. Benefit organization references must exist.
- The server validates required fields and nested shapes, text lengths, safe integer ranges, http/https research URLs, and list limits matching the client schema. Fields with client defaults (`note`, `reviewed`, payment `revision`) must already be normalized by the frontend validator. Additional server bounds apply to otherwise unbounded reference arrays and URLs.
- A workspace may contain up to 10,000 organizations, 50,000 payments, and 10,000 benefit profiles, with a 20 MiB JSON payload limit. Workspace counts are not hard-coded.

Only the validated private save function can write workspace state. Client roles have no table INSERT, UPDATE, DELETE, or TRUNCATE grant and cannot write memberships. State and membership SELECTs also use RLS. The private functions pin `search_path` and use fully qualified object names. The saved `updated_by` and `updated_at` are set by PostgreSQL, not accepted from the browser. They identify the latest save; this is not a complete historical audit log.

## Transactions and conflict handling

The save function locks the current membership and workspace row. It validates the incoming document, checks the workspace revision and preservation rules, and commits one new revision. Failure rolls back the whole request. Concurrent first imports are also serialized by the workspace primary key. Each API request has a PostgreSQL transaction. [PostgREST transactions](https://postgrest.org/en/latest/references/transactions.html)

The conflict code is `PT409`, not a manually raised `40001`, because PostgREST can automatically retry serialization failures. [Supabase RPC error guidance](https://supabase.com/docs/guides/troubleshooting/high-cpu-and-infinite-transaction-retries-when-using-custom-error-codes-in-rpc-functions-77326b)

## Local verification

With project dependencies installed, run from the app directory:

```sh
node backend/test-database.mjs
node backend/test-database.mjs /absolute/path/to/private-workspace.json
node backend/test-adapter.mjs
node backend/test-adapter.mjs /absolute/path/to/private-workspace.json
```

The second command optionally validates and round-trips a real workspace without bundling it in the repository. Tests run a local in-memory PostgreSQL engine (PGlite), create minimal Supabase Auth roles/helpers, install the SQL twice, and exercise RLS, roles, direct-write denial, imports, immutable source data, allocation validation, member revocation, and stale-client conflicts. No remote database is contacted.

The adapter tests load the actual TypeScript module through Vite with a stubbed RPC client and network requests blocked. They cover stale benefit notes/status, per-payment revisions, workspace conflicts, roles, import arguments, simultaneous-save protection, delayed reads, and responses arriving after sign-out. They do not simulate the browser Auth interface or email delivery.

PGlite uses one connection; the stale-client test is sequential and does not claim to test true multi-session blocking. Before production, use two browser sessions against the configured Supabase project: open the same revision in both, save in the first, then save the second's still-open draft. The second must report a conflict while leaving the first save intact. Also verify invitation/password setup and recovery on the deployed GitHub Pages URL, and confirm viewer/nonmember access behavior. Supabase Auth email delivery and hosted API configuration cannot be tested by PGlite.

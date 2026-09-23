# CORE Midwest — Events & Sponsorships

An organization-centered spending and sponsorship workspace. Start with K–12, review dollars assigned to each client or organization, split expenses, correct amounts with explanatory notes, and record which sponsorship benefits were used.

**GitHub Pages hosts the frontend. Supabase provides shared data and invitation-only sign-in.** This package includes the complete app, database setup, and GitHub deployment workflow. It does not provision a Supabase account or publish a site automatically.

## What is included

- React + TypeScript app, built with Vite; desktop and mobile layouts.
- Explicit CORE Midwest identity, the approved CORE mark, CORE Green `#008348`, concrete `#F2F3F3`, black/asphalt, and Segoe UI with system fallback.
- Organization logos downloaded from their official websites, with provenance in `docs/logo-sources.json`. Logos retain their proportions. Related organization/program marks are identified in the app; unresolved identities use initials.
- Market and year filters, organization totals, expense search, dollar assignments and splits, corrected amounts, review notes, researched benefit packages, utilization notes, CSV export, and workspace backups.
- Shared workspace with owner/editor/viewer roles, protected database access, validated saves, and conflict detection.
- Filter by state alongside market and year, sort organizations by state, and export the filtered totals with state columns. State filtering uses the state recorded on each expense; organizations without spending use their listed states. Entries with missing state information remain available under **State not recorded**.
- Edit each expense's **Applicable year** without changing its original cost/approval date or amount. The default year filter uses applicable years, the expense table sorts by them, and organization profiles show yearly assigned-cost totals.
- Edit organization names, pictures, descriptions, websites, and contacts while preserving the underlying organization IDs and expense links.
- **Events overview** provides a calendar and dated list, market/state/organization/decision filters, critical events in the next four weeks, participation decisions, manual invoice confirmations, planning checklists, and debriefs.
- Every-two-weeks conference discovery monitors chosen organizer pages and puts findings in a source-linked review queue. Optional Brave search broadens discovery when configured. See [activation and coverage](docs/CONFERENCE-DISCOVERY.md).
- Review and add historical conference suggestions together under **Conference tracking → Review & add conferences**. Names and known source pages are prefilled. Sourced selections are enabled; suggestions without sources remain saved and paused as **Needs source**. Tracked conferences persist across refreshes and show their latest published findings, dates, and pending reviews.

## Enable events, profiles, and applicable years

Existing installations only need to run [backend/planning.sql](backend/planning.sql) after their original database setup. The additive migration preserves the spending ledger and stores planning, profile, and year edits separately. Owners and editors can approve participation and make these edits; viewers can read them. Until this update is installed, spending remains available and the new features show a setup message.

For scheduled research, save `SUPABASE_SECRET_KEY` in GitHub Actions secrets, enable conference watches and the schedule in **Events overview → Conference tracking**, and run the discovery workflow once. Secret keys are never browser settings. The [discovery setup guide](docs/CONFERENCE-DISCOVERY.md) covers activation, optional broader search, run history, and scheduling limits.

Use **Spending backup** for the original ledger and **Planning backup** for organization profiles, applicable-year adjustments, events, watches, and research history. A replacement ledger must preserve IDs referenced by planning. Event budgets and manually confirmed invoices do not automatically post expenses into the original ledger.

The initial data file is supplied **separately** as `CORE-Midwest-initial.core-workspace.json`. Keep that file outside this repository. Import it through the app after signing in as the owner. No spending ledger or private financial seed is embedded in the public app.

## Set up the shared database

1. Create a project at [Supabase](https://supabase.com/).
2. Open its SQL Editor and run `backend/supabase.sql`.
3. Follow [backend/README.md](backend/README.md) to configure invitation-only authentication, SMTP, redirect URLs, and workspace memberships.
4. Record the project's URL and **publishable** key. Keep privileged keys and database passwords out of the app.

Start with yourself as `owner`; give teammates `editor` to change assignments or `viewer` for read-only access. This app uses one workspace ID, `core-midwest`. Owners can import or replace its data. Membership management is done in Supabase's dashboard/SQL Editor.

## Put the app on GitHub Pages

1. Create a GitHub repository and put **the contents of this folder at its root**, including `.github`, `.gitignore`, and `.env.example`. Use the `main` branch, or update the workflow's branch name.
2. This repository's deployment workflow already includes the CORE Midwest project's public Supabase URL, publishable key, and workspace ID. To use a different project, override them under **Settings → Secrets and variables → Actions → Variables**:

   | Variable | Value |
   |---|---|
   | `VITE_SUPABASE_URL` | Your project's HTTPS URL |
   | `VITE_SUPABASE_PUBLISHABLE_KEY` | The `sb_publishable_...` key |
   | `VITE_WORKSPACE_ID` | `core-midwest` |

3. Under **Settings → Pages**, choose **GitHub Actions** as the source.
4. Run **Deploy CORE Midwest to GitHub Pages** in the Actions tab, or push to `main`.
5. Use the published address—including the repository path and trailing slash—as Supabase's Site URL and allowed redirect URL: `https://bricecore.github.io/Events-Sponsorships/`.
6. Open the site and sign in with your existing app account. An owner only needs to select **Import workspace** if the shared workspace is empty. Data already imported through the local app is available here through the same Supabase project.

The build uses relative asset paths to support a project subdirectory or custom domain. There are no server routes to configure on GitHub Pages. The workflow checks configuration, runs database tests, builds `dist/`, and deploys only that folder. See [Vite's GitHub Pages guide](https://vite.dev/guide/static-deploy.html#github-pages) and [GitHub's Pages publishing instructions](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site).

## Run locally

Use Node.js 22.13 or later (Node 22 LTS recommended):

```sh
npm ci
cp .env.example .env.local
```

Fill in the three connection settings, then:

```sh
npm run dev
```

Open `http://localhost:5174/`. Add that address to Supabase's allowed redirects for local invitation/recovery testing. Without connection settings, the app displays a setup screen. `npm run build` produces the static site in `dist/`; `npm run preview` serves that production build on port 4173.

The original local demonstration can optionally run with `VITE_LOCAL_PREVIEW=true` and the earlier workspace API on `localhost:5173`. This development-only adapter is excluded from production behavior; it is not a shared database. It is not enabled in the source package's example configuration.

## How shared editing works

- Changes save to Supabase and become available to every workspace member. The app refreshes on window focus and every 30 seconds while no expense or benefit editor is open; **Refresh** also reloads it.
- Every save checks a workspace revision. If someone else saved since your last read, your save is rejected instead of replacing their work. Copy any draft notes you want to keep, close the editor, refresh, and review the latest values before saving again.
- The database stores a complete validated workspace document per save. This is suitable for the supplied modest team workspace. Revisions apply to the whole document, so simultaneous edits to different records can also conflict.
- Original payees, descriptions, source amounts and research stay preserved during normal editing. An owner can intentionally replace the full workspace through the import dialog.
- **Backup** downloads a private workspace copy; **Export totals** exports the current filtered organization totals as CSV. A backup is a snapshot, not an automatic backup schedule. The database records the latest updater/time, not a complete history of changes.

## Interpreting the data

Recorded spending comes from the supplied tracker and saved corrections; it is not proof of settlement. Market filtering follows each expense's classification. Applicable year starts with the first event/membership year identified in the description and can be corrected separately; the original cost/approval date and approval year stay preserved. Unknown amounts remain unknown. Suggested organization assignments can be corrected or split without increasing the expense total.

Benefit package descriptions retain organizer source links, evidence limits and applicability years. Potential value is an opportunity to assess; it is not measured financial ROI. A published benefit does not prove that CORE Midwest purchased or used it. Package reference prices are not added to spending totals.

## Verification and maintenance

```sh
npm run check
npm run test:database
npm run test:adapter
npm run test:states
npm run test:planning
npm run test:events
npm run test:tracking
npm run test:years
npm run test:discovery
npm run build
```

Database tests run in an in-memory PostgreSQL engine; no live account is required. They cover access roles, invalid assignments, stale saves, data preservation, imports, and membership revocation. To validate an additional private workspace file without adding it to the repository:

```sh
node backend/test-database.mjs /path/to/private-workspace.json
```

The app was checked locally for desktop/mobile layout, applicable-year changes, organization pictures and profiles, event planning, stale drafts, viewer access, expense splitting, and the production build. Browser checks use synthetic records and intercept database calls. The owner has applied both database migrations to the hosted Supabase project. Invitations, password recovery, real concurrent user sessions, and the first scheduled discovery run still require hosted verification. See [verification details](docs/VERIFICATION.md).

Brand and logo provenance is documented in `docs/BRAND-AND-ASSETS.md` and `docs/logo-sources.json`. Third-party logos identify their respective organizations and do not imply endorsement.

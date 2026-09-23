# Conference discovery: activation and operation

Conference discovery runs on GitHub, so no computer needs to remain open. It collects proposals for review; it never approves an event, changes a participation decision, marks an invoice paid, or adds spending to the ledger. Applicable expense years, organization profiles, event plans, and debriefs stay in their existing records.

## Activate the shared database and scheduler

1. Complete the existing [shared database setup](../backend/README.md). In the same Supabase project's SQL Editor, run [backend/planning.sql](../backend/planning.sql) as the database owner. Run `backend/supabase.sql` first only if the base workspace is not already installed. The planning migration is safe to run again and preserves existing records. Keep both `core_private` and `core_planning_private` out of the Data API's exposed schemas.
2. Make sure the discovery worker and [workflow](../.github/workflows/discovery.yml) are on the GitHub repository's default branch. Enable GitHub Actions for the repository if needed. This workflow does not run on pull requests or feature branches.
3. Open [this repository's Actions secrets](https://github.com/BriceCORE/Events-Sponsorships/settings/secrets/actions), choose **New repository secret**, and create **`SUPABASE_SECRET_KEY`**. Enter a secret API key from this Supabase project, preferably a dedicated `sb_secret_...` key for this worker. A legacy `service_role` JWT also works. A publishable/anon key does not have permission to run discovery.
4. Sign in to the app as an owner or editor. Open the events area, add or enable conference tracking, choose the correct organization, and supply official organizer conference or calendar links. Include enough organizer/conference words in the tracking name to identify the program. Turn on the global every-two-weeks tracking switch.
5. In [GitHub Actions](https://github.com/BriceCORE/Events-Sponsorships/actions/workflows/discovery.yml), select **Discover conferences for review → Run workflow** on the default branch. For the first run, leave **force** unchecked. Use force only when intentionally checking before the next due date. Force still respects the app's global enabled switch.
6. After the workflow finishes, refresh the app. Review the search history and any new proposals, open their source evidence, and confirm dates and sponsorship terms before saving an event decision.

The secret belongs only in GitHub's secret storage. Do not put it in chat, source files, browser configuration, `VITE_` variables, or a public build. Current Supabase secret keys use the `apikey` header; the worker adds a Bearer header only for a legacy JWT. Supabase documents the key types and elevated privileges in its [API key guide](https://supabase.com/docs/guides/getting-started/api-keys).

The workflow already defaults to the public project URL `https://opmirvbaomwsjhfpheeg.supabase.co` and workspace `core-midwest`. Repository variables `VITE_SUPABASE_URL` and `VITE_WORKSPACE_ID` can override those defaults. These are public identifiers, separate from the secret.

**If `SUPABASE_SECRET_KEY` is absent, the workflow prints a clear SKIPPED message, makes no database request, performs no search, and does not advance the schedule.** A green workflow with that message does not mean a discovery run occurred. Database configuration errors fail the workflow using an operational error code; private response bodies are never printed.

## Every two weeks

GitHub wakes the workflow daily at 07:17 UTC. The worker reads the shared settings and crawls only when discovery is enabled and its saved `nextRunAt` is due. The enforced interval is **14 days**. The database sets the next due time to 14 days after a recorded run; the next daily wake performs it. Normal execution can therefore occur up to roughly a day after that due time, plus any GitHub scheduling delay. New tracking with no run history is immediately due.

Turning tracking off pauses discovery, including manually forced runs. If there are no enabled watches, the worker skips without recording a run. Checks that find no future events can still finish successfully. Recorded partial or failed attempts advance the 14-day schedule; after correcting a source or configuration issue, use a forced manual run if an earlier retry is needed. A failure before the run can be stored does not advance the schedule.

GitHub runs schedules from the default branch, can delay or drop scheduled jobs during high load, and automatically disables scheduled workflows in a **public repository after 60 days without repository activity**. A repository administrator must re-enable a disabled workflow in Actions. There are no artificial keepalive commits. Check the app's latest-run indicator and Actions history if a due search has not appeared. These are GitHub platform limits, described in [Events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

## Sources and coverage

By default this is **monitoring of watched organizer sites**, not an exhaustive search of the internet. Give each watch a specific conference or events page rather than only a homepage. The worker follows relevant conference, event, calendar, and sponsorship links on that same host. It considers at most eight content pages per watch, with a global limit of 512 pages and a 20-minute crawl budget per run. Two workers run concurrently, with at least half a second between requests to a host. Larger `Crawl-delay` values are respected up to ten seconds; sites requesting more are skipped. The workflow has a 30-minute overall limit.

The worker obeys robots rules, checks public DNS/IP destinations at every redirect, connects to the checked address, and blocks local/private/reserved addresses. It has bounded redirects, request deadlines, and a 2 MiB response limit (256 KiB for robots files). Sites with unavailable robots rules, browser challenges, unsupported compression, logins, JavaScript-only event data, or oversized responses can be missed. A run reports fetch/search/limit issues as partial or failed instead of claiming complete coverage. The pages count describes attempted content pages; robots checks are additional requests.

For optional broader discovery, add **`BRAVE_SEARCH_API_KEY`** to the same GitHub repository secrets. The worker sends the watch name and search terms to Brave's public web-search API and checks up to five returned links within the same page budget. It does not send spending, private notes, contact details, or the Supabase credential. Keep watch names and search terms suitable for a public search. Results outside watched organizer hosts must match the watch name and are explicitly flagged for organizer confirmation. A valid Brave API account/key and any provider usage charges are the owner's responsibility; no paid provider is required for organizer-site monitoring. See the [Brave Web Search API](https://api-dashboard.search.brave.com/api-reference/web/search/get).

## What becomes a proposal

- Schema.org Event JSON-LD supplies explicitly published event names, full dates, venue/address, and sponsor fields. Past and cancelled events are excluded. Postponed events have blank dates and a review note.
- On pages without usable structured events, a relevant event heading can supply a proposal. Full date statements must appear in that heading or a clearly labeled date field. Labeled venue and sponsorship text are retained with source excerpts. Conflicting or incomplete dates stay blank; the worker never copies a footer year into an event date or guesses next year's date.
- A linked PDF can become a source-only review item. Its contents are not parsed, and its title, dates, venue, and benefits require manual confirmation. The filename or link label is evidence of the linked document, not proof of an event date.
- Every proposal carries its source URL and an evidence excerpt. Possible sponsorship benefits are source text, not verified delivery or calculated financial ROI. Repeated pages and differently named versions can still require human duplicate review.

Fingerprints include the watch and organization, canonical source URL, event identity/year, exact title and dates, venue, and published sponsor details. Tracking query parameters do not create new fingerprints. An identical fingerprint only refreshes its last-seen time; existing source details and review status remain unchanged. A changed date creates a separate proposal and refers to the prior suggestion when its event identity matches. Approved events are never silently rewritten. A date change that also substantially changes the event name or moves to another source URL may appear as a separate event without that comparison note.

The worker submits at most 500 proposals and 9 MiB per run. The database retains up to 5,000 suggestions and the last 30 run summaries. Reaching capacity fails safely; ask the workspace administrator to plan a controlled research archive. Dismissing a proposal keeps its history and does not free capacity. Limits and robots restrictions mean the list is always a review aid, not proof that no other conference exists.

## Verification and maintenance

The worker uses Python 3's standard library; GitHub's Ubuntu runner supplies the runtime. No local scheduler, package installation, local credentials, or downloaded browser is needed.

Run the offline synthetic fixture suite from the app folder:

```sh
python3 -B scripts/test-discover-conferences.py
```

The tests cover JSON-LD and text extraction, past/invalid/ambiguous dates, relevance, PDF review, stable and changed fingerprints, the 14-day schedule, disabled/force behavior, request bounds, robots rules, private redirects, DNS rebinding, credential separation, and safe missing-configuration output. They block real network connections and do not access Supabase. The separate backend planning tests exercise grants, validation, deduplication, preserved event decisions and invoices, and concurrent-save protections.

Operational logs contain only counts, statuses, and fixed error codes. The workflow uploads no candidate files or artifacts. Suggestions and source evidence are written only through `core_ingest_discoveries`; its service-role-only companion `core_discovery_context` supplies planning context without the ledger. A live first run after installing the SQL and secret is still required to verify the hosted Supabase configuration and actual organizer availability.

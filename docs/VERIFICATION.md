# Handoff verification — September 23, 2026

- Production TypeScript check and Vite build passed.
- State filtering and State A–Z sorting passed eight focused checks plus browser checks with synthetic records covering market/year intersections, mixed-case and missing states, multi-state organizations, split expenses, filtered CSV totals, and desktop/mobile layouts. Browser checks intercept database requests and do not modify the shared workspace.
- 65 database checks passed using a synthetic fixture, plus a full private-workspace round trip (66 with the optional fixture).
- 26 shared-client checks passed with networking blocked, including permissions, stale benefit drafts, payment revisions, no-op saves, import revision conflicts, overlapping requests, and delayed replies after sign-out.
- 102 planning checks passed: owner/editor decisions, viewer restrictions, shared profiles, applicable-year overrides, preserved ledger values, manual payment evidence, discovery ingestion, deduplication, immutable source evidence, stale drafts, migration reruns, and protected ledger imports.
- 22 calendar checks passed for weekday alignment, date-only handling, DST, ongoing events, declined events, and the next-four-weeks boundary. Fourteen applicable-year checks passed for explicit unknown, source-year fallback, filtering, and original date preservation.
- 31 offline discovery tests passed for structured/text extraction, uncertain dates, source evidence, changed proposals, the 14-day due gate, URL/redirect restrictions, robots rules, request bounds, credential separation, and Unicode/NUL handling.
- Synthetic browser checks passed for profile name/contact/photo changes, applicable-year editing/sorting/yearly totals, event decisions, manual invoice confirmations, planning tasks, debriefs, calendar dates, discovery acceptance, conference tracking, stale drafts, viewer access, and the missing-migration fallback. Desktop and mobile checks found no page-level overflow or browser errors. These checks intercept all Supabase traffic and do not write to the live workspace.
- Browser checks passed for CORE Midwest identity, filtered spending calculations, organization selection, split-allocation controls, over-assignment prevention, benefit display, and desktop/mobile layout. No browser errors or page-level mobile overflow were found.
- A production build was served under a repository subdirectory. Its setup screen and brand asset loaded; private payment IDs, the ledger seed, and the local preview backend were absent from the JavaScript output.
- Organization identities have logo research entries; verified assets are packaged and unresolved identities use initials with documented gaps. White transparent marks use a dark backdrop.
- The separately supplied private import file preserves its organization, expense, and benefit data.

The shared Supabase project is configured. Its Auth endpoint responds successfully, email sign-in is enabled, public and anonymous signup are disabled, and signed-out workspace requests are denied without returning data. The owner confirmed saving the GitHub Pages site and redirect URLs in Supabase and successfully applying the combined planning migration, including applicable years.

Hosted invitations, SMTP, recovery callbacks, real simultaneous browser sessions, and the first live discovery run still require user verification. Discovery activation needs the GitHub Actions secret plus enabled conference watches and schedule settings. PGlite tests simulate stale clients sequentially; they are not a multi-session hosted test.

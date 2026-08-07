# CLAUDE.md — Aidapt Portal Backend

Working context for this repo. Keep this file current: update the **Build status**
and **Integration status** sections whenever a step or integration changes.

## What this is
The **Portal (parent) backend** of the Aidapt Portal ecosystem — a TypeScript +
Express + Supabase (Postgres) API. One shared Supabase project/database, four
schemas: `core` (shared identity/tenancy), `portal`, `lms`, `support`. This repo
owns the full shared migration set even though LMS/Support are separate apps.

Full system design is the source of truth for intent; `docs/ARCHITECTURE.md`
covers the layered/module layout; `docs/API.md` is the frontend-facing endpoint
reference. Design section references (e.g. §10.4) point at that design doc.

## Stack & commands
- Node 20+, ESM, TypeScript (strict), Express 4, Supabase, Zod, Pino, Vitest.
- `npm run dev` — API (tsx watch) · `npm run worker:outbox` — outbox worker
- `npm run typecheck` · `npm run lint` · `npm test`
- `npm run db:migrate` / `db:migrate:dry` — apply SQL migrations (ordered, ledgered)
- `npm run clickup:webhook -- <list|create|delete>` — manage ClickUp webhooks

## Conventions
- Access DB two ways: **`pool`** (`src/infra/db/pool.ts`, direct pg, bypasses RLS —
  used by all server-side reads/writes with explicit tenant filters) and the
  request-scoped Supabase client (`req.auth.db`, RLS-enforced) for anything that
  must run as the user. Most code uses `pool` + app-level authz.
- Every module: `repository` (SQL) → `service` (logic) → `controller` (HTTP) →
  `routes`. Errors via `AppError` subclasses; responses via `ok()/fail()` envelope.
- Middlewares: `authenticate` (verify self-hosted access JWT), `requirePlatformAdmin`,
  `requireServiceSecret` (internal endpoints), `requireTenantRole(min)` (resolves
  active tenant from `x-tenant-id`/`tenant_id`/sole membership + gates by role).
- Role rank: member < member_plus < member_pro < super_admin (`common/constants/roles.ts`).
- Live behaviour is verified with throwaway `scripts/smoke-*.ts` (run via tsx,
  create → assert → clean up). Not part of `npm test` (which is unit-only).

## Auth model
Self-hosted JWT auth (migration `0014`), **replacing Supabase Auth**. `core.profiles`
no longer FKs to `auth.users` (id is app-generated); credentials live in
`core.user_credentials` (bcrypt), refresh tokens hashed in `core.refresh_tokens`.
Endpoints: `POST /auth/register|login|refresh|logout`, `POST /auth/logout-all`
(auth'd), `GET /auth/me`. Access token (`JWT_ACCESS_SECRET`, ~15m) embeds
`platform_admin`/`tenant_roles` claims — the same shape the never-enabled access
token hook would have stamped, so `requirePlatformAdmin`/`requireTenantRole`
fast-paths work unchanged. Refresh tokens are opaque, stored hashed, rotated on
`/refresh`, revoked on logout. Supabase client/`req.auth.db` (RLS path) is now unused.

**Sign-in has two always-available methods, not a fallback pair** — password
(`POST /auth/login`) and OTP (`POST /auth/otp/request` → `/auth/otp/verify`,
migration `0019`). The client offers both and the user picks per attempt; there
is no per-account preference or enrollment step. OTP codes are 6 digits,
hashed (SHA-256, not bcrypt — short TTL + attempt limiting cover brute force),
stored in `core.otp_codes` (RLS deny-all, same posture as `user_credentials`/
`refresh_tokens`), TTL/attempt-cap configurable (`OTP_TTL_MINUTES`/
`OTP_MAX_ATTEMPTS`, defaults 10m/5). Delivery goes through the n8n webhook
(`N8N_OTP_WEBHOOK_URL`, same model as the invite email); if unset outside
production the code is logged instead so local dev doesn't need n8n wired up.
`/auth/otp/request` always responds `{ sent: true }` regardless of whether the
email is registered, to avoid leaking account existence.

## Build status (design §12 sequence)
- [x] **1. Foundation** — 4 schemas, enums, tables, RLS (42 policies), auth hook,
  helpers, profile trigger. Migrations `0001`–`0021` all applied to the live DB
  (verified 2026-08-06 via `db:migrate:dry` — the old "`0014` not yet applied"
  note here was stale).
- [x] **2. Admin client lifecycle + onboarding + outbox** — `POST /admin/clients`
  (atomic txn + step ledger + outbox enqueue), outbox worker w/ retries+finalizer.
- [x] **3. ClickUp sync → `portal.task_cache`** — API client, mapper, hourly pull
  `POST /internal/sync/all` (walks spaces, folder=client/list=project routing),
  per-task `/internal/sync/task`, HMAC webhook (unused — see integration below).
  - [x] **Project visibility** — admin discover/toggle which lists show in Portal;
    `task_cache.client_visible` driven by the per-project flag.
- [x] **4. Portal client reads** — `/dashboard`, `/projects`, `/sprint/active`,
  `/onboarding`, `/pod`, `/notifications` (+read). LMS tile computed live from the
  LMS team's schema (domain join). `PUT /admin/clients/:id/clickup-mapping` added.
- [x] **5. Wishlist + voting** — `/wishlist` (**read: `member`**; submit/vote:
  MemberPlus+), `POST`/`DELETE /wishlist/:id/vote` (both idempotent),
  `POST /internal/voting/close-cycle` (winner→prioritised, notify, reopen).
  - [x] **Requests are authored in ClickUp, never in the Portal.** The Wishlist page's
    "Submit a request" links out to `WISHLIST_FORM_URL`
    (`https://processonboarding.aidaptnow.com/wishlist/`, same pattern as
    `ONBOARDING_FORM_URL`); the form writes to the shared list and the item appears at
    the next `POST /internal/sync/wishlist`. `POST /wishlist` still exists but the UI
    doesn't use it, so every request enters through one pipeline.
  - [x] **Request detail synced + parsed** (migration `0027`) — the intake form lives in
    the ClickUp task's `markdown_description`; `wishlist-mapper.ts` parses it into
    `problem`/`who_feels_pain`/`urgency`/`submitter_*` columns. `body_md` is the
    **leftover** body (markdown, rendered via `<Markdown compact>`): everything with its
    own column is stripped, along with placeholder-only answers and the request title, so
    it never double-renders a section and never shows a client "None"/"—". Null on most
    rows. 26 unit tests over the real corpus; `scripts/smoke-wishlist-parse.ts`
    is the read-only coverage probe (14/14 submitter blocks, 13/14 problems, **0 retired
    taxonomy leaks**). No `capability` column — the form's pillar line is stripped, never
    translated. The submitter email is used in memory only, to resolve `submitted_by`.
  - [x] **Voting completed** — un-vote (`DELETE`), idempotent repeat vote (was `409`),
    snake_case `{ item_id, votes, voted, changed }`, `can_vote`/`votes_all_time`,
    tenant-scoped admin cycle management (`/admin/clients/:id/voting/cycles*` — list,
    breakdown, close w/ `notify`, extend, reopen, open) and
    `PATCH /admin/clients/:id/wishlist-items/:itemId` for `state` (the only path to
    `in_progress`/`shipped`). One-open-cycle-per-tenant index. `closeDueCycles` now
    catches up to the current month in ONE pass and loops to convergence.
    `voting_opened`/`item_prioritised` notifications now actually fire.
    Verified live: `scripts/smoke-wishlist-voting.ts`, 32/32 checks, no data left behind.
  - [x] **Wishlist → Onboarding link** (migration `0024`) — `task_cache.source_wishlist_item_id`
    records that an onboarding task is the prioritised wishlist item the client voted for.
    Set by a **deliberate admin action**, never inferred: `PATCH /admin/clients/:id/tasks/
    :taskId/wishlist-source` `{ wishlist_item_id | null }` (+ `GET /admin/clients/:id/
    wishlist-items` as the pick-list). `GET /onboarding` joins out and returns
    `source_wishlist_title` alongside the id, so the Portal shows "Originated from your
    Wishlist: …" without a second call. The sync's upsert lists columns explicitly, so a
    link survives every re-sync. Full chain verified over HTTP against live Kenafric data.
- [x] **6. Reports + Sprint Pulse** — admin create(seeded from sprint)/publish,
  MemberPro list/detail/pulse.
  - [x] **Monthly reports sync from ClickUp Docs** (migrations `0029`/`0030`) —
    `POST /internal/sync/reports` with `{}` walks every tenant that has a
    `clickup_reports_folder_id`. Source is a **Doc**, not a task list: each
    client has its own "Monthly Progress Reports" folder in Delivery holding one
    Doc per month, whose root page is the report body and whose child pages are
    the pillar deep-dives → `portal.report_sections` (AI Operations /
    Intelligence / Enablement; clients carry 2 or 3). Report-level
    committed/delivered is the SUM of the pillar Action Item Trackers.
    Kenafric is live from folder `901212877607`. `0030` deleted the nine
    bi-weekly rows that came from the retired doc `8ckbtec-180492`.
- [x] **Invitations** — invitation-gated registration + n8n invite email (LIVE).
  Inviter sets the role. Platform admin (`POST /admin/clients/:id/invitations`) can
  grant any role incl. `super_admin` (→ sets `is_platform_admin`). Org admin/member_pro
  (`POST /invitations`) invites into their own tenant, non-super_admin only.
  `POST /auth/register` needs the token + collects profile (fullName, jobTitle,
  department, phone, avatarUrl, interests[]). `PATCH /auth/me` edits profile.
  Profile fields added in migration `0015`.
  - [x] **Member management** (2026-08-07) — `GET /admin/clients/:id/members` and
    `PATCH /admin/clients/:id/members/:userId` `{ role?, status? }`. Before this
    there was no way to *see* a client's users or change anyone's role/status
    except direct SQL; invitations were the only member-related endpoint.
    The PATCH is tenant-scoped in both directions: the role enum excludes
    `super_admin` (rejected **by name**, 422 — platform-wide access is not a
    per-client action, `/invitations` remains the one deliberate path), and the
    update is keyed on the `(tenant_id, user_id)` pair, so addressing another
    client's member 404s instead of editing them. Omitted fields `coalesce` to
    their current value, so a role-only patch can't reset a status.
    `core.user_credentials` is LEFT-joined — `Sprint Check` on Kenafric has a
    profile and a membership but no credentials row, and an inner join would
    silently drop that person from their own client's member list.
    Frontend: `/admin/users` behind `AdminGate` (its first real use), reading the
    tenant from the topbar picker. Verified live: `scripts/smoke-members.ts`,
    22/22 checks against real Kenafric data, values restored afterwards.
- [ ] **7. Notifications** — table + reads done; most sources already emit
  (onboarding, voting, reports). Remaining: wire remaining event sources as built.
  - [x] **The report sync now notifies too.** `reportsRepo.publish` was the only
    `report_published` emitter, so reports arriving via `/internal/sync/reports`
    (all 9 of Kenafric's, `published_by = null`) produced nothing and the
    Dashboard's "Recent activity" panel was empty despite a published report and
    an active member_pro user. `syncRepo.notifyPublishedReport(tenantId)`
    runs at the end of `syncReports`, **after** `archiveSupersededSyncedReports`
    so it announces only the ONE still-published report rather than firing one
    notification per backfilled month. Both are TENANT-scoped and must ORDER BY
    the same `period_end desc, doc_updated_at desc nulls last, clickup_doc_id
    desc` — see the tiebreak note under gotchas. Idempotent with no new column: the
    `not exists` guard keys on the report's own `/reports/:id` `link_url`, so
    re-syncs insert nothing and it dedupes against `reportsRepo.publish` too
    (both write the same link). It therefore also **backfills** reports synced
    before it existed. Gated to `member_pro`, who are the only ones who can read
    Reports at all. `SyncResult.notified` reports the count. Verified live
    (`scripts/smoke-report-notify.ts`): 1 → 0 → 0 across three calls, then a
    real `syncReports` run returned `upserted: 9, notified: 0`.
  - Five enum values still have NO emitter: `task_status_changed`,
    `document_added`, `course_assigned`, `ticket_updated`, `role_changed`.
    `task_status_changed` is the highest-value one left — the sync already knows
    a task's previous `bucket`, so it could emit on change and give the activity
    panel real volume from the 341 cached delivery tasks.
  - **`core.notifications` is a per-USER inbox, not a tenant activity log.** Rows
    carry `user_id`, so two people at the same client see different feeds and
    anyone registering later sees an empty panel forever (nothing backfills at
    registration). `core.audit_log` is the right shape for a tenant-wide stream
    (`tenant_id, actor_id, action, target, metadata, created_at`) but is written
    for only two actions — `invitation.registered` and `onboarding.completed` —
    and Kenafric has exactly 1 row. Flagged, not reconciled.
- [ ] **8. LMS/Support summary refresh** — LMS tile is live via join; Support reads
  `support.tenant_support_summary`. `/lms|support/internal/refresh-summary` not built.
- [x] **9. Automation health** — admin `POST /admin/clients/:id/automations` (register
  + seed health), client `GET /automations/health` (member_plus), n8n execution
  webhook `POST /webhooks/n8n/execution` (service secret) updates health + notifies
  member_plus+ on error. Monthly counter reset still TODO (needs a cron).
- [x] **Roles** — added `org_admin` (rank 4, migration `0016`): per-tenant admin,
  can invite within own org via `POST /invitations` (not super_admin). Onboarding's
  first client invite is now `org_admin`. Admin invite can grant any role.
- [x] **Avatars** — `POST /auth/me/avatar` (multer, ≤2MB image) → public `avatars`
  bucket (migration `0017`) → sets `profiles.avatar_url` (cache-busted).
- [x] **Use Cases** (migrations `0021`–`0023`) — `GET /usecases` (member_plus) is
  the **tenant-agnostic** catalogue of automations Aidapt can build, plus
  `GET /usecases/:slug` for the expanded card. It is NOT the client's own work —
  an early version also re-cut `/projects` as "live automations"; that half was
  **removed** (it duplicated `/projects` exactly and the page shows the library only).
  Table is `portal.use_cases`, deliberately WITHOUT `tenant_id` — identical for
  every client, so it fits neither `task_cache` (tenant_id not null) nor
  `clickup_list_mappings` (tenant-keyed). RLS: published rows readable by any
  authenticated user (same posture as `sprints`); a withheld slug 404s.
  Sync: `POST /internal/sync/usecases` (service secret) walks the "Case Study
  Library" FOLDER `90129732418` — never the space, the account has folder-level
  access only. **Live run: 598 stored, 40 published, 558 withheld** (~2 min; 598
  sequential upserts — batch it if that becomes a problem). `capability` is NULL
  on every synced row (`0022` — the source has no capability field); the UI groups
  by `niche` / `category` / `source` instead. `0023` adds the detail narrative,
  parsed from each ClickUp description's fixed four-section layout
  (PROBLEM / WHAT GETS BUILT / CONNECTS TO / DEFINITION OF DONE) — **100% parse
  coverage on all 40**, with `body_md` kept as a verbatim fallback. NEVER synced:
  `Billed Value ($)`, `Offer Type` (pricing model), `Story Points`, `Shortlisted`.
  - [x] **Search + faceted filters** (migration `0025`) — `?q=&niche=&category=&build_type=`
    on `GET /usecases`, returning `matched`/`facets`/`snippet` alongside the rows.
    Postgres FTS, weights A=name B=description C=facet fields D=narrative, with
    prefix matching on the last word so it searches as you type. **The tsvector is
    trigger-maintained, NOT a generated column** — `concat_ws`/`array_to_string`
    are only STABLE, so a generated column fails with "generation expression is
    not immutable". `toTsQuery()` (service) sanitises input to alphanumerics and
    builds the `&`-joined query itself: never interpolate user text into
    `to_tsquery`, which parses `& | ! :* ( )` as operators. Garbage input returns
    `search_applied: false` and browses instead of erroring. Snippets use
    `ts_headline` with `[[…]]` delimiters, not HTML, so the client never needs
    `dangerouslySetInnerHTML`. Unit-tested in `tests/unit/usecase-search.test.ts`.
    Next step (not built): smart recommendations keyed off the client's projects.
  Frontend: `pages/UseCases.tsx` + `UseCaseDetailModal` + `TalkToPodModal`
  (Cal.com booking via plain iframe, link path from `VITE_CAL_LINK` — **unset, so
  booking shows a "not connected" message until it's filled in**).
- [x] **Passwordless OTP login** (migration `0019`) — `POST /auth/otp/request`
  (email a 6-digit code) + `/auth/otp/verify` (code → token pair), alongside
  (not replacing) password login. `core.otp_codes`, RLS deny-all.

**Auth pivot (migration `0014`):** replaced Supabase Auth with **self-hosted JWT**
(email/password, bcrypt, access + rotating refresh tokens). `core.user_credentials`
+ `core.refresh_tokens` (RLS deny-all). `authenticate` verifies our access token;
`tokens.ts` stamps `platform_admin`/`tenant_roles` claims at sign-in (replacing the
never-enabled Supabase hook). Endpoints: `/auth/register|login|refresh|logout|logout-all|me`.

## Integration status (external side effects)
Sync flow chosen: **ClickUp → n8n (cloud, hourly) → `POST /internal/sync/all`**.
The HMAC `/webhooks/clickup` route exists but is **unused** in this model.
Requires the backend to be publicly reachable (cloud n8n can't reach localhost).

- `email.invite` — **LIVE**: posts to `N8N_INVITE_WEBHOOK_URL` with the recipient,
  org, role, and registration link (`PORTAL_BASE_URL/register?token=…`); n8n sends
  the email. Registration is invitation-gated (`POST /auth/register` needs the token;
  email/org/role come from the invite). Admin invites via `POST /admin/clients/:id/invitations`.

STUBBED (log-only, need real integration):
- `clickup.provision_folder` outbox handler.
- `n8n.trigger_sync` / `storage.init` outbox handlers.
- Voting winner **ClickUp write-back** (`voting.service.ts`).

## Known findings / gotchas
- **NOTHING DRAINS THE OUTBOX, so every queued email silently never sends.**
  Confirmed 2026-08-07: no `npm run worker:outbox` process was running, and no
  n8n workflow calls `POST /internal/outbox/drain` (the two Portal workflows —
  `Client Portal Emails` and `My workflow 40` — are the invite and OTP *webhook
  receivers*, i.e. the far end, not the trigger). A real invite created via
  `POST /admin/clients/:id/invitations` sat `status = 'pending'` indefinitely
  with **no error surfaced anywhere**: the HTTP call returns `201`, the
  `core.invitations` row is written, and the UI shows success — the email just
  never leaves. Draining once by hand immediately delivered it (n8n execution
  `48669`, Outlook `{"success": true}`), so the pipeline itself is sound; only
  the pump is missing. Whoever puts this in production must run the worker or
  schedule the drain. Note the drain is **global**, not per-tenant: one call
  flushes every pending event, including other people's queued invites.
- **`PORTAL_BASE_URL` is set to `http://localhost:5173`, so live invite emails
  carry a link nobody but this machine can open.** The invite genuinely sent on
  2026-08-07 contained
  `http://localhost:5173/register?token=…`. Everything else about the email is
  correct (recipient, tenant name, role, real token, 14-day expiry) — the base
  URL is the only thing standing between this and a working client invite, and
  it needs a real public origin in `.env` before anyone invites a client.
- **The Sprint Line is scoped by DUE DATE, not by `task_cache.sprint_id`.**
  `portalRepo.sprintTasks` used to filter `source = 'sprint' and sprint_id = $2`
  and returned **zero rows for every tenant, every sprint** — the Dashboard showed
  "In sprint: 00" against a real active sprint. That predicate needs each task
  duplicated onto a per-sprint ClickUp list and routed by "Client Group", and no
  such list is ever populated in this workspace (Kenafric's only two
  `source = 'sprint'` rows are `client_visible = false`). A "Sprint Number" custom
  field was checked as an alternative and is unset on every delivery task. So the
  signature is now `sprintTasks(tenantId, startsOn, endsOn)`, selecting
  `source = 'delivery'` tasks whose `due_date` falls in the active sprint's
  inclusive window, and `portalService.sprintActive` passes
  `sprint.starts_on`/`ends_on`. Returns `[]` if either date is null — an unbounded
  range would return the tenant's whole backlog as "this sprint". Live: 0 rows
  before, **10** after. `source`/`sprint_id` on `task_cache` are untouched.
  - **node-postgres returns `date` columns as JS `Date`s**, so `activeSprint()`
    hands over Dates despite its own (pre-existing, inaccurate) `string | null`
    annotation — `reportsRepo.getSprintMeta` has the same wrong annotation. The
    bounds are typed `string | Date` and the SQL casts `$2::date`/`$3::date`, so a
    local-midnight Date can't be shifted a day by the server timezone. Verified
    against the live DB: server `UTC`, client `UTC+5`, bounds still resolve to
    2026-07-26 / 2026-08-09. `scripts/smoke-sprint-line.ts`.
- **The sprint health badge is decorative, not real.** The frontend's
  `sprintHealth()` derives At risk / Needs attention / On track from each task's
  `rag`, but `rag` is unset on **all 341** of Kenafric's visible delivery tasks,
  so it always falls through to a green "On track" and will stay green however bad
  the sprint gets. Meanwhile **39** tasks are genuinely past due. Overdue count is
  the honest signal; `rag` only gets filled in on the Onboarding/Offboarding lists.
- **`portal.pod_members` has no admin write path at all.** The only insert in the
  codebase is `onboarding.repository.ts` seeding three
  `display_name = 'To be assigned'`, `is_active = false` placeholders, and `/pod`
  filters `is_active = true` — so a freshly-onboarded client's Pod page is
  correctly empty and can only be staffed by direct SQL. The table is also
  deliberately flat: no `user_id`, no FK to `core.profiles`, no email, so the same
  Aidapt person on five clients is five unrelated free-text rows.
- **"Book a call" used to lie.** It was a local-state form with a hardcoded slot
  list that made no API call and wrote nothing anywhere, then toasted "Call with X
  booked for …" — a client believed a call was scheduled and no request ever
  reached Aidapt. It now hands off to the member's own scheduling page via
  `portal.pod_members.booking_url` (migration `0028`), null-safe: a member with no
  link is shown as "No calendar yet" rather than falling back to someone else's.
  Deliberately NOT a scheduling system — no slots, availability, or booking
  record. `VITE_CAL_LINK` is unrelated and still one personal Cal.com link shared
  by every client, used only by the Use Cases page's "Talk to your Pod" modal.
- **Four Kenafric delivery tasks have `bucket = null`** because `in client review`
  (2) and `internal review` (2) are in neither the global nor Kenafric's
  `clickup_status_map`. They vanish from `deliveryCounts` and render with no
  bucket in the Sprint Line — the same silent-disappearance failure as the `live`
  status before it. Two global rows would fix it; not written yet because the
  target bucket is a product call.
- **`POST /internal/voting/close-cycle` is GLOBAL** — it closes due cycles for
  every tenant. Curling it at production to "just fix one client" touches them all.
  `votingService.closeCycle(cycleId)` and the `/admin/clients/:id/voting/cycles/*`
  routes are the tenant-scoped path. Schedule the internal one **daily**
  (`0 1 * * *`), not monthly: it's idempotent and a no-op on 29 days in 30, whereas
  a monthly job that fails once silently loses a month — which is exactly how
  Kenafric's cycle ended up six days overdue.
- **5 wishlist tasks were mis-tagged `Client Group = Allied Bank` — FIXED 2026-08-07.**
  `869dcrgtj`, `869dct5cg`, `869dctm3e`, `869dcwv2n`, `869dha513` are all
  **Aidapt-internal test/demo submissions**, not client data. Reading each task's own
  body settles it — and it contradicts the `Company` field, so do NOT trust that field:
  `869dcrgtj` says Company `jewel` but the submitter email is `m.rehman@aidapt.co`;
  `869dha513` says `JFX` but the email is `sdva@jfx.com`, the same placeholder shape as
  `sdva@abl.com`, with keyboard-mash answers (`sgsdg` / `efwf` / `ewrgtewrgwer`);
  `869dcwv2n` is a fabricated persona ("Layla Nasser", 40 stores, Dubai Marina) sent
  from `m.rehman@aidapt.co`. **Retagging them to JewelFX would have been wrong** — it
  would push junk into a real client's Wishlist. All five were set to
  `Client Group = Aidapt` (option `6c790286-c97a-40e4-97f5-4849274ee9a0`), which has no
  tenant, so they are now correctly counted as unrouted.
  - **Deleting the cached rows was still required, and is the general lesson.**
    `syncWishlist` does `if (!tenantId) { skipped++; continue; }` — an unrouted task is
    skipped, never deleted — so re-tagging alone does NOT retract a row already written
    under the wrong tenant. Retagging moves a row only when the new group maps to a real
    tenant. The 5 stale `portal.wishlist_items` rows (all `candidate`, 0 votes) were
    deleted explicitly; a re-sync then confirmed they stay gone
    (`upserted: 5, skipped: 9`, Allied Bank left with only `869dhb45x`/`869dhb87u`).
    **Any future Client-Group correction needs the same two steps.**
  - A 6th (`869e3v5yn`) has no Client Group at all and is correctly counted as unrouted.
- **Wishlist bodies are internal test data.** All three Kenafric submissions come
  from `@aidapt.co` addresses with placeholder text (one reads "Pain in the ass");
  "Kenafric - Website" has the literal word `None` in every answer, which the parser
  correctly nulls, so it renders the UI's "Only a title so far" state. The parse
  gaps are correct behaviour, not failures.
- **Wishlist detail lives ONLY on the shared list.** The per-client mirrors
  (`KEN - Wishlist` `901218210637`, plus `ABL -`/`JFX -`/`TCC -`) are ClickBot copies
  created ~1.2s after the original with **empty descriptions** and different task
  ids. `isProjectList` already excludes them; the ids are recorded in
  `sync.constants.ts` so nobody points the sync at one.
- **`markdown_description` needs asking for.** The v2 task endpoints only return it
  with `include_markdown_description=true`; `text_content` renders the form's
  Submitter table as `[table-embed:…]` and plain `description` drops the pipes, so
  both are useless for parsing.
- **`GET /onboarding` was a hard 500 for every tenant** until 2026-08-06:
  `portalRepo.onboardingTasks` joins `clickup_list_mappings`, which has its own
  `clickup_list_id`, so the shared unqualified `TASK_COLUMNS` list made Postgres
  reject the whole query — `column reference "clickup_list_id" is ambiguous`. It
  broke silently when that column was added to `TASK_COLUMNS` for `projects()`.
  `TASK_COLUMNS` is now `tc.`-qualified and all three callers alias `task_cache`
  as `tc`. Nothing caught it because the smoke scripts call the *service* layer
  for projects/dashboard, and nothing exercised `/onboarding` over HTTP.
- **The onboarding read must filter `client_visible`, because its source list is
  SHARED.** `"ORG - Client - Process List"` holds one task per client engagement
  across all clients, routed per-task by Client Group. `task_cache` had **16**
  Kenafric-tagged rows from a blanket sync path — including `Allied Bank Limited`,
  `jewel fx`, `Trolley General Trading Co.` — where only **5** are actually
  Kenafric's; the 11 strays have since been deleted, and the flag filter is what
  stops the next blanket sync re-leaking them. Live state 2026-08-06: 5 rows on
  list `901218190381`, all `client_visible = true`, all Kenafric's.
  Only `syncOnboardingRequests` (which routes by Client Group) forces
  `client_visible = true`, so filtering on it is what keeps other clients' names
  out of the response. Re-running `POST /internal/sync/onboarding
  {"list_id":"901218190381"}` reports `upserted: 5, skipped: 11, status: partial`
  — the 11 skips are correct, not an error: no tenant exists for those groups.
- **Kenafric's voting cycle is overdue and has zero votes**, so there is no
  `prioritised` item to demo the wishlist→onboarding link with: cycle `2026-07`
  has `closes_at = 2026-08-01`, `is_open = true` still, and 0 rows in
  `wishlist_votes`. Nothing schedules `POST /internal/voting/close-cycle` (same
  gap as the monthly automation counter reset). Closing it as-is would prioritise
  nothing and notify every member "No votes were cast this cycle" — so it was
  left alone. The close logic itself is correct: verified inside a rolled-back
  transaction that most-votes wins and that ties go to the earliest `created_at`.
- **The Case Study Library is FOLDER-accessible only, never via the space.**
  Folder `90129732418` sits in space `90127425921` ("Shared with me"), which is
  why `get_workspace_hierarchy` never lists it (it reports only 5 spaces:
  Operations, Delivery, CRM, Sprint, Aidapt Labs). `sofi@aidapt.co` (user
  `93680533`) was granted folder access, but **`GET /space/90127425921` still
  returns `401 INSUFFICIENT_ACCESS`** — so the sync must call
  `getFolderLists(90129732418)` and must NOT use `getSpaceListing`. The folder id
  is hardcoded in `sync.routes.ts` for the same reason: it cannot be discovered.
  Its 5 populated lists are `Automation`(169) `Snowflake`(164) `Sigma`(157)
  `ClickUp`(73) `Wati`(35) = **598 tasks**. `Case Study Hub` is EMPTY despite
  ClickUp list metadata claiming `task_count: 25` — that counter is stale.
- **`Confidentiality Level` is the publish gate, and 558 of 598 are UNSET.**
  Only **40** are marked `Public`; unset is treated as NOT public (internal
  reference material must not leak). All 40 happen to be in `Automation`.
- **Case studies carry NO capability.** `OS Pillar` and `Department` are unset on
  **598/598** tasks in this folder, so capability is unavailable — hence nullable
  in `0022` and null on every synced row. The populated taxonomy is
  `Use Case Category` (16 business-function values), `Niche` (industry) and
  `Build Type`; collapsing those into Operations/Intelligence/Enablement would be
  inventing a mapping, so it is NOT done. Elsewhere in the workspace those two
  fields DO get set and still carry the retired four-OS values ("AI Operations",
  "Cross Department") — any future ingest must translate, never pass through.
- **Never sync `Billed Value ($)`** (populated on 162 case studies). Commercials
  are confidential; `portal.use_cases` deliberately has no column for it.
- **Reports come from ClickUp Docs, and Docs are v3-only.** Every other sync
  reads v2 task lists; `client.listFolderDocs`/`getDocPages` hit `api/v3` and
  need `CLICKUP_TEAM_ID` (the v2 routes don't). Docs have no custom fields, so
  the shared-list/Client-Group pattern cannot apply.
- **The reports folder is a SIBLING of the client folder, not inside it.**
  ClickUp cannot nest folders, so each client's "Monthly Progress Reports"
  folder sits beside its client folder in Delivery — and all five carry the
  identical name. Neither the folder name nor `tenants.clickup_folder_id` can
  therefore route a Doc; `tenants.clickup_reports_folder_id` (migration `0029`)
  is the mapping, and the sync enumerates docs FROM that folder rather than
  reading `doc.parent`. A Doc search by `parent_id=<folder>` does not recurse
  into the folder's lists either.
- **One Doc = one report; the identity is `clickup_doc_id`, not the root page.**
  Deleting and recreating a Doc's root page in ClickUp changes the page id but
  not the doc id, so a page-keyed upsert would insert a SECOND report for the
  same month. Sections are keyed on `clickup_page_id` and upserted (never
  wiped-and-reinserted) so their uuids survive the hourly run, with an
  orphan-delete for pages removed in ClickUp.
- **The single-published tiebreak is load-bearing, not cosmetic.** Kenafric has
  TWO Docs for July 2026 — a legacy duplicate (`8ckbtec-234592`, byte-identical
  content) beside the real one (`8ckbtec-240992`) — with the same `period_end`.
  `archiveSupersededSyncedReports` and `notifyPublishedReport` are both
  tenant-scoped and MUST share the ordering `period_end desc, doc_updated_at
  desc nulls last, clickup_doc_id desc`. Without a stable secondary key the
  "current" report alternates between runs, and because the notification
  idempotency guard keys on the report's own `/reports/:id` link, every flip
  emits a fresh "new report published" — an hourly notification storm.
- **An empty Doc syncs as a `draft`, not `published`.** Trojan's Doc
  (`8ckbtec-241092`) has one page with an empty name and no content. The row is
  still written so the sync stays traceable and idempotent, but a client never
  sees a blank report, and it promotes itself once someone writes the Doc.
- **Report periods are read, not derived** — unlike the retired bi-weekly series.
  The root page states `**Report Period:** (01–31 July 2026)`, but the format
  varies across clients: en dash (KEN), plain hyphen (ABL/TCC), and a
  `Weeks 18 to 23 (01-31 July 2026)` prefix (JFX). `parseReportPeriod` prefers
  the LAST parenthetical (so "18 to 23" can't be read as a day range) and strips
  `Weeks N to M` phrases before matching. Fallback chain when the line is
  missing: `**Date:**` → doc name (this is what dates Trojan's empty Doc) → root
  page name (this is what dates the legacy Kenafric Doc, whose page name and doc
  name disagree) → skip the Doc and name it in `sync_runs`. It never defaults to
  today. `published_at` is the period end, not `date_created`.
- **The root page and every pillar page repeat the same metadata block**
  (`**Client:** / **Report Period:** / **Date:**`), so `stripHeaderBlock` drops
  the leading `**Label:** value` run — otherwise a client reads it four times.
  The italic `_Scope in this engagement…_` line is content and is kept.
  `## Deep-Dive Links` is stripped too: those links are **broken at source**
  (JFX's root points at doc `8ckbtec-239852` while its real pages are
  `8ckbtec-220252`/`…272`; TCC's points at `8ckbtec-239812` — copy-paste
  artefacts of duplicating a template) and the portal renders those pillars
  inline anyway.
- **ClickUp's markdown export drops the line breaks the Doc shows**, so the
  6-line report header renders as one run-on sentence (consecutive lines are a
  single paragraph joined by soft breaks). `normalizeDocMarkdown` re-adds hard
  breaks and normalises CRLF→LF at ingest, so bodies are correct for any
  standard CommonMark/GFM renderer without the frontend needing `breaks: true`.
  It skips structural lines and fenced code — ClickUp already fences its
  pre-formatted content, and breaking inside a fence would render literal
  trailing spaces.
- The report **Action Item Tracker's columns move between pages** (some are
  `# | Action Item | Owner | Status`, others add `Source` and `Due`), so
  `parseTrackerCounts` finds the status column by header name and scopes to the
  tracker section — the Risks table further down also contains ✅. Only the
  PILLAR pages carry a tracker; the root page has none, so report-level counts
  are `sumTrackerCounts` over the sections. If no section had a tracker the
  result is `null`, not `0` — "nobody tracked anything" must not render as
  "everything came to zero".
- **`/projects` is phase-shaped, not task-shaped.** The sync pulls subtasks
  (`subtasks=true`) and ClickUp nests them up to **3 deep** here, so a flat read
  showed a client 159 "tasks" for a 6-phase project. `portalRepo.projects` returns
  only phases (no parent among the visible set — testing against top-level ids
  alone wrongly promotes every grandchild) with all descendants flattened into
  `subtasks`. `portal.clickup_list_mappings` is scoped by `isProjectList`: every
  client folder carries the same non-project furniture (`* - Wishlist`,
  `Onboarding`, `Offboarding`, `Monthly Progress Reports`) which the sync now
  retires rather than maps. `/wishlist` and `/onboarding` read their own sources
  (`portal.wishlist_items`, the shared "ORG - Client - Process List"), so this
  costs them nothing.
- **The onboarding source list is SHARED across every client, so only
  `syncOnboardingRequests` may ingest it.** "ORG - Client - Process List"
  (`901218190381`) holds one task per client engagement workspace-wide, routed
  per task by "Client Group". Two paths used to file the whole list under a
  single tenant instead — `syncDelivery` (its `getDeliveryListIds` included
  `purpose='onboarding'`) and the hourly space walk (`isProjectList` says true
  for that name, and `resolveTenantByListId` resolves it *via the onboarding
  mapping itself*). Result: 11 of 16 tasks — Allied Bank, JewelFX/Evermore,
  Tile & Carpet, Trolley, Aidapt — sat in Kenafric's cache. Both paths now skip
  any list whose mapped purpose isn't `'project'` (`syncRepo.getListPurpose`),
  and `/onboarding` filters `client_visible` like every other client read, which
  only the Client-Group-routing sync sets. **Any new shared list must get the
  same two guards.** Consequence: the hourly `/internal/sync/all` no longer
  refreshes this list at all — `POST /internal/sync/onboarding {list_id}` has to
  be on the n8n schedule in its own right (as `/sync/wishlist` already is).
- **`/dashboard`'s `projects` counts are still ALL delivery tasks**, subtasks
  included — 272/28/32 for Kenafric where the phase-level truth is 35/3/8. The
  field is named `projects` but `portalRepo.deliveryCounts` counts task rows.
  Left as-is: whether that tile should count projects, phases, or tasks is a
  product call, not a bug fix.
- **ClickUp custom fields are matched by ID, never name** (`mapper.ts` `FIELD`).
  Names are workspace-editable and a rename breaks the sync silently, with zero
  errors — that's how `Type of Work` → `Type of Work (Phoenix)` left `type_of_work`
  null on every row. Field ids are workspace-level ("team fields"), stable across
  renames and shared by every list in Delivery + Sprint. Two traps: "Progress" is a
  drop-down health label (At Risk/On Track), NOT the percentage — that's
  "Progress %", type `automatic_progress`, whose value is `{percent_complete: N}`,
  not a scalar. `Client Visible` is set on **no** task in the workspace; delivery
  visibility comes from the per-project flag instead.
- `type_of_work`/`rag` are only actually filled in on the per-client
  Onboarding/Offboarding lists; the `OPS - *` delivery lists leave them unset in
  ClickUp, so those rows are legitimately null (data gap, not a sync bug).
- **LMS schema is self-contained** — the LMS team deployed `LMS_`-prefixed tables
  with their OWN users/groups/domains, replacing our placeholder `lms.*`. Portal
  onboarding no longer writes to `lms`; the dashboard LMS tile is computed by
  joining `core.tenant_email_domains.domain → lms.LMS_client_domains → client group`.
  Diverges from the design's "one identity" premise — flagged, not yet reconciled.
- `INSERT ... SELECT` with bare `$n` params needs explicit casts; every param must
  be referenced or Postgres rejects the statement.
- `audit_log` FKs are `ON DELETE SET NULL` (migration `0012`) so history survives.
- **Route order matters**: `portalRoutes` is mounted at `/` with a router-level
  `authenticate`, so it MUST be registered LAST in `api/routes/index.ts` — otherwise
  its auth guard intercepts `/internal/*` and `/webhooks/*` (401 before their
  service-secret check). Verified by the e2e harness (`scripts/e2e.ts`).
- migration `0001` grants `anon` SELECT on all `core` tables (+ default privileges),
  so any sensitive table MUST enable RLS. `core.user_credentials`/`refresh_tokens`
  are RLS deny-all (0014); apply the same to any future secret-bearing table.

## Pending manual (Supabase dashboard — SQL can't do these)
1. Expose schemas `core`, `portal` (Project Settings → API → Exposed schemas) —
   only needed if the RLS/Supabase-client path is ever revived.
2. ~~Enable the auth hook~~ — obsolete under self-hosted auth; the API stamps
   `tenant_roles`/`platform_admin` claims into the access token directly.

## Env (see `.env.example`)
`JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET` (≥32 chars), `JWT_ACCESS_TTL` (15m),
`JWT_REFRESH_TTL` (30d), `BCRYPT_ROUNDS` (12),
`SUPABASE_URL/ANON_KEY/SERVICE_ROLE_KEY`, `DATABASE_URL` (port 5432 direct),
`INTERNAL_API_SECRET`, `CLICKUP_API_TOKEN`, `CLICKUP_TEAM_ID`, `CLICKUP_SPACE_IDS`
(Delivery + Sprint), `CLICKUP_WEBHOOK_SECRET` (unused in n8n flow),
`PORTAL_BASE_URL` (invite link base), `N8N_INVITE_WEBHOOK_URL` (invite email),
`N8N_OTP_WEBHOOK_URL` (OTP email, optional — logs the code outside production
if unset), `OTP_TTL_MINUTES` (10), `OTP_MAX_ATTEMPTS` (5).

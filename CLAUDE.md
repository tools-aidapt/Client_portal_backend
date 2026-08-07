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
- [x] **5. Wishlist + voting** — `/wishlist` (list/submit/vote, MemberPlus+),
  month-end `POST /internal/voting/close-cycle` (winner→prioritised, notify, reopen).
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
  - [x] **Reports sync from ClickUp Docs** — `POST /internal/sync/reports`
    `{doc_id, tenant_id?}`. Source is the client's Project Pack **Doc**, not a
    task list: its "Project Updates" child pages are the bi-weekly reports.
    Kenafric is live from doc `8ckbtec-180492` (9 reports, Mar–Jul 2026).
- [x] **Invitations** — invitation-gated registration + n8n invite email (LIVE).
  Inviter sets the role. Platform admin (`POST /admin/clients/:id/invitations`) can
  grant any role incl. `super_admin` (→ sets `is_platform_admin`). Org admin/member_pro
  (`POST /invitations`) invites into their own tenant, non-super_admin only.
  `POST /auth/register` needs the token + collects profile (fullName, jobTitle,
  department, phone, avatarUrl, interests[]). `PATCH /auth/me` edits profile.
  Profile fields added in migration `0015`.
- [ ] **7. Notifications** — table + reads done; most sources already emit
  (onboarding, voting, reports). Remaining: wire remaining event sources as built.
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
- **Reports come from a ClickUp Doc, and Docs are v3-only.** Every other sync
  reads v2 task lists; `client.getDoc`/`getDocPages` hit `api/v3` and need
  `CLICKUP_TEAM_ID` (the v2 routes don't). Docs route to a tenant by their own
  `parent` (type 5 = folder, 6 = list) — there is no "Client Group" custom field
  on a Doc, so the shared-list/Client-Group pattern does not apply here.
  Doc search by `parent_id=<folder>` does **not** recurse into the folder's
  lists, which is where the Kenafric pack actually sits (list 901218118508).
- **Report period starts are derived, not sourced.** A report page states its
  period only as prose ("Report Period: Weeks 18–19"), so `period_start` is the
  day after the previous report's date (first report falls back to 14 days).
  Likewise `published_at` is the report's own issue date, not the page's
  `date_created` — Reports 1–5 were backfilled into the Doc in one batch and
  all carry a ~19 May 2026 creation date.
- **ClickUp's markdown export drops the line breaks the Doc shows**, so the
  6-line report header renders as one run-on sentence (consecutive lines are a
  single paragraph joined by soft breaks). `normalizeDocMarkdown` re-adds hard
  breaks (47 across the 9 Kenafric reports) and normalises CRLF→LF at ingest, so
  `summary_md` is correct for any standard CommonMark/GFM renderer without the
  frontend needing `breaks: true`. It skips structural lines and fenced code —
  ClickUp already fences its pre-formatted content (Report 2's architecture
  diagram), and breaking inside a fence would render literal trailing spaces.
- The report **Action Item Tracker's columns move between reports** (Report 1 is
  `# | Action Item | Owner | Status`; Report 9 adds `Source` and `Due`), so
  `parseTrackerCounts` finds the status column by header name and scopes to the
  tracker section — the Risks table further down also contains ✅.
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

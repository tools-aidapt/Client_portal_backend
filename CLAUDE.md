# CLAUDE.md — Aidapt Portal Backend

Working context for this repo. Keep this file current: update the **Build status**
and **Integration status** sections whenever a step or integration changes.

## What this is
The **Portal (parent) backend** of the Aidapt Portal ecosystem — a TypeScript +
Express + Supabase (Postgres) API. One shared Supabase project/database, four
schemas: `core` (shared identity/tenancy), `portal`, `lms`, `support`. This repo
owns the full shared migration set even though LMS/Support are separate apps.

Full system design is the source of truth for intent; `docs/ARCHITECTURE.md`
covers the layered/module layout. Design section references (e.g. §10.4) point
at that design doc.

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
- Middlewares: `authenticate` (verify Supabase JWT), `requirePlatformAdmin`,
  `requireServiceSecret` (internal endpoints), `requireTenantRole(min)` (resolves
  active tenant from `x-tenant-id`/`tenant_id`/sole membership + gates by role).
- Role rank: member < member_plus < member_pro < super_admin (`common/constants/roles.ts`).
- Live behaviour is verified with throwaway `scripts/smoke-*.ts` (run via tsx,
  create → assert → clean up). Not part of `npm test` (which is unit-only).

## Build status (design §12 sequence)
- [x] **1. Foundation** — 4 schemas, enums, tables, RLS (42 policies), auth hook,
  helpers, profile trigger. Migrations `0001`–`0013` applied to the live DB.
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
- [x] **6. Reports + Sprint Pulse** — admin create(seeded from sprint)/publish,
  MemberPro list/detail/pulse.
- [ ] **7. Notifications** — table + reads done; most sources already emit
  (onboarding, voting, reports). Remaining: wire remaining event sources as built.
- [ ] **8. LMS/Support summary refresh** — LMS tile is live via join; Support reads
  `support.tenant_support_summary`. `/lms|support/internal/refresh-summary` not built.
- [ ] **9. Automation health** — `portal.automation_workflows`/`automation_health`
  tables exist; endpoints + n8n execution webhook not built.

## Integration status (external side effects)
Sync flow chosen: **ClickUp → n8n (cloud, hourly) → `POST /internal/sync/all`**.
The HMAC `/webhooks/clickup` route exists but is **unused** in this model.
Requires the backend to be publicly reachable (cloud n8n can't reach localhost).

STUBBED (log-only, need real integration):
- `email.invite` outbox handler — no invitation email actually sent.
- `clickup.provision_folder` outbox handler.
- `n8n.trigger_sync` / `storage.init` outbox handlers.
- Voting winner **ClickUp write-back** (`voting.service.ts`).

## Known findings / gotchas
- **LMS schema is self-contained** — the LMS team deployed `LMS_`-prefixed tables
  with their OWN users/groups/domains, replacing our placeholder `lms.*`. Portal
  onboarding no longer writes to `lms`; the dashboard LMS tile is computed by
  joining `core.tenant_email_domains.domain → lms.LMS_client_domains → client group`.
  Diverges from the design's "one identity" premise — flagged, not yet reconciled.
- `INSERT ... SELECT` with bare `$n` params needs explicit casts; every param must
  be referenced or Postgres rejects the statement.
- `audit_log` FKs are `ON DELETE SET NULL` (migration `0012`) so history survives.

## Pending manual (Supabase dashboard — SQL can't do these)
1. Expose schemas `core`, `portal` (Project Settings → API → Exposed schemas).
2. Enable the auth hook (`core.custom_access_token_hook`) — until then JWTs carry
   no `tenant_roles`/`platform_admin` claims and RLS denies. (Backend has DB
   fallbacks so app-level authz works regardless.)

## Env (see `.env.example`)
`SUPABASE_URL/ANON_KEY/SERVICE_ROLE_KEY`, `DATABASE_URL` (port 5432 direct),
`INTERNAL_API_SECRET`, `CLICKUP_API_TOKEN`, `CLICKUP_TEAM_ID`, `CLICKUP_SPACE_IDS`
(Delivery + Sprint), `CLICKUP_WEBHOOK_SECRET` (unused in n8n flow).

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

## Build status (design §12 sequence)
- [x] **1. Foundation** — 4 schemas, enums, tables, RLS (42 policies), auth hook,
  helpers, profile trigger. Migrations `0001`–`0013` applied to the live DB.
  `0014` (self-hosted auth) **not yet applied** — run `db:migrate` against live DB.
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
`PORTAL_BASE_URL` (invite link base), `N8N_INVITE_WEBHOOK_URL` (invite email).

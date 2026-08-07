# Aidapt Portal API — Frontend Reference

Base URL: `<API_BASE>` + prefix `/api/v1` (e.g. `http://localhost:3000/api/v1`).
Health check (no auth): `GET <API_BASE>/health`.

## Authentication

Auth is **self-hosted (email + password, JWT)** — issued and verified by this API.
No Supabase client / publishable key is needed on the frontend for auth.

```
POST /auth/register    { token, password, fullName, jobTitle?, department?, phone?, avatarUrl?, interests?[] }
                       -> { userId, accessToken, refreshToken, tokenType, expiresIn }
POST /auth/login       { email, password }           -> { userId, accessToken, refreshToken, tokenType, expiresIn }
POST /auth/otp/request { email }                     -> { sent: true }  (always, regardless of whether the email exists)
POST /auth/otp/verify  { email, code }                -> { userId, accessToken, refreshToken, tokenType, expiresIn }
POST /auth/refresh     { refreshToken }              -> { accessToken, refreshToken, tokenType, expiresIn }  (rotates)
POST /auth/logout      { refreshToken }              -> { revoked }
POST /auth/logout-all (Bearer)                       -> revoke all sessions
```

**Password and OTP are both always available** — the client lets the user pick either
per sign-in attempt; there's no per-account setting or migration between them.
For OTP: call `/auth/otp/request` first (a 6-digit code is emailed, ~10 min TTL,
5 attempts), then `/auth/otp/verify` with the code the user enters — it returns
the same token pair shape as `/auth/login`.

- **`accessToken`** is short-lived (~15m). Send it on every request:
  ```
  Authorization: Bearer <accessToken>
  ```
- **`refreshToken`** is long-lived (~30d) and **single-use / rotating**: each
  `/auth/refresh` returns a new pair and invalidates the one you sent. Store it
  securely (httpOnly cookie or secure storage), not in localStorage if avoidable.
- On a `401` from any endpoint, call `/auth/refresh` once, then retry; if refresh
  also fails, send the user back to login.

**Registration is invitation-only.** An admin invites a user; they receive an email
(sent via n8n) with a link like `<PORTAL_BASE_URL>/register?token=<token>`. Your
register page reads `token` from the query string and POSTs it with the chosen
password to `/auth/register`. The email, org, and role are fixed by the invitation —
the user cannot register into an org they weren't invited to. There is no open sign-up.

### Tenant context
A user can belong to multiple client tenants. If they belong to exactly one, it's
inferred. Otherwise (or to be explicit) send the tenant id:

```
x-tenant-id: <tenant-uuid>
```

Get the user's tenants + role from `GET /auth/me` and let them pick.

## Response envelope

Success:
```json
{ "success": true, "data": { ... }, "meta": { ... } }
```
Failure:
```json
{ "success": false, "error": { "code": "NOT_FOUND", "message": "…", "details": {} } }
```
Common statuses: `401` (missing/invalid token), `403` (wrong role / not a member),
`404`, `409` (conflict, e.g. already voted), `422` (validation — `details` has field errors).

## Roles (capability tiers)
`member` < `member_plus` < `member_pro`. `super_admin` = Aidapt staff.
Each endpoint below notes the minimum role.

---

## Identity
| Method | Path | Role | Body / Notes |
|---|---|---|---|
| POST | `/auth/register` | public (invite-gated) | `{ token, password, fullName? }` — the invite token; email/org/role come from it → token pair |
| POST | `/auth/login` | public | `{ email, password }` → token pair |
| POST | `/auth/otp/request` | public | `{ email }` → `{ sent: true }` (emails a 6-digit code if the account exists) |
| POST | `/auth/otp/verify` | public | `{ email, code }` → token pair |
| POST | `/auth/refresh` | public | `{ refreshToken }` → rotated token pair |
| POST | `/auth/logout` | public | `{ refreshToken }` |
| POST | `/auth/logout-all` | any signed-in | revoke all refresh tokens |
| GET | `/auth/me` | any signed-in | `{ id, full_name, job_title, department, phone, interests, avatar_url, is_platform_admin, memberships[], apps[] }` |
| PATCH | `/auth/me` | any signed-in | update profile fields (`fullName?, jobTitle?, department?, phone?, avatarUrl?, interests?[], locale?`) |
| POST | `/auth/me/avatar` | any signed-in | multipart form field `file` (image, ≤2MB) → `{ avatar_url }` |
| POST | `/invitations` | member_pro | org admin invites into their own tenant: `{ email, role: member\|member_plus\|member_pro }` (no super_admin) → emails the link |
| POST | `/invitations/accept` | any signed-in | `{ token }` — existing user accepts an invite, then re-`login`/`refresh` |

## Portal (client-facing, tenant-scoped)
| Method | Path | Role | Returns |
|---|---|---|---|
| GET | `/dashboard` | member_plus | project counts, active sprint, LMS+Support tiles, unread count |
| GET | `/projects` | member_plus | `{ total, projects: [{ clickup_list_id, name, status, progress_pct, phase_total, phase_done, tasks[] }] }` — one row per ClickUp list (a "project"). `tasks` are its **phases**: the top-level ClickUp tasks only ("1. Current State Discovery" … "7. Training & Handover"), each with `subtasks[]` (all descendants flattened, each tagged `depth` 1–3), `subtask_total`/`subtask_done`. `status` is derived from the phases; `progress_pct` is their average (null when no phase reports progress). Lists that aren't client projects — per-client `* - Wishlist`, `Onboarding`, `Offboarding`, `Monthly Progress Reports` — are excluded at sync time (`isProjectList`) |
| GET | `/sprint/active` | member_plus | `{ sprint, tasks[] }` |
| GET | `/onboarding` | member_plus | `{ tasks[], intake_form_url }`. Each task carries the usual `task_cache` fields **plus `source_wishlist_item_id`** and **`source_wishlist_title`** — set when an admin has linked this task to the wishlist item it came out of (a prioritised voting winner the Pod then scoped). The title is joined in so the UI can render "Originated from your Wishlist: …" without a second request; both fields are null on unlinked tasks, and either both are set or neither is. `intake_form_url` is still always null |
| GET | `/pod` | member | `{ members[] }` |
| GET | `/automations/health` | member_plus | `{ workflows[] }` — client-visible n8n workflow health |
| GET | `/usecases` | member_plus | The **tenant-agnostic** catalogue of automations Aidapt can build, from `portal.use_cases`. **Searchable + filterable** via query params: `?q=` (free text), `?niche=`, `?category=`, `?build_type=` (each ≤120/80 chars). Returns `{ total, matched, query, facets, library[] }` — `total` is all published studies (the "of N" denominator), `matched` is the count for this search+filters, `query` echoes what was applied plus **`search_applied`** (false when `q` held nothing searchable, e.g. only punctuation — the API then returns everything rather than erroring), and `facets` gives `{ niche[], category[], build_type[] }` as `{value, count}` computed over the **search** but ignoring the dimension filters, so pill counts stay stable as you toggle them. Each library row: `{ slug, name, capability, description, category, niche, build_type, source, snippet }`. **`snippet`** is the matching passage with matched runs wrapped in `[[…]]` — deliberately plain text, not HTML, so the client highlights without `dangerouslySetInnerHTML`; null when not searching. Search is Postgres FTS over name (weight A), description (B), the facet fields (C) and the full narrative (D), with prefix matching on the last word so it works as the user types. Results are ranked by relevance when searching, else alphabetical. Currently **40 published entries**; `capability` is always null (the source has no capability field). This is NOT the client's own work — that's `/projects`. No commercial figures are ever exposed |
| GET | `/usecases/:slug` | member_plus | One study with its full narrative, for the expanded card: the list fields plus `{ business_function, integration_type, problem, what_gets_built, connects_to[], definition_of_done, body_md }`. The four narrative sections are parsed from the ClickUp description (100% coverage on the current 40); `connects_to` is a list of systems it integrates with. `body_md` is the raw body and is only non-null when the sections failed to parse — render it verbatim as a fallback. Unpublished studies are **not addressable** — an unknown or withheld slug returns `404` |
| GET | `/notifications` | member | `{ items[], unread }` |
| POST | `/notifications/:id/read` | member | marks read |

## Wishlist
| Method | Path | Role | Body |
|---|---|---|---|
| GET | `/wishlist` | **member** (read-only) | `{ cycle, last_closed_cycle, items[] }` — see below |
| POST | `/wishlist` | member_plus | `{ title, description?, reference_video_url?, department? }` — a portal-native request. **The Wishlist page does not use this**; it links out to `submit_form_url` so every request goes through ClickUp. Kept for API completeness |
| POST | `/wishlist/:id/vote` | member_plus | — → `{ item_id, votes, voted: true, changed }`. **Idempotent**: voting twice is a `200` with `changed: false`, not a `409`. `400` if the item is no longer a `candidate` |
| DELETE | `/wishlist/:id/vote` | member_plus | remove your vote → `{ item_id, votes, voted: false, changed }`. **Idempotent**: un-voting when you hadn't voted is a `200` with `changed: false`, not a `404`. `400` when no cycle is open — a decided cycle can't be rewritten |

**Reading is `member`; submitting and voting are `member_plus`.** A base-tier member
sees the whole board read-only (this endpoint used to be `member_plus` router-wide,
which meant a member landing on `/wishlist` got a 403).

`GET /wishlist?state=candidate|prioritised|in_progress|shipped` filters the board.
Unfiltered, `shipped` items sort to the bottom rather than being hidden — the
"you asked for this, we shipped it" loop is the point of the feature.

**Two cycles come back, and you need both.** `cycle` is the one accepting votes
(`null` when none is open); `last_closed_cycle` is the most recent closed one and
is what the winner card should read. Each carries
`{ id, period_month, opens_at, closes_at, is_open, is_overdue, winning_item_id, winning_item_title }`.
**Never infer open/closed from `closes_at`** — a cycle sits open past its close date
until something closes it, which is what `is_overdue` reports. Render that as
"closing now", never as a negative countdown.

Each item carries, beyond `id / title / description / reference_video_url /
department / state / created_at`:

- **`votes`** — count for `cycle` if one is open, else for `last_closed_cycle`, so a
  tenant between cycles still sees a real tally instead of a board of zeros.
  When there is **no cycle at all** these are `0` because there is no window to
  count against — hide counts in that state rather than asserting zero.
- **`votes_all_time`**, **`voted_by_me`** and **`can_vote`**. The latter two reflect
  the **open** cycle only: a "Voted" state sourced from a closed cycle could not be
  undone, because un-voting needs an open cycle.
- **The parsed request detail** — `problem`, `who_feels_pain`, `urgency`,
  `submitter_notes`, `submitter_name`, `submitter_role`, `submitter_company`,
  `submitted_at`. All nullable; the intake form's placeholders (`None`, `—`) arrive
  as `null`, so render nothing rather than the placeholder. Retired taxonomy
  ("ProductivityOS"/"DataOS") is stripped and never returned.
- **`body_md`** — the leftover form body, sent **only when `problem` is null**.
  It is **markdown — render it as markdown**, not as plain text. It contains only the
  parts of the body that have no column of their own: the sections we parse (Problem,
  Notes, Submitter), the fields we parse (Urgency, Who feels the pain), the request
  title, placeholder-only answers, and retired taxonomy are all stripped, so it never
  duplicates a section you're already rendering and never shows a client "None" or "—".
  Usually null.
- **`submit_form_url`** (top level, beside `cycle`) — the public request form.
  **Requests are authored in ClickUp, not in the Portal**: the form writes to the
  shared wishlist list and the item reaches the board at the next
  `POST /internal/sync/wishlist`. Link out to it rather than POSTing from the client,
  so every request enters through one pipeline. Null when `WISHLIST_FORM_URL` is
  unset — render the button disabled rather than linking nowhere.
- **`source`** — `'portal'` (typed into the Portal) or `'request_form'` (the shared
  intake form). The ClickUp task id is deliberately never exposed.

## Reports & Sprint Pulse
| Method | Path | Role | Body |
|---|---|---|---|
| GET | `/reports` | member_pro | published + archived list, newest first. Each row adds `pillars` (e.g. `["AI Operations","Intelligence","Enablement"]`) and `section_count`; no section bodies |
| GET | `/reports/:id` | member_pro | detail incl. `my_pulse` and `sections[]`. **`summary_md` is the Doc's ROOT page only** (Executive Summary, Pillar Status Snapshot, Consolidated Risks) — the bulk of a monthly report is in `sections`, so rendering `summary_md` alone drops most of it. Each section: `{ id, pillar, pillar_label, pillar_owner, subtitle, body_md, committed_count, delivered_count }`, ordered; `[]` when the Doc has no pillar pages |
| POST | `/reports/:id/pulse` | member_pro | `{ score: 1..5, comment? }` |
| POST | `/reports` | super_admin | create draft (`{ tenant_id, sprint_id?, title?, period_start?, period_end?, … }`) |
| POST | `/reports/:id/publish` | super_admin | publish |

Reports are **monthly, one per client per ClickUp Doc**. Each client has its own
"Monthly Progress Reports" folder in the Delivery space (mapped by
`core.tenants.clickup_reports_folder_id`) holding one Doc per month; the Doc's
root page is the report body and its child pages are the pillar deep-dives that
become `sections`. Report-level `committed_count`/`delivered_count` are the SUM
of the pillar Action Item Trackers, and are `null` — not `0` — when no pillar
page had a tracker. Sync: `POST /internal/sync/reports` with `{}`.

## Admin — client lifecycle (super_admin)
| Method | Path | Body |
|---|---|---|
| POST | `/admin/clients` | `{ name, email_domains[], product_tier?, clickup_folder_id?, clickup_client_group?, admin_email, sigma_ready }` |
| POST | `/admin/clients/:id/invitations` | `{ email, role }` — any role incl. `org_admin` / `super_admin`; emails the registration link via n8n |
| POST | `/admin/clients/:id/automations` | `{ n8n_workflow_id, name, description?, is_client_visible? }` — register a workflow |
| GET | `/admin/clients` | list tenants |
| GET | `/admin/clients/:id/onboarding` | onboarding state machine |
| PUT | `/admin/clients/:id/clickup-mapping` | `{ clickup_folder_id?, clickup_client_group? }` |
| GET | `/admin/clients/:id/members` | `{ members[] }` — everyone who already belongs to this client: `user_id`, `full_name`, `email`, `role`, `status`, `joined_at`. `email` is **null** for anyone with no `core.user_credentials` row (an account made by direct SQL, not by registering), so the join is a LEFT one and they still appear. Distinct from invitations: a pending invite is NOT a member until the person registers |
| PATCH | `/admin/clients/:id/members/:userId` | `{ role?, status? }` — change one member's standing in this client. `role` is tenant-scoped only (`member` / `member_plus` / `member_pro` / `org_admin`); **`super_admin` is rejected by name** (422) because platform-wide access isn't something a per-client screen grants — use `/invitations` for that. `status` is `invited` / `active` / `suspended`; suspending is how access is revoked, so the membership history survives. An omitted field is left untouched, not nulled. `404` when that user has no membership *in this tenant*, which is also what blocks editing another client's member by guessing an id |
| GET | `/admin/clients/:id/projects` | discovered projects + visibility |
| POST | `/admin/clients/:id/projects/discover` | pull projects from ClickUp |
| PATCH | `/admin/clients/:id/projects/:listId` | `{ is_visible }` |
| GET | `/admin/clients/:id/wishlist-items` | `{ items[] }` — the client's wishlist items (`id`, `title`, `state`, `created_at`) each with `linked_clickup_task_id` / `linked_task_name`, so you can see which prioritised items still need a Process List task attached |
| PATCH | `/admin/clients/:id/tasks/:taskId/wishlist-source` | `{ wishlist_item_id: uuid \| null }` — state that a cached task came out of a wishlist item (surfaces on `GET /onboarding` as `source_wishlist_title`); `null` unlinks. `:taskId` is the **ClickUp** task id, not the internal uuid. `404` if the task isn't cached for this client, or if the wishlist item isn't this client's — the link is always within one tenant. Deliberately manual: nothing can match a ClickUp task to a wishlist item automatically |

## Admin — voting cycles (super_admin, tenant-scoped)
| Method | Path | Body |
|---|---|---|
| GET | `/admin/clients/:id/voting/cycles` | `{ cycles[] }` — each with `is_open`, `is_overdue`, `winning_item_id/_title`, `total_votes`, `voters` |
| GET | `/admin/clients/:id/voting/cycles/:cycleId/breakdown` | `{ items[] }` — per-item vote counts for that cycle |
| POST | `/admin/clients/:id/voting/cycles/:cycleId/close` | `{ notify?: boolean = true }` — close now: pick the winner, prioritise it, open the next cycle. **`notify: false` closes silently**, which is the intended path for a cycle that expired with no votes |
| PATCH | `/admin/clients/:id/voting/cycles/:cycleId` | `{ closes_at }` — extend an open cycle. `400` if it's already closed or `closes_at` isn't in the future |
| POST | `/admin/clients/:id/voting/cycles/:cycleId/reopen` | `{ closes_at }` — reopen a closed cycle and clear its recorded winner. The winning item's `state` is deliberately NOT rolled back; flip it explicitly if that's wanted |
| POST | `/admin/clients/:id/voting/cycles` | `{ period_month?, closes_at? }` — open a cycle for a client that has none. `409` if one is already open |
| PATCH | `/admin/clients/:id/wishlist-items/:itemId` | `{ state }` — the **only** path to `in_progress` / `shipped`; the close job only ever sets `prioritised` |

All of these are scoped to the tenant in `:id`, and a cycle belonging to another
client is a `404`. **At most one cycle can be open per tenant** (enforced by a
partial unique index, migration `0027`).

## Not for the frontend
`/internal/*` and `/webhooks/*` are service-role endpoints (cron / n8n / ClickUp),
guarded by a shared secret — never call them from the browser.

`POST /internal/voting/close-cycle` `{ notify?: boolean = true }` closes every due
cycle **for every tenant**. Put it on a **daily** schedule (`0 1 * * *`), not a
monthly one: it's idempotent and a no-op on 29 days in 30, whereas a monthly job
that fails once silently loses a whole month. Use the tenant-scoped admin route
above to act on a single client.

---

## CORS
The API allows origins from `CORS_ORIGINS` (server env). Ask the backend owner to
add your dev origin (e.g. `http://localhost:5173`) if requests are blocked.

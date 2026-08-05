# Aidapt Portal API — Frontend Reference

Base URL: `<API_BASE>` + prefix `/api/v1` (e.g. `http://localhost:3000/api/v1`).
Health check (no auth): `GET <API_BASE>/health`.

## Authentication

Auth is **self-hosted (email + password, JWT)** — issued and verified by this API.
No Supabase client / publishable key is needed on the frontend for auth.

```
POST /auth/register  { token, password, fullName, jobTitle?, department?, phone?, avatarUrl?, interests?[] }
                     -> { userId, accessToken, refreshToken, tokenType, expiresIn }
POST /auth/login     { email, password }             -> { userId, accessToken, refreshToken, tokenType, expiresIn }
POST /auth/refresh   { refreshToken }                -> { accessToken, refreshToken, tokenType, expiresIn }  (rotates)
POST /auth/logout    { refreshToken }                -> { revoked }
POST /auth/logout-all (Bearer)                       -> revoke all sessions
```

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
| GET | `/projects` | member_plus | `{ total, buckets: { delivered[], in_progress[], upcoming[] } }` |
| GET | `/sprint/active` | member_plus | `{ sprint, tasks[] }` |
| GET | `/onboarding` | member_plus | `{ tasks[], intake_form_url }` |
| GET | `/pod` | member | `{ members[] }` |
| GET | `/automations/health` | member_plus | `{ workflows[] }` — client-visible n8n workflow health |
| GET | `/notifications` | member | `{ items[], unread }` |
| POST | `/notifications/:id/read` | member | marks read |

## Wishlist
| Method | Path | Role | Body |
|---|---|---|---|
| GET | `/wishlist` | member_plus | `{ cycle, items[] }` (items have `votes`, `voted_by_me`) |
| POST | `/wishlist` | member_plus | `{ title, description? }` |
| POST | `/wishlist/:id/vote` | member_plus | — (one vote per item per open cycle) |

## Reports & Sprint Pulse
| Method | Path | Role | Body |
|---|---|---|---|
| GET | `/reports` | member_pro | published + archived list |
| GET | `/reports/:id` | member_pro | detail incl. `my_pulse` |
| POST | `/reports/:id/pulse` | member_pro | `{ score: 1..5, comment? }` |
| POST | `/reports` | super_admin | create draft (`{ tenant_id, sprint_id?, title?, period_start?, period_end?, … }`) |
| POST | `/reports/:id/publish` | super_admin | publish |

## Admin — client lifecycle (super_admin)
| Method | Path | Body |
|---|---|---|
| POST | `/admin/clients` | `{ name, email_domains[], product_tier?, clickup_folder_id?, clickup_client_group?, admin_email, sigma_ready }` |
| POST | `/admin/clients/:id/invitations` | `{ email, role }` — any role incl. `org_admin` / `super_admin`; emails the registration link via n8n |
| POST | `/admin/clients/:id/automations` | `{ n8n_workflow_id, name, description?, is_client_visible? }` — register a workflow |
| GET | `/admin/clients` | list tenants |
| GET | `/admin/clients/:id/onboarding` | onboarding state machine |
| PUT | `/admin/clients/:id/clickup-mapping` | `{ clickup_folder_id?, clickup_client_group? }` |
| GET | `/admin/clients/:id/projects` | discovered projects + visibility |
| POST | `/admin/clients/:id/projects/discover` | pull projects from ClickUp |
| PATCH | `/admin/clients/:id/projects/:listId` | `{ is_visible }` |

## Not for the frontend
`/internal/*` and `/webhooks/*` are service-role endpoints (cron / n8n / ClickUp),
guarded by a shared secret — never call them from the browser.

---

## CORS
The API allows origins from `CORS_ORIGINS` (server env). Ask the backend owner to
add your dev origin (e.g. `http://localhost:5173`) if requests are blocked.

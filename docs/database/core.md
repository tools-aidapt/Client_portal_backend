# The `core` schema — identity & tenancy, explained from scratch

This document explains every table in the `core` Postgres schema: what it's for, what
each column means, why it exists, and a worked example showing real data moving through
it. No prior database knowledge assumed.

**The one-sentence version**: `core` answers two questions for every request the backend
handles — *"who is this person?"* and *"which client account are they acting on behalf
of?"* Every other schema (`portal`, and in principle `lms`/`support`) assumes `core` has
already answered both.

**A note on foreign keys, since they come up constantly below**: a "foreign key" is just
a column that holds another table's id, enforced by Postgres so it can never point at a
row that doesn't exist. When you see `user_id → core.profiles(id)`, read it as "this
column must contain a real profile's id, or nothing (null), never a made-up value."
`ON DELETE CASCADE` means "if the row this points to gets deleted, delete this row too."
`ON DELETE SET NULL` means "if the row this points to gets deleted, just blank this
column out, but keep this row."

---

## Identity — who a person is

Four tables, deliberately split apart rather than one big "users" table, because they
have different sensitivity and lifecycles.

### `profiles` — the root identity record

Every other table's `user_id` ultimately points here. Think of it as "the person," full
stop — everything else (their password, their tenant memberships, their notifications)
is a satellite around this row.

| Column | Meaning | Why it's shaped this way |
|---|---|---|
| `id` (uuid) | The person's permanent identifier | Generated once at creation (`gen_random_uuid()`), never changes, referenced by 16 other tables |
| `full_name` | Display name | Shown in the topbar, Account page, Pod cards |
| `avatar_url` | Profile picture link | Points at a Supabase Storage `avatars` bucket file |
| `job_title`, `phone`, `department`, `interests[]` | Extra profile fields | Collected at registration, editable via `PATCH /auth/me` — `interests[]` is a genuine Postgres array type (a list of text values in one column), used nowhere in the UI yet but modeled for a future "recommend content based on interests" feature |
| `locale` | Language preference, default `'en'` | Modeled for future i18n; nothing reads it today |
| `is_platform_admin` | **The single flag that means "this person works at Aidapt, not at a client"** | Grants cross-tenant access without needing a membership row in every tenant — see the worked example below |
| `created_at` | Account creation timestamp | Standard audit field |

**Worked example**: When we created `m.rehman@aidapt.co` this session, we inserted one
`profiles` row with `full_name = 'M. Rehman'` and `is_platform_admin = true`. That single
boolean is *why* that account could later view both the Kenafric and Acme-Corp-shaped
data without needing a `memberships` row for either — platform admins bypass the
per-tenant membership check entirely (see `memberships` below).

### `user_credentials` — login secrets, kept separate on purpose

If `profiles` were ever exposed through a looser permission (a bug, a future public API),
you'd not want passwords sitting right there in the same row. So credentials live in
their own table with **RLS enabled and zero policies** — meaning literally nothing,
not even a logged-in user reading their own row, can query this table through the normal
API paths. Only the backend's direct Postgres connection (which bypasses RLS entirely)
can touch it.

| Column | Meaning | Why |
|---|---|---|
| `user_id` | Same id as the profile — this is *both* the primary key and a foreign key | A 1:1 relationship: one profile, one credential set. No separate `id` needed because there's never more than one row per person. |
| `email` | Login email | Unique **case-insensitively** — there's a unique index on `lower(email)`, not on `email` itself, so `Bob@Aidapt.co` and `bob@aidapt.co` can't become two different accounts |
| `password_hash` | Bcrypt hash | Never the plaintext password — bcrypt is a *one-way* function, there is no way to recover the password from this value, ever, by design |
| `email_verified` | Whether the email was confirmed | Column exists but nothing in the code sets it `true` yet — no verification-email flow has been built |
| `updated_at` | Bumped when the password changes | — |

**Worked example**: when you log in with a password, the backend runs `select
password_hash from core.user_credentials where lower(email) = lower($1)`, then calls
`bcrypt.compare(yourPassword, thatHash)`. If they match, you're in. Nobody — not an
admin, not a database export, not a leaked API key — can turn that hash back into your
actual password.

### `otp_codes` — the passwordless login we built this session

| Column | Meaning | Why |
|---|---|---|
| `user_id` | Who requested the code | — |
| `code_hash` | SHA-256 of the 6-digit code | Deliberately a *fast* hash, not bcrypt — bcrypt is slow on purpose to resist brute-forcing a stolen password hash, but a 6-digit code already has attempt-limiting (`attempts`) and a 10-minute expiry, so a fast hash is fine and doesn't slow down every login check |
| `expires_at` | TTL cutoff | 10 minutes after issue, by default |
| `consumed_at` | Null until used, then stamped | Makes replay impossible — once a code is consumed, `consumed_at` is set and it can never be accepted again even if the raw digits leak |
| `attempts` | Wrong-guess counter | Locks out after 5 wrong tries |
| `created_at` | Issue time | — |

**Worked example**: you request a code for `m.rehman@aidapt.co`. A row is inserted:
`code_hash = sha256("119302")`, `expires_at = now() + 10 minutes`. You type `119302` into
the app; the backend hashes what you typed and compares it to `code_hash`. Match →
`consumed_at` gets set to now, and you're issued a session. Type it wrong five times →
the `attempts` counter hits 5 and the code is dead even if the 6th guess would've been
right.

### `refresh_tokens` — the "stay logged in" half of a session

Every login issues **two** tokens: a short-lived *access token* (15 minutes, not stored
anywhere in the database — it's a signed JWT the server can verify without a DB lookup)
and a long-lived *refresh token* (30 days, stored here) used to silently get a new access
token when the old one expires.

| Column | Meaning | Why |
|---|---|---|
| `token_hash` | SHA-256 of the actual refresh token | The raw token is shown to the browser once and never stored in plaintext anywhere |
| `expires_at` | 30 days out | — |
| `revoked_at` | Null while live | Set on logout, **and** on every use — each refresh call revokes the old row and inserts a brand new one ("rotation"). This means a stolen refresh token only works *once* before it's dead; if the real user's next legitimate refresh gets rejected because the token's already revoked, that's a strong signal of theft. |
| `user_agent` | Which browser/device | Not shown anywhere in the UI yet, but there for a future "your active sessions" screen |

**Worked example**: you log in on your laptop. A refresh token is issued and its hash
stored. Fifteen minutes later your access token expires; the frontend automatically
calls `/auth/refresh` with the stored refresh token. The backend checks the hash matches
a live (`revoked_at is null`), unexpired row — it does — so it revokes that row and
issues you a fresh pair. This happens silently in the background the whole time you use
the app; you never notice your access token expiring.

---

## Tenancy — who belongs to which client, and how they got there

### `tenants` — one row per client company

| Column | Meaning | Why |
|---|---|---|
| `name`, `slug` | Display name and URL-safe id | `slug` is unique but not actually used in any route yet |
| `status` | Where the client sits in the sales/delivery lifecycle | An enum — `prospect` is the default |
| `clickup_folder_id` | The ClickUp Delivery-space folder for this client | Routes an entire folder's worth of tasks to this tenant during sync — **this is exactly what broke earlier this session**, when a placeholder "Acme Corp" tenant had the *same* folder id as the real Kenafric tenant, and every synced task landed on the wrong one |
| `clickup_client_group` | The "Client Group" ClickUp dropdown option text for this client | Routes tasks from *shared, cross-client* ClickUp lists (Sprint tasks, Wishlist submissions, Process List submissions) — this must match ClickUp's dropdown text **exactly** (we found `'KEN'` stored here when the real ClickUp value was `"Kenafric Group"`, silently breaking every Client-Group-routed sync until fixed) |
| `product_tier` | Free text, e.g. which pricing tier | No enum — nothing enforces valid values |

**Worked example**: Kenafric's row has `clickup_folder_id = '901211216162'` (the `KEN`
folder in ClickUp's Delivery space) and `clickup_client_group = 'Kenafric Group'`. When
the hourly sync walks that folder, every list inside it (Onboarding, OPS - Custom WATI,
etc.) gets attributed to this tenant *by folder*. But when the sync walks the *shared*
"ORG - Client - Wishlist" list — which mixes every client's submissions together in one
list — it instead reads each task's "Client Group" field and looks up which tenant has
that exact string in `clickup_client_group`.

### `memberships` — the actual "person X belongs to tenant Y as role Z" record

| Column | Meaning | Why |
|---|---|---|
| `user_id`, `tenant_id` | The pairing | Unique together — you can't have two membership rows for the same person in the same tenant |
| `role` | `member` < `member_plus` < `member_pro` < `org_admin` | **Per-tenant, not global** — you could be `member` on one client's account and `member_pro` on another's |
| `status` | Active/inactive | Lets access be revoked without deleting the history of the membership ever existing |
| `invited_by` | Which profile granted this | Audit trail |
| `joined_at` | When | — |

**Worked example, and why this table caused today's confusion**: a person can have
*zero, one, or many* rows here. `is_platform_admin=true` people often have **zero** —
they don't need a membership to act as `super_admin` on any tenant. A client user
normally has **exactly one**. When `m.rehman@aidapt.co` had memberships in *both*
Kenafric and Acme Corp, the backend couldn't infer which one to show on the dashboard
without being told explicitly (`x-tenant-id` header) — that's the "specify tenant_id
(multiple memberships)" error from earlier, and it's the same code path that also fires
for a platform admin with *zero* memberships (the check is really "is this exactly one,
unambiguous answer?", not literally "is this more than one").

### `invitations` — the only way a new account gets created

There is no open sign-up page. Every account starts life as a row here.

| Column | Meaning | Why |
|---|---|---|
| `token` | A random hex string | Generated by Postgres itself at insert time (`gen_random_bytes(24)`) — this is the value embedded in the invite email's link |
| `role` | The role the invitee *will* get | Decided by whoever sends the invite, not the invitee |
| `status` | pending / accepted / revoked / expired | — |
| `expires_at` | 14 days from creation, by default | — |
| `invited_by` | Who sent it | — |

**Worked example**: an admin invites `newuser@kenafric.com` as `member_plus` to the
Kenafric tenant. A row is inserted with a random `token`, an email is sent (via the n8n
webhook) containing `.../register?token=<that token>`. When they click it and set a
password, `POST /auth/register` looks up that token, confirms it's still `pending` and
unexpired, creates their `profiles` + `user_credentials` rows, and inserts a `memberships`
row using the email/tenant/role **from the invitation**, not from anything the user
typed — so nobody can register themselves into an org they weren't invited to.

### `tenant_email_domains` — auto-join by company email

| Column | Meaning | Why |
|---|---|---|
| `domain` | e.g. `kenafric.com` | Globally unique — one domain can't belong to two tenants |
| `default_role` | What role auto-joiners get | `member_plus` by default |
| `auto_join` | Kill switch | Lets this be disabled per-domain without deleting the row |

This table does double duty: it's also what the Dashboard's "Team training" (LMS) tile
joins against, to figure out which LMS client-group corresponds to a given Portal
tenant — a cross-app identity bridge riding on what's otherwise an auth convenience
feature.

---

## Cross-cutting tables

### `notifications` — the bell icon feed

| Column | Meaning | Why |
|---|---|---|
| `type` | An enum: `report_published`, `voting_opened`, `task_status_changed`, `automation_error`, etc. | Controls what copy/icon/link the frontend renders |
| `title`, `body`, `link_url` | Display content | — |
| `is_read` | The only field a user can mutate | Via `POST /notifications/:id/read` |

Worth calling out: this is one of the only tables where **Postgres itself** enforces
"you can only see your own rows" (`user_id = auth.uid()`), rather than the backend
trusting its own SQL `where user_id = ...` filter. Notifications are personal enough that
the extra belt-and-braces felt worth it.

### `audit_log` — who did what

| Column | Meaning | Why |
|---|---|---|
| `actor_id` | Who did it | `ON DELETE SET NULL` — if that person's account is later deleted, the audit record survives with a blank actor rather than vanishing. You don't want to lose the fact that *something* happened just because the person who did it left. |
| `action`, `target` | Free text describing what happened | e.g. `'invitation.accepted'` |
| `metadata` | jsonb grab-bag | Action-specific detail, e.g. `{invitation_id, role}` |

Nothing in the frontend reads this today — it's write-only from the app's perspective,
sitting there for future admin tooling.

### `documents` — tenant-level file attachments

| Column | Meaning | Why |
|---|---|---|
| `storage_path` **or** `external_url` | Where the file lives | A check constraint requires **at least one** to be set — a document pointing at nothing would be useless |
| `doc_type` | Free text category | No enum |

Schema exists; nothing uploads or lists these yet.

---

## Client onboarding workflow (admin-side setup)

### `client_onboarding` + `onboarding_steps` + `outbox`

These three work together to run a client's initial setup as a tracked, retryable
process — not literally the "map a process" feature clients see (that one's the
`ORG - Client - Process List` ClickUp sync, documented in `portal.md`), but Aidapt's
*internal* checklist for standing up a new client account.

**`client_onboarding`** — one row per tenant (unique on `tenant_id`), the overall state
machine: `state` (pending/in-progress/complete), `started_by`, `started_at`,
`completed_at`.

**`onboarding_steps`** — the individual checklist items inside one run: `step_key` (a
stable id like `"clickup_folder_created"`), `sequence` (order), `status`, `attempts`
(retry counter, since automated steps can fail transiently), `detail` (jsonb).

**`outbox`** — the async job queue that actually executes some of those steps (and
anything else needing reliable "do this eventually, retry if it fails" behavior):
`aggregate`/`aggregate_id` (which entity this job is about), `event_type` (e.g.
`clickup.provision_folder`), `idempotency_key` (unique, so the same event can't be
processed twice even if enqueued twice), `next_attempt_at`/`attempts`/`last_error`
(standard retry-with-backoff bookkeeping).

**Honest caveat**, straight from the backend's own build notes: several of these
handlers (`clickup.provision_folder`, `n8n.trigger_sync`, `storage.init`) are currently
**stub implementations that only log** — the queue and retry machinery are real and
wired up, but the actual actions those job types are supposed to perform haven't been
built yet.

---

## Putting it together: a full scenario

**Someone at Kenafric gets invited, joins, and logs in a week later.**

1. An Aidapt admin calls `POST /admin/clients/:id/invitations` for `sarah@kenafric.com`,
   role `member_plus`. → one row in **`invitations`**, `status='pending'`, a random
   `token`, `expires_at` 14 days out.
2. An outbox job (or direct n8n call) sends the invite email with a link containing that
   token.
3. Sarah clicks it, sets a password. → one row in **`profiles`** (her identity), one row
   in **`user_credentials`** (her hashed password), one row in **`memberships`**
   (`user_id` = her profile, `tenant_id` = Kenafric, `role='member_plus'`), and the
   **`invitations`** row flips to `status='accepted'`.
4. A week later she logs in with her password. The backend checks **`user_credentials`**,
   issues an access token whose claims include her Kenafric membership (read fresh from
   **`memberships`** at login time), and a **`refresh_tokens`** row for her session.
5. Because she has exactly one row in **`memberships`**, the backend infers "Kenafric"
   automatically on every request — no `x-tenant-id` header needed. If she were later
   also invited into a second tenant, she'd start needing one, exactly like we saw with
   `m.rehman@aidapt.co` this session.

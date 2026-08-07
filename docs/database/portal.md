# The `portal` schema — Client Portal's own data, explained from scratch

This picks up where `core.md` leaves off. Everything here assumes `core` has already
answered "who is this person, and which tenant are they acting as" — every table below
is scoped by `tenant_id`, and almost everything in it either comes **from ClickUp**
(synced in on a schedule) or **from the client themselves** (submitted through the Portal
app).

**The one-sentence version**: `portal` is a *cache and a feature-store* — a cache of
ClickUp data reshaped for fast, tenant-scoped reads (`task_cache`, `sprints`, the
mapping/status tables), plus a handful of features that are portal-native and have
nothing to do with ClickUp at all (wishlist voting, sprint pulse ratings).

---

## The ClickUp sync machinery

This is the biggest and most important group — five tables that exist purely to make
ClickUp data fast and safe to read from the client-facing app, without the app ever
calling ClickUp's API directly (which would be slow, rate-limited, and would leak
Aidapt-internal ClickUp structure straight into client-facing responses).

### `task_cache` — the mirrored copy of every relevant ClickUp task

This is the single biggest table and the one almost everything else reads from.

| Column | Meaning | Why |
|---|---|---|
| `clickup_task_id` | The real ClickUp task's id | **Globally unique** — this is what makes re-running a sync safe: the same task always upserts the same row instead of creating a duplicate |
| `tenant_id` | Which client this task belongs to | Decided at sync time by the routing logic (folder-based or Client-Group-based — see the worked example) |
| `source` | `'delivery'` or `'sprint'` | `delivery` = came from a client's own Delivery-space lists (their per-project lists); `sprint` = came from the shared Sprint-space lists, routed per-task by Client Group |
| `sprint_id` | Which sprint this task belongs to, if any | Only set for `source='sprint'` tasks — a `delivery` task is never tied to a specific sprint in this schema |
| `clickup_list_id`, `list_name` | Which ClickUp list it lives in | This is what "Projects" groups by — one list = one project card |
| `name`, `status_raw` | The task's title and its raw ClickUp status string | `status_raw` is whatever text ClickUp shows (e.g. `"backlog"`, `"live"`) — not yet translated into anything client-facing |
| `bucket` | `delivered` / `in_progress` / `upcoming` | The **translated**, client-facing version of `status_raw`, looked up per-tenant in `clickup_status_map` (below) |
| `rag` | `green`/`amber`/`red` | Read straight off a ClickUp custom field of the same name — a health indicator per task |
| `progress_pct` | A percentage | Stored as `numeric(5,2)` — comes back from the database as a **string**, not a number, which the frontend has to `parseFloat()` |
| `type_of_work` | A free-text category off a ClickUp dropdown | — |
| `client_visible` | **The single flag that decides if a client can see this task at all** | For `delivery` tasks, this is overridden at sync time by the *project's* admin-set visibility flag (from `clickup_list_mappings`), not the task's own ClickUp checkbox. For everything else (sprint tasks, onboarding requests), it comes straight from the task's own "Client Visible" ClickUp field — except we found that field is never actually set for onboarding requests, so that sync path forces it `true` instead of hiding everything by default. That forcing is load-bearing for the onboarding read, which filters on this flag: the Process List is **shared across all clients**, so a row cached against the wrong tenant is another client's name, and only the Client-Group-routed onboarding sync sets the flag. Kenafric had 16 rows tagged to it where 5 are genuinely theirs. |
| `assignee_names` | A Postgres array of names/emails | — |
| `start_date`, `due_date` | Plain `date` columns | — |
| `closed_at` | When the task was closed in ClickUp | — |
| `url` | Direct link back to the ClickUp task | Used for "View in ClickUp" links |
| `source_wishlist_item_id` | The `wishlist_items` row this task came out of, if any | **Nullable, and set only by a deliberate admin action** (migration `0024`) — the one column in this table that no sync ever writes. See "Closing the wishlist loop" below |
| `synced_at` | Last sync timestamp | Bumped on every upsert |

**Worked example — why 441 tasks first landed on the wrong tenant**: the sync walks
ClickUp's Delivery space folder by folder. For each folder, it looks up
`core.tenants.clickup_folder_id` to find *which tenant owns this folder*. When both the
real Kenafric tenant **and** a leftover placeholder "Acme Corp" tenant had the identical
`clickup_folder_id` value, the lookup returned two matches, and the sync silently picked
one (Acme Corp) — so all 441 tasks landed there instead of Kenafric, even though the sync
itself ran with zero errors. Deleting the placeholder tenant and re-running the sync
fixed it in one pass, because `task_cache` is upserted by `clickup_task_id` — re-syncing
doesn't create duplicates, it corrects the existing rows.

### `sprints` — sprint date ranges, nothing else

| Column | Meaning | Why |
|---|---|---|
| `clickup_list_id` | The ClickUp list representing this sprint (e.g. "Sprint 6 (7/27 - 8/9)") | Unique — one list, one sprint |
| `sprint_number` | Parsed out of the list name via a regex (`/sprint\s+(\d+)/i`) | Purely for display ordering |
| `starts_on`, `ends_on` | The date range | Pulled from the ClickUp list's own start/due date |
| `is_active` | Whether *today* falls inside `[starts_on, ends_on]` | **Recomputed on every sync**, not something anyone sets manually — this is a pure function of the date range and the current date |

**Worked example**: this table only gets populated by a separate sync
(`/internal/sync/sprints`) that walks the ClickUp "Sprint" folder specifically —
`/internal/sync/all` (the main task sync) never touches this table at all. That's why,
this session, running the main sync first left the Dashboard showing "No active sprint"
even though real sprints existed in ClickUp — the sprint *metadata* sync hadn't run yet.
Once it did, six rows appeared, and `is_active` was `true` on exactly the one whose date
range contained today (Aug 6 → Sprint 6, 7/27–8/9).

### `clickup_list_mappings` — the "projects registry," and the admin curation point

| Column | Meaning | Why |
|---|---|---|
| `tenant_id` + `clickup_list_id` | Unique together | One tenant can map the same physical list only once — but the *same shared list* (like the Process List) can have a separate mapping row per tenant, since routing for shared lists happens per-task, not per-list |
| `purpose` | Free text: `'project'`, or `'onboarding'` (what we added this session) | No enum — just a string the read-queries filter on |
| `display_label` | Human-readable name shown on the Projects page | Refreshed from the ClickUp list's name on every sync |
| `is_active` | Whether this mapping is still live | — |
| `client_visible` | **The actual admin-controlled curation flag** | This is what an admin flips via `PATCH /admin/clients/:id/projects/:listId` to decide "should this project show up for the client at all" — distinct from `task_cache.client_visible`, which is the *per-task* flag that inherits from this one for delivery tasks |

**Worked example**: Kenafric has 9 rows here — one per list in their ClickUp `KEN`
folder (Onboarding, Offboarding, INTL - Snowflake Project, four `OPS -` automation
lists, and their own `KEN - Wishlist` list, which is really just a manual duplicate of
the shared wishlist — see `wishlist_items` below). All 9 started `client_visible=false`
by default (a deliberate "hidden until an admin reviews it" default) — we flipped all
9 to `true` this session to see the dashboard fully populated for testing.

### `clickup_status_map` — translating ClickUp's messy status names into 3 buckets

| Column | Meaning | Why |
|---|---|---|
| `tenant_id` | Nullable — a `null` row is a **global default** | Every client's ClickUp setup uses different status names (`"to do"` vs `"backlog"` vs `"open"`), so this table lets a tenant override the global default for a specific raw status without needing every tenant to redefine the whole map |
| `raw_status` | The exact ClickUp status text, lowercased | e.g. `"in progress"`, `"live"` |
| `bucket` | Which of the 3 client-facing buckets it maps to | `delivered` / `in_progress` / `upcoming` |
| `sort_order` | Display ordering | Not currently used by any query |

**Worked example**: when we synced the shared Process List, one task had status
`"live"` — a status that existed in neither the global map nor Kenafric's — so it came
through with `bucket = null` and silently didn't appear in *any* of the three Onboarding
page groups. Adding one row (`tenant_id=null, raw_status='live', bucket='delivered'`)
fixed it globally, for every tenant, since it's a global-default row.

### `sync_runs` — a log, nothing reads it for display

One row per sync job execution: `entity` (e.g. `'spaces'`, `'sprints'`, `'wishlist'`,
`'onboarding'`), `tenant_id` (null for whole-workspace syncs), `status`
(`success`/`partial`/`error`), `records_upserted`, `error_detail`. Purely observability —
useful for debugging ("did the wishlist sync actually run, and how many items did it
touch?") but nothing in the frontend reads it.

---

## Wishlist & voting — the one genuinely portal-native feature

Unlike everything above, this feature has **two separate data sources feeding the same
table**, and it's worth being precise about which is which.

### `wishlist_items` — client feature requests

| Column | Meaning | Why |
|---|---|---|
| `clickup_task_id` | **Nullable, uniquely indexed only when not null** | This is the key design detail: a row can come from *either* a direct in-app submission (`clickup_task_id` stays null, `submitted_by` is set) *or* a ClickUp sync (`clickup_task_id` set, `submitted_by` null) — the partial unique index means only the ClickUp-sourced rows are protected from duplication, since native submissions never collide by definition |
| `title`, `description` | The request itself | For synced items, only `title` is populated today — the ClickUp tasks' descriptions are long, inconsistently-templated markdown forms, and reliably parsing structured fields out of them wasn't worth the fragility this session, so `description` stays null for synced rows |
| `state` | `candidate` / `prioritised` / `in_progress` / `shipped` | Always starts `candidate`; moves to `prioritised` when a monthly voting cycle closes and picks a winner |
| `submitted_by` | Which profile submitted it, for native submissions | Null for ClickUp-synced items — there's no portal user "submitter" for something that came from a form outside the app |
| `reference_video_url`, `department` | Extra context fields | Only usable for native submissions right now |
| `problem`, `who_feels_pain`, `urgency`, `submitter_notes` | The request itself, parsed out of the ClickUp intake form | Migration `0027`. All nullable — the form's own placeholders (`—`, `None`) are normalised to null so the UI shows nothing rather than "None" |
| `submitter_name`, `submitter_role`, `submitter_company`, `submitted_at` | Who filed it | From the form's machine-generated `\| Field \| Value \|` table, which is the one reliably-shaped block in the whole body |
| `body_md` | The leftover form body, as markdown | The fallback for what the parser did NOT understand. Everything with a column of its own is stripped (Problem, Notes, the Submitter table, Urgency, Who feels the pain, the request title), as are placeholder-only answers and retired taxonomy — so it can't duplicate a section the UI already renders, and can't show a client "None"/"—". Null on 2 of the 3 live rows; the third holds only the optional "Year-review priorities" block |
| `synced_at` | Last sync timestamp | This table's first freshness column. Makes a future "retire rows deleted in ClickUp" sweep possible; that sweep is deliberately NOT built (see below) |

**The submitter's email is deliberately not stored.** The sync uses it in memory only,
to resolve `submitted_by` against profiles that are members of *that* tenant — the
intake form is public, so the address it captures is untrusted input and matching it
against `core.profiles` alone would let a submission be attributed to another
client's user. When nothing matches, `submitter_name` carries the display string and
no new personal data lands in the table.

**There is no `capability` column, on purpose.** The form's `**OS Pillar:**` /
`**Capability:**` line holds `ProductivityOS`, `DataOS` and
`Needs assignment (submitter chose "Not sure")`. Collapsing those into
Operations/Intelligence/Enablement would be inventing a mapping — the same call
`0022` made for case studies — so the parser strips the line entirely.

**No retire sweep.** `wishlist_votes.item_id` and `voting_cycles.winning_item_id`
reference these rows, and a sweep keyed on `synced_at < run_start` would retire the
whole board the first time a ClickUp page fetch failed mid-run. Rows deleted in
ClickUp therefore persist. Documented rather than papered over.

**Live parse coverage** (3 Kenafric rows, 2026-08-07): `submitter_name`/`submitted_at`
3/3, `problem` 2/3, `who_feels_pain` 2/3, `urgency` 1/3. The gaps are correct, not
failures — "Kenafric - Website" was submitted with the literal word `None` in every
free-text answer, and two others left Urgency as `—`. Across all 14 tasks on the
shared list: `problem` 13/14, submitter block 14/14, and **zero** rows carrying
retired taxonomy in any column.

**Worked example, and a real gotcha we hit**: the *canonical* source is one shared
ClickUp list, `"ORG - Client - Wishlist,"` which every client's form submissions land in
together, tagged by a "Client Group" field — same routing mechanism as sprint tasks.
There's *also* a per-client mirror list (Kenafric's own `"KEN - Wishlist"`) that turned
out to be a manual copy someone made, with the *same task names but different ClickUp
task ids* — meaning if we'd synced both, Kenafric's 3 wishlist items would have appeared
as 6 duplicates. We chose to sync only the shared list and ignore the per-client mirrors
entirely.

### `wishlist_votes` — one vote, one person, one item, one cycle

| Column | Meaning | Why |
|---|---|---|
| `cycle_id`, `item_id`, `user_id` | Unique together | Enforces "one vote per person per item per monthly cycle" at the database level — not just in application code |

**This constraint is the entire vote model**, and it is deliberately all of it:
unlimited items per user per cycle, **no vote budget and no vote weighting** — no
column exists for either, and adding one would change the meaning of every
historical row here. Un-voting is a plain row delete (`DELETE /wishlist/:id/vote`),
which is why supporting it needed no migration; it requires an OPEN cycle, since
retracting a vote from a closed cycle would rewrite a result already acted on.

### `voting_cycles` — the monthly window that gates voting

| Column | Meaning | Why |
|---|---|---|
| `tenant_id` + `period_month` | Unique together | One cycle per tenant per calendar month |
| `opens_at`, `closes_at` | The voting window | — |
| `is_open` | Whether voting is currently accepted | Checked by the vote-casting logic — no open cycle means votes are rejected |
| `winning_item_id` | Set when the cycle closes | Points back into `wishlist_items`, and that item's `state` flips to `prioritised` — this is what the Wishlist page's "This month's winner" card is showing |

**Verified behaviour of the close (`POST /internal/voting/close-cycle`, `voting.service.ts`)**:
the winner is `count(votes) desc, wishlist_items.created_at asc` — most votes wins, and a
tie goes to whichever item was submitted first. Both branches were checked against the live
Kenafric cycle inside a rolled-back transaction (2026-08-06): with 2 votes vs 1 the
higher-voted item won even though it was created *later*; with 1 vs 1 the earlier-created
one won. The close then sets `is_open = false` + `winning_item_id`, flips the winner to
`prioritised`, notifies `member_plus`+, and opens the next cycle. **A cycle with
zero votes closes with `winning_item_id = null` and prioritises nothing.**

Three things changed on 2026-08-07:

- **`closeCycle(cycleId)` is split out from `closeDueCycles()`.** The latter is
  GLOBAL — it closes due cycles for every tenant — so anything that should touch one
  client (the admin endpoints, a smoke test) calls the former. Worth remembering
  before curling `/internal/voting/close-cycle` at production.
- **The next cycle's month is `greatest(closed month + 1, current month)`.** It used
  to derive purely from the closing cycle, so a job run months late advanced only ONE
  month per invocation and immediately created another already-due cycle. A catch-up
  now lands on today's month in a single pass — verified: closing Kenafric's `2026-07`
  cycle on 2026-08-07 opened `2026-08` directly.
- **Notifications name the winner** and set `link_url`, and `voting_opened` /
  `item_prioritised` are now actually emitted (both were defined in the enum since
  `0002` and never used). Audience is `member_plus`+ rather than every active member:
  a plain `member` can read the board but not vote, so telling them "results are in"
  invited an action they don't have.

**Kenafric's dead cycle was closed deliberately, and silently.** Their `2026-07` cycle
expired (`closes_at 2026-08-01`) with zero votes while nothing scheduled the close. It
was closed on 2026-08-07 with `notify: false` so their staff's first-ever wishlist
notification wouldn't be "No votes were cast this cycle"; `2026-08` (closing
`2026-09-01`) opened in the same pass, nothing was prioritised, and zero notifications
were written. That is what the `notify` flag exists for.

**At most one cycle may be open per tenant** — `voting_cycles_one_open_per_tenant`,
a partial unique index added in `0027`. Three paths open cycles (onboarding step 8,
the close's reopen, the admin endpoint) and nothing stopped two coexisting, which made
`order by period_month desc limit 1` arbitrary and could have landed two users' votes
on the same board in different cycles. The reopen insert carries a
`where not exists (… is_open)` guard so a manually-opened future cycle can't turn that
index into a constraint violation that aborts the whole month-end job.

### Closing the wishlist loop — `task_cache.source_wishlist_item_id`

The product intent is a chain: **client votes → item wins the cycle → item becomes a real
Process Onboarding submission the Pod scopes**. The first two links were already in the
schema; the third was not, so nothing could tell a client "the thing you voted for is now
*this* work item." `task_cache.source_wishlist_item_id` (migration `0024`) is that link.

**It is populated by a human, on purpose, and never inferred.** There is no reliable way to
match a ClickUp task to a wishlist item automatically: the Pod rewrites the title when they
scope it, one request can turn into several tasks, and a task on the shared Process List
carries nothing pointing back at a portal-native uuid. Guessing here would attach a claim
about a client's own request to the wrong row, which is worse than showing nothing.

The flow in practice:

1. A cycle closes; the winning item goes `prioritised` (`voting_cycles.winning_item_id`).
2. The Pod scopes it and an admin creates the task on the shared
   `"ORG - Client - Process List"` in ClickUp, as they would for any onboarding request.
3. The sync picks that task up into `task_cache` (routed by Client Group) with
   `source_wishlist_item_id` still null.
4. The admin states the link once:
   `PATCH /admin/clients/:id/tasks/:clickupTaskId/wishlist-source` with
   `{ "wishlist_item_id": "<uuid>" }`. `GET /admin/clients/:id/wishlist-items` lists the
   tenant's items with the task each is already linked to, so it's easy to see which
   prioritised items still need one. Sending `{ "wishlist_item_id": null }` unlinks.
5. `GET /onboarding` then returns `source_wishlist_item_id` **and**
   `source_wishlist_title` on that task, and the Portal shows "Originated from your
   Wishlist: …".

Three properties worth knowing:

- **The link survives re-syncs.** `syncRepo.upsertTask` names its columns explicitly and
  `source_wishlist_item_id` isn't among them, so the hourly sync can't clobber an
  admin's decision.
- **Both sides are checked against the same tenant** before the write. The FK only proves
  the wishlist item exists *somewhere*; without the tenant check an admin could staple one
  client's wishlist item onto another client's task, and its title would surface on the
  wrong Portal. The read query joins tenant-scoped too, belt and braces.
- **`ON DELETE SET NULL`**, so deleting a wishlist item doesn't delete cached delivery
  rows — the task just loses its stated origin.

A future admin UI can drive step 4 from a dropdown; nothing else needs to change for it.

---

## Reports & feedback

### `reports` — sprint reports, draft → published → archived

| Column | Meaning | Why |
|---|---|---|
| `sprint_id` | Which sprint this reports on | Nullable — a report doesn't strictly have to tie to a tracked sprint |
| `summary_md` | The report body, **raw markdown** | Not pre-rendered to HTML anywhere — the frontend currently just displays it as plain text, since no markdown renderer is wired up yet |
| `committed_count`, `delivered_count` | The headline numbers | "Rolled" (shown on the Reports page) isn't stored at all — it's calculated on the fly as `committed - delivered` |
| `status` | `draft` / `published` / `archived` | Clients only ever see `published` or `archived` — `draft` reports are invisible to them, enforced by the read query's `where` clause, not just the RLS policy |
| `published_at`, `published_by` | When and by whom | — |

### `sprint_pulse` — a client's 1-5 rating on one published report

| Column | Meaning | Why |
|---|---|---|
| `report_id`, `user_id` | Unique together | One rating per person per report — resubmitting updates the same row (an "upsert") rather than creating a second one |
| `score` | 1 to 5 | Enforced by a check constraint at the database level, not just frontend validation |
| `comment` | Optional free text | — |

**A subtlety worth knowing**: resubmitting a pulse rating updates `score`/`comment` but
the `created_at` on the row stays as the *original* submission time — the upsert's
`update` clause only touches score and comment, so this column is not a reliable
"last updated" timestamp.

---

## Pod & automation visibility

### `pod_members` — the Aidapt team shown to a client

| Column | Meaning | Why |
|---|---|---|
| `display_name`, `role_label` | What's shown on the Pod page | `role_label` is free text (`"Pod Lead"`, `"AI Engineer"`) — not an enum |
| `is_active` | Whether this person still shows for this tenant | The `/pod` endpoint filters to `is_active=true` only |
| `sort_order` | Display order | — |

**Worked example**: when Kenafric was first onboarded, three placeholder rows were
created automatically — `display_name = "To be assigned"`, `is_active = false` for each
of Pod Lead / AI Engineer / AI Implementation. That's *correct*, expected behavior for a
freshly-onboarded, not-yet-staffed client: the Pod page showing nothing isn't a bug,
it's the system accurately reporting "nobody's been assigned yet."

### `automation_workflows` + `automation_health` — n8n workflow registry and live status

**`automation_workflows`** — one row per n8n workflow an admin has registered for a
client (`n8n_workflow_id`, `name`, `description`, `is_client_visible` — a separate
curation flag from everything above, `is_active`).

**`automation_health`** — a **1:1 extension table**, keyed by `workflow_id` (its primary
key is a foreign key, not its own generated id — meaning there's never more than one
health row per workflow). Tracks `state` (`active`/`idle`/`error`/`disabled`),
`last_execution_at`/`last_execution_status`, `executions_this_month`/`errors_this_month`,
`avg_runtime_ms` (a running average, recomputed on each execution report), `captured_at`.

Updated by an n8n webhook (`POST /webhooks/n8n/execution`) every time a registered
workflow runs — this is the one table in the whole schema that's kept live by push
events rather than a scheduled pull sync.

### `sigma_embeds` — embedded BI dashboard references

One row per embedded Sigma workbook: `embed_name`, `sigma_workbook_id`, `embed_type`
(defaults `'roi'`), `is_active`. Nothing in the current frontend renders these yet —
schema exists ahead of the feature.

---

## Putting it together: today's full sync scenario

**How Kenafric went from an empty dashboard to real data in one session.**

1. Fixed `core.tenants.clickup_client_group` (`'KEN'` → `'Kenafric Group'`) — every
   Client-Group-routed sync depends on this string matching ClickUp exactly.
2. Deleted the placeholder "Acme Corp" tenant, which shared Kenafric's
   `clickup_folder_id` and had silently absorbed all 441 delivery tasks on the first
   sync attempt.
3. Ran `/internal/sync/all` → walked the Delivery + Sprint ClickUp spaces, upserted 441
   rows into **`task_cache`**, correctly attributed to Kenafric this time.
4. Ran `/internal/sync/sprints` → populated **`sprints`** with 6 rows, correctly flagged
   Sprint 6 as `is_active` based on today's date.
5. Flipped all 9 of Kenafric's **`clickup_list_mappings`** rows to `client_visible=true`
   (and their corresponding `task_cache` rows to match) — the admin curation step that
   decides what actually renders.
6. Built and ran a new sync for the shared `"ORG - Client - Wishlist"` list → 3 rows into
   **`wishlist_items`**, routed by Client Group.
7. Built and ran a new sync for the shared `"ORG - Client - Process List"` → 5 rows into
   **`task_cache`** tagged via a new **`clickup_list_mappings`** row with
   `purpose='onboarding'` — reusing the exact same table, just a different `purpose`
   value and a different routing rule (per-task Client Group, not per-folder).
8. Along the way, added one row to **`clickup_status_map`** (`'live' → 'delivered'`,
   global default) because that raw status didn't exist in either the global or
   Kenafric-specific map, and would otherwise have silently disappeared from every
   bucket.

Nine tables touched, zero new tables created — everything needed already existed in the
schema; the work was entirely about **getting the routing and curation flags right**,
not designing new structure.

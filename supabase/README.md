# Database — Aidapt Portal (shared Supabase project)

One Postgres database, four schemas: `core` (shared identity/tenancy), `portal`,
`lms`, `support`. This repo owns the **full shared migration set** even though
LMS and Support are separate backends, because all tables live in one database
and reference `core`.

## Migration order

Apply in filename order — later files depend on earlier ones:

| File | Contents |
|------|----------|
| `0001_extensions_schemas_grants.sql` | `pgcrypto`, the four schemas, role grants + default privileges |
| `0002_enums.sql` | All enumerated types |
| `0003_core_tables.sql` | Identity, tenancy, documents, notifications, audit |
| `0004_core_onboarding_outbox.sql` | Onboarding state machine + transactional outbox |
| `0005_portal_tables.sql` | Delivery cache, wishlist, reports, pulse, pod, sigma, automation |
| `0006_lms_tables.sql` | LMS tables (owned by LMS team; here for the shared DB) |
| `0007_support_tables.sql` | Support tables (owned by Support team; here for the shared DB) |
| `0008_functions_triggers.sql` | `updated_at`, new-user profile trigger, RLS helpers, **auth hook** |
| `0009_rls_policies.sql` | RLS enabled + policies on every tenant-scoped table |
| `0010_storage.sql` | Private `tenant-files` bucket + tenant-prefixed access policy |
| `0011_seed_defaults.sql` | Global ClickUp status→bucket map |

```bash
# With the Supabase CLI (recommended):
supabase db push

# Or paste each file, in order, into the SQL editor.
```

## Two manual steps SQL cannot do

1. **Expose the custom schemas to the API.** Dashboard → Project Settings → API →
   *Exposed schemas*: add `core` and `portal` (so `supabase-js` can reach them).
   `lms` / `support` are exposed in their own projects' app configs as needed.

2. **Enable the custom access token hook.** Dashboard → Authentication → Hooks →
   *Custom Access Token* → select `core.custom_access_token_hook`.
   Until this is enabled, JWTs carry no `tenant_roles` / `platform_admin` claims
   and every RLS check denies access.

## Access model (recap)

- Browser holds only the **anon key** → acts as `authenticated` → fully bound by RLS.
- Background writers (n8n, cron, edge functions, the onboarding worker) use the
  **service role** key → bypass RLS by design. Never ship it to the browser.
- Authorization reads JWT claims first (`core.tenant_role`, `core.is_member`,
  `core.is_platform_admin`); RLS enforces the same again at the row level.
- Claims are stamped at token issue, so role/membership changes take effect on the
  next refresh — the role-change endpoint revokes sessions to force it immediately.

## Notes for the build

- All functions pin `search_path` and fully-qualify names, so behaviour never
  depends on the connection's `search_path`.
- `core.custom_access_token_hook` runs as `supabase_auth_admin`; `0008` grants it
  read on `core.memberships` / `core.profiles` and `0009` adds the matching RLS
  policies. Don't remove those.
- The seed in `0011` uses `tenant_id = null` (global). Re-running inserts
  duplicates (NULLs don't conflict) — it's a one-shot migration, not idempotent.

# Architecture

## Layered, feature-modular design

The codebase separates **cross-cutting infrastructure** from **feature modules**.
Each feature owns its full vertical slice and depends inward only.

```
HTTP request
   │
   ▼
routes ──▶ middlewares (auth, validate) ──▶ controller ──▶ service ──▶ repository ──▶ Supabase
   ▲                                             │             │
   └───────────────── response envelope ◀────────┘   (business rules)  (data access only)
```

### Layer responsibilities

| Layer          | Responsibility                                           | Knows about HTTP? | Knows about DB? |
| -------------- | -------------------------------------------------------- | ----------------- | --------------- |
| **routes**     | URL → handler wiring, attach middlewares                 | Yes               | No              |
| **controller** | Read validated input, call service, shape response       | Yes               | No              |
| **service**    | Business logic, orchestration, invariants                | No                | No              |
| **repository** | All persistence (Supabase queries)                       | No                | Yes             |
| **validators** | Zod schemas for body/query/params                        | No                | No              |
| **types**      | Domain types for the module                              | No                | No              |

Dependencies flow **inward** (routes → controller → service → repository).
Lower layers never import higher layers.

## Directory map

```
src/
├─ config/          # Validated env + typed config (single source of truth)
├─ loaders/         # App/server bootstrap (Express wiring)
├─ api/
│  ├─ routes/       # Root router mounting every module
│  └─ middlewares/  # HTTP-level middlewares (auth, validate, error handler)
├─ modules/         # Feature modules — each a full vertical slice
│  └─ <feature>/
│     ├─ controllers/  services/  repositories/
│     ├─ validators/   routes/     types/
├─ common/          # Shared, framework-agnostic building blocks
│  ├─ errors/       # AppError hierarchy
│  ├─ utils/        # asyncHandler, api-response envelope, ...
│  ├─ constants/    types/  middlewares/
├─ infra/           # External-system adapters
│  ├─ supabase/     # Admin + user-scoped clients
│  ├─ logger/       # Pino logger
│  └─ cache/
├─ jobs/            # Background / scheduled tasks
└─ events/          # Domain event handlers / pub-sub
```

## Adding a new feature module

1. Copy the shape of `src/modules/clients/`.
2. Define `types/` and `validators/` first.
3. Implement `repository` → `service` → `controller` → `routes`.
4. Mount the router in `src/api/routes/index.ts`.
5. Add a migration under `supabase/migrations/` and RLS policies.

## Security notes

- `supabaseAdmin` (service-role key) **bypasses RLS** — use only for trusted
  server operations. Prefer the request-scoped `req.auth.db` client so Row Level
  Security enforces per-user access automatically.
- Env is validated at startup (`src/config/env.ts`); the process exits on misconfig.
- `helmet`, `cors`, and payload limits are applied globally in `loaders/express.ts`.

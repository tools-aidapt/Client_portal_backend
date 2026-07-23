# Client Portal Backend

A professional, scalable REST API built with **Node.js + TypeScript + Express**,
backed by **Supabase (Postgres + Auth + RLS)**.

## Stack

- **Runtime:** Node.js 20+, ESM, TypeScript (strict)
- **Framework:** Express 4
- **Database/Auth:** Supabase (`@supabase/supabase-js`)
- **Validation:** Zod
- **Logging:** Pino
- **Testing:** Vitest
- **Tooling:** ESLint, Prettier, Docker, GitHub Actions CI

## Getting started

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env      # then fill in your Supabase keys

# 3. Apply the database schema (four schemas, RLS, auth hook, seed)
#    See supabase/README.md for order + two required dashboard steps.
supabase db push

# 4. Run in watch mode
npm run dev
```

The API is served under the prefix in `API_PREFIX` (default `/api/v1`).
Health check: `GET /health`.

## Scripts

| Command                 | Description                          |
| ----------------------- | ------------------------------------ |
| `npm run dev`           | Start with hot reload (`tsx watch`)  |
| `npm run build`         | Compile TypeScript to `dist/`        |
| `npm start`             | Run the compiled server              |
| `npm run typecheck`     | Type-check without emitting          |
| `npm run lint`          | Lint (`--fix` to auto-fix)           |
| `npm run format`        | Format with Prettier                 |
| `npm test`              | Run tests (`:coverage` for coverage) |

## Project structure

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full layout and the
layered request flow. In short:

- `src/config` — validated env + typed config
- `src/api` — routes + HTTP middlewares
- `src/modules/<feature>` — vertical slices (controller → service → repository)
- `src/common` — shared errors, utils, types
- `src/infra` — Supabase, logger, cache adapters
- `supabase/migrations` — SQL schema + RLS policies

The **`clients`** module is a complete reference implementation — copy its shape
when adding new features.

## Path aliases

Import with aliases instead of long relative paths:

```ts
import { config } from '@config/index.js';
import { AppError } from '@common/errors/index.js';
import { supabaseAdmin } from '@infra/supabase/client.js';
```

## Docker

```bash
docker build -t client-portal-backend .
docker run --env-file .env -p 3000:3000 client-portal-backend
```

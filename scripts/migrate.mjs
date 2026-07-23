// Simple, safe migration runner for the shared Supabase Postgres database.
//
// Usage:
//   node scripts/migrate.mjs            # apply all pending migrations
//   node scripts/migrate.mjs --dry-run  # list pending migrations, apply nothing
//
// Requires DATABASE_URL in the environment (or .env), e.g. the "Session pooler"
// or "Direct connection" URI from Supabase → Project Settings → Database.
// Each file runs in its own transaction and is recorded in
// public.schema_migrations, so re-running only applies what's missing.

import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const MIGRATIONS_DIR = fileURLToPath(new URL('../supabase/migrations', import.meta.url));
const DRY_RUN = process.argv.includes('--dry-run');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error(
    '❌ DATABASE_URL is not set.\n' +
      '   Add it to .env — Supabase → Project Settings → Database → Connection string (URI).\n' +
      '   Use the Session pooler or Direct connection (port 5432), NOT the transaction pooler (6543).',
  );
  process.exit(1);
}

const client = new pg.Client({
  connectionString,
  // Supabase requires TLS; the pooler cert is not in the local trust store.
  ssl: { rejectUnauthorized: false },
});

async function main() {
  await client.connect();

  await client.query(`
    create table if not exists public.schema_migrations (
      version    text primary key,
      applied_at timestamptz not null default now()
    );
  `);

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const { rows } = await client.query('select version from public.schema_migrations');
  const applied = new Set(rows.map((r) => r.version));

  const pending = files.filter((f) => !applied.has(f));
  if (pending.length === 0) {
    console.log('✅ Nothing to apply — database is up to date.');
    return;
  }

  console.log(`${DRY_RUN ? 'Would apply' : 'Applying'} ${pending.length} migration(s):`);
  for (const file of pending) console.log(`   • ${file}`);
  if (DRY_RUN) return;

  for (const file of pending) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    process.stdout.write(`\n▶ ${file} ... `);
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into public.schema_migrations(version) values ($1)', [file]);
      await client.query('commit');
      console.log('done');
    } catch (err) {
      await client.query('rollback');
      console.log('FAILED');
      console.error(`\n❌ ${file} failed and was rolled back:\n   ${err.message}`);
      process.exit(1);
    }
  }

  console.log('\n✅ All migrations applied.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => client.end());

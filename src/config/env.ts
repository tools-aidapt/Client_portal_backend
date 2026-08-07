import 'dotenv/config';
import { z } from 'zod';

/**
 * Centralized, validated environment configuration.
 * The app fails fast at startup if required variables are missing or malformed.
 */
const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),

  // Public base URL of the API (used for links, CORS, etc.)
  API_PREFIX: z.string().default('/api/v1'),
  CORS_ORIGINS: z.string().default('*'),

  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  // Self-hosted auth (JWT). Access tokens are signed/verified with these
  // secrets; refresh tokens are opaque and stored hashed in the database.
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  // Lifetimes accepted as `ms`/`vercel/ms` strings (e.g. "15m", "30d").
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),

  // Supabase
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  // Direct Postgres connection — used for atomic, multi-statement admin
  // transactions (client onboarding) that Supabase's REST API cannot express.
  DATABASE_URL: z.string().url(),

  // Shared secret for service-role/internal endpoints (outbox drain, sync,
  // webhooks) called by cron/n8n, never by the browser.
  INTERNAL_API_SECRET: z.string().min(16).optional(),

  // ClickUp integration. API token drives sync pulls; webhook secret verifies
  // inbound ClickUp webhook signatures. Both optional until step 3 is live.
  CLICKUP_API_TOKEN: z.string().min(1).optional(),
  CLICKUP_WEBHOOK_SECRET: z.string().min(1).optional(),
  // Comma-separated ClickUp space ids the hourly pull sync walks.
  CLICKUP_SPACE_IDS: z.string().optional(),
  // Workspace (team) id. Only the Docs API (v3) needs it — v2 task/list routes
  // are addressed by list/folder id alone.
  CLICKUP_TEAM_ID: z.string().min(1).optional(),

  // Chrome/Chromium used to render report PDFs. Set in the container (the Alpine
  // `chromium` package); on a dev machine the common install paths are tried, so
  // this only needs setting for a non-standard location.
  PUPPETEER_EXECUTABLE_PATH: z.string().min(1).optional(),

  // Frontend base URL used to build invitation links (e.g. https://portal.aidapt.co).
  PORTAL_BASE_URL: z.string().url().optional(),
  // Public process-intake form the Onboarding page links out to. If unset the
  // portal shows the button disabled rather than linking nowhere.
  ONBOARDING_FORM_URL: z.string().url().optional(),
  // Public wishlist-request form the Wishlist page links out to. Submissions land
  // in the shared ClickUp list and reach the Portal on the next wishlist sync, so
  // the Portal never writes a request itself. Unset = the button is disabled.
  WISHLIST_FORM_URL: z.string().url().optional(),
  // n8n webhook that sends the invitation email. If unset, invite emails are skipped.
  N8N_INVITE_WEBHOOK_URL: z.string().url().optional(),

  // Passwordless sign-in (alongside password login — both remain available).
  // n8n webhook that sends the OTP email; if unset in non-production the code
  // is logged instead so local dev doesn't need n8n wired up.
  N8N_OTP_WEBHOOK_URL: z.string().url().optional(),
  OTP_TTL_MINUTES: z.coerce.number().int().positive().default(10),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error(
    '❌ Invalid environment configuration:',
    parsed.error.flatten().fieldErrors,
  );
  process.exit(1);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

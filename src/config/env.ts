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

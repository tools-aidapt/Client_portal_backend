import { env } from './env.js';

/**
 * Application configuration derived from validated environment variables.
 * Import from here (not `process.env`) everywhere in the codebase.
 */
export const config = {
  env: env.NODE_ENV,
  server: {
    port: env.PORT,
    host: env.HOST,
    apiPrefix: env.API_PREFIX,
  },
  cors: {
    origins:
      env.CORS_ORIGINS === '*'
        ? '*'
        : env.CORS_ORIGINS.split(',').map((o) => o.trim()),
  },
  logger: {
    level: env.LOG_LEVEL,
  },
  supabase: {
    url: env.SUPABASE_URL,
    anonKey: env.SUPABASE_ANON_KEY,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
  },
  db: {
    connectionString: env.DATABASE_URL,
  },
  internal: {
    apiSecret: env.INTERNAL_API_SECRET,
  },
  clickup: {
    apiToken: env.CLICKUP_API_TOKEN,
    webhookSecret: env.CLICKUP_WEBHOOK_SECRET,
    spaceIds: env.CLICKUP_SPACE_IDS
      ? env.CLICKUP_SPACE_IDS.split(',').map((s) => s.trim()).filter(Boolean)
      : [],
  },
} as const;

export type Config = typeof config;
export { env } from './env.js';

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
  auth: {
    accessSecret: env.JWT_ACCESS_SECRET,
    refreshSecret: env.JWT_REFRESH_SECRET,
    accessTtl: env.JWT_ACCESS_TTL,
    refreshTtl: env.JWT_REFRESH_TTL,
    bcryptRounds: env.BCRYPT_ROUNDS,
    otpTtlMinutes: env.OTP_TTL_MINUTES,
    otpMaxAttempts: env.OTP_MAX_ATTEMPTS,
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
    teamId: env.CLICKUP_TEAM_ID,
  },
  web: {
    portalBaseUrl: env.PORTAL_BASE_URL,
    onboardingFormUrl: env.ONBOARDING_FORM_URL,
    wishlistFormUrl: env.WISHLIST_FORM_URL,
  },
  n8n: {
    inviteWebhookUrl: env.N8N_INVITE_WEBHOOK_URL,
    otpWebhookUrl: env.N8N_OTP_WEBHOOK_URL,
  },
} as const;

export type Config = typeof config;
export { env, isProduction } from './env.js';

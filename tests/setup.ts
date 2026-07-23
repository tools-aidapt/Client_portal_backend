/**
 * Global test setup. Provides dummy environment variables so `src/config/env.ts`
 * validation passes without a real `.env` file. Runs before any test module.
 */
process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL ??= 'https://test.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-role-key';
process.env.DATABASE_URL ??= 'postgresql://postgres:test@localhost:5432/postgres';

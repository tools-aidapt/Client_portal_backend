import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from '@config/index.js';

/**
 * Admin client — uses the service-role key. Bypasses Row Level Security.
 * Use ONLY in trusted server-side code, never expose this key to clients.
 */
export const supabaseAdmin: SupabaseClient = createClient(
  config.supabase.url,
  config.supabase.serviceRoleKey,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  },
);

/**
 * Creates a request-scoped client bound to the caller's access token so that
 * Supabase Row Level Security policies are enforced on the user's behalf.
 */
export function createUserScopedClient(accessToken: string): SupabaseClient {
  return createClient(config.supabase.url, config.supabase.anonKey, {
    global: {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

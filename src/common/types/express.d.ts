import type { User, SupabaseClient } from '@supabase/supabase-js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Populated by the `authenticate` middleware. */
      auth?: {
        user: User;
        token: string;
        /** RLS-aware Supabase client scoped to the authenticated user. */
        db: SupabaseClient;
      };
      /** Raw request body bytes, captured for webhook signature verification. */
      rawBody?: Buffer;
      /** Active tenant context, resolved by `requireTenantRole`. */
      tenant?: {
        id: string;
        role: 'member' | 'member_plus' | 'member_pro' | 'super_admin';
      };
    }
  }
}

export {};

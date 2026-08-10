import type { AuthUser } from '@modules/auth/utils/tokens.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Populated by the `authenticate` middleware. */
      auth?: {
        user: AuthUser;
        token: string;
      };
      /** Raw request body bytes, captured for webhook signature verification. */
      rawBody?: Buffer;
      /** Active tenant context, resolved by `requireTenantRole`. */
      tenant?: {
        id: string;
        role: 'member' | 'admin' | 'super_admin';
      };
    }
  }
}

export {};

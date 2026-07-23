import { authRepo, type MeView } from '../repositories/auth.repository.js';

export interface MeResponse extends MeView {
  /** Apps this identity can open. Feature-level gating happens inside each app. */
  apps: Array<'portal' | 'lms' | 'support'>;
}

export const authService = {
  async me(userId: string): Promise<MeResponse | null> {
    const me = await authRepo.getMe(userId);
    if (!me) return null;
    const canOpen = me.is_platform_admin || me.memberships.length > 0;
    return { ...me, apps: canOpen ? ['portal', 'lms', 'support'] : [] };
  },

  async acceptInvitation(userId: string, userEmail: string, token: string) {
    const result = await authRepo.acceptInvitation(userId, userEmail, token);
    // Claims are stamped at token issue, so the new membership/role is not in the
    // current JWT — the client must refresh its session to pick it up.
    return { ...result, refreshRequired: true };
  },
};

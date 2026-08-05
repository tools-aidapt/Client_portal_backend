import { config } from '@config/index.js';
import { UnauthorizedError } from '@common/errors/index.js';
import { authRepo, type MeView, type ProfileFields } from '../repositories/auth.repository.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import {
  durationToMs,
  generateRefreshToken,
  hashRefreshToken,
  signAccessToken,
} from '../utils/tokens.js';

export interface MeResponse extends MeView {
  /** Apps this identity can open. Feature-level gating happens inside each app. */
  apps: Array<'portal' | 'lms' | 'support'>;
}

/**
 * A valid bcrypt hash of a throwaway value. Compared against on login when the
 * email is unknown, so a missing account and a wrong password take the same
 * time and can't be distinguished by response latency.
 */
const DUMMY_HASH = '$2b$12$t.4AqR/PGySQLRvpbBe59.8i9WeMoD81.YLd/MrSLbRtZ.7P0o.3W';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  /** Access-token lifetime in seconds. */
  expiresIn: number;
}

/** Issues a fresh access token (with current claims) + a stored refresh token. */
async function issueTokens(
  userId: string,
  email: string | null,
  userAgent?: string,
): Promise<TokenPair> {
  const claims = await authRepo.getAccessClaims(userId);
  const accessToken = signAccessToken(userId, email, claims);

  const { token: refreshToken, hash } = generateRefreshToken();
  const refreshMs = durationToMs(config.auth.refreshTtl);
  await authRepo.storeRefreshToken({
    userId,
    tokenHash: hash,
    expiresAt: new Date(Date.now() + refreshMs),
    userAgent,
  });

  return {
    accessToken,
    refreshToken,
    tokenType: 'Bearer',
    expiresIn: Math.floor(durationToMs(config.auth.accessTtl) / 1000),
  };
}

export const authService = {
  /**
   * Register via an invitation token. The email + tenant + role come from the
   * invitation, so a user can only register into the org they were invited to.
   */
  async register(
    input: { token: string; password: string } & ProfileFields,
    userAgent?: string,
  ): Promise<{ userId: string } & TokenPair> {
    const { token, password, ...profile } = input;
    const passwordHash = await hashPassword(password);
    const { userId, email } = await authRepo.registerViaInvitation({
      token,
      passwordHash,
      profile,
    });
    const tokens = await issueTokens(userId, email, userAgent);
    return { userId, ...tokens };
  },

  async updateProfile(userId: string, fields: ProfileFields) {
    const me = await authRepo.updateProfile(userId, fields);
    if (!me) return null;
    const canOpen = me.is_platform_admin || me.memberships.length > 0;
    return { ...me, apps: canOpen ? (['portal', 'lms', 'support'] as const) : [] };
  },

  /** Verify credentials and issue tokens. */
  async login(
    input: { email: string; password: string },
    userAgent?: string,
  ): Promise<{ userId: string } & TokenPair> {
    const cred = await authRepo.findCredentialsByEmail(input.email);
    // Verify against the stored hash when present; otherwise burn time on a
    // dummy compare so response timing doesn't reveal whether the email exists.
    const ok = cred
      ? await verifyPassword(input.password, cred.password_hash)
      : await verifyPassword(input.password, DUMMY_HASH).then(() => false);
    if (!cred || !ok) throw new UnauthorizedError('Invalid email or password');

    const tokens = await issueTokens(cred.user_id, cred.email, userAgent);
    return { userId: cred.user_id, ...tokens };
  },

  /**
   * Exchange a valid refresh token for a new token pair, rotating (revoking)
   * the presented token. A reused/revoked token is rejected.
   */
  async refresh(refreshToken: string, userAgent?: string): Promise<TokenPair> {
    const hash = hashRefreshToken(refreshToken);
    const found = await authRepo.findActiveRefreshToken(hash);
    if (!found) throw new UnauthorizedError('Invalid or expired refresh token');

    await authRepo.revokeRefreshToken(hash);
    const email = await authRepo.getEmailByUserId(found.userId);
    return issueTokens(found.userId, email, userAgent);
  },

  /** Revoke a single refresh token (this-device logout). */
  async logout(refreshToken: string): Promise<{ revoked: boolean }> {
    const revoked = await authRepo.revokeRefreshToken(hashRefreshToken(refreshToken));
    return { revoked };
  },

  /** Revoke every refresh token for a user (all-devices logout). */
  async logoutAll(userId: string): Promise<void> {
    await authRepo.revokeAllRefreshTokens(userId);
  },

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

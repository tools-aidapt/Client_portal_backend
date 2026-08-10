import { config } from '@config/index.js';
import { logger } from '@infra/logger/index.js';
import { UnauthorizedError } from '@common/errors/index.js';
import { authRepo, type MeView, type ProfileFields } from '../repositories/auth.repository.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import { generateOtpCode, hashOtpCode, verifyOtpCode } from '../utils/otp.js';
import { sendOtpEmail } from '../otp-email.js';
import { syncUserToLms, syncUserToSupportDesk, ssoRedirectUrl, type SsoTarget } from '../cross-app.js';
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
  ): Promise<{ userId: string; email: string } & TokenPair> {
    const { token, password, ...profile } = input;
    const passwordHash = await hashPassword(password);
    const { userId, email, role } = await authRepo.registerViaInvitation({
      token,
      passwordHash,
      profile,
    });
    // Best-effort: this person's Portal account is the real one regardless of
    // whether LMS/Support Desk are reachable right now — see cross-app.ts for
    // why neither of these ever throws back into registration.
    void syncUserToLms({ userId, email, passwordHash, fullName: profile.fullName ?? null, role });
    void syncUserToSupportDesk({ email, fullName: profile.fullName ?? null, role });
    const tokens = await issueTokens(userId, email, userAgent);
    // `email` is returned because the caller never had it: registration is
    // invitation-gated, so the address comes from the invitation row, not from
    // anything the person typed. The client needs it to open a session (it
    // stores the email alongside the tokens — `/auth/me` doesn't return it).
    return { userId, email, ...tokens };
  },

  /**
   * The URL to redirect the browser to so `target` logs itself in without a
   * second password prompt. Null when that app isn't configured yet (no URL,
   * or the shared secret hasn't been set) — the caller shows "not connected"
   * rather than sending the browser to a broken link.
   */
  getSsoRedirect(email: string, target: SsoTarget): string | null {
    return ssoRedirectUrl(email, target);
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
   * Request a one-time login code — the passwordless alternative to
   * `login()`. Both remain available; the client picks per attempt.
   * Always resolves (never reveals whether the email is registered): if it
   * is, a code is emailed; if not, this is a silent no-op.
   */
  async requestOtp(email: string): Promise<void> {
    const cred = await authRepo.findCredentialsByEmail(email);
    if (!cred) {
      logger.info({ email }, 'OTP requested for unknown email — ignoring');
      return;
    }
    const code = generateOtpCode();
    const expiresAt = new Date(Date.now() + config.auth.otpTtlMinutes * 60_000);
    await authRepo.createOtpCode(cred.user_id, hashOtpCode(code), expiresAt);
    await sendOtpEmail(cred.email, code);
  },

  /** Verify a requested OTP code and issue tokens, same as password `login()`. */
  async verifyOtp(
    input: { email: string; code: string },
    userAgent?: string,
  ): Promise<{ userId: string } & TokenPair> {
    const invalid = () => new UnauthorizedError('Invalid or expired code');

    const cred = await authRepo.findCredentialsByEmail(input.email);
    if (!cred) throw invalid();

    const otp = await authRepo.findActiveOtpCode(cred.user_id);
    if (!otp || otp.attempts >= config.auth.otpMaxAttempts) throw invalid();

    if (!verifyOtpCode(input.code, otp.codeHash)) {
      await authRepo.incrementOtpAttempts(otp.id);
      throw invalid();
    }

    await authRepo.consumeOtpCode(otp.id);
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

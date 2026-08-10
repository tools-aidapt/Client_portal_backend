import jwt from 'jsonwebtoken';
import { config } from '@config/index.js';
import { logger } from '@infra/logger/index.js';

/**
 * The Portal is the identity source of truth for two sibling apps (LMS,
 * Support Desk) that each already built their *receiving* half of this
 * integration, expecting the Portal to call them. This is that missing half.
 *
 * Both integrations are best-effort: a person's Portal account is the real
 * one regardless of whether LMS/Support Desk are reachable right now, so
 * nothing here ever throws back into the registration flow. A failure is
 * logged, not surfaced — the same event can be replayed manually later
 * (there's no outbox entry for this yet; see CLAUDE.md for that follow-up).
 */

/**
 * Portal roles are now 1:1 with the LMS's own vocabulary, so this is an
 * identity map kept only to make the contract explicit at the boundary.
 *
 * It used to collapse: the three `member_*` tiers all became LMS 'member', and
 * `org_admin` mapped to an 'admin' that the LMS's register endpoint rejected
 * outright (400), so a client's own admin could never be provisioned there —
 * later worked around by demoting them to 'member', which lost the distinction
 * entirely. Both problems are gone now that the vocabularies match; the LMS
 * allowlist was widened to accept 'admin' in the same change.
 */
const LMS_ROLE: Record<string, 'member' | 'admin' | 'super_admin'> = {
  member: 'member',
  admin: 'admin',
  super_admin: 'super_admin',
};

export async function syncUserToLms(params: {
  userId: string;
  email: string;
  passwordHash: string;
  fullName: string | null;
  role: string;
}): Promise<void> {
  const { lmsUrl, lmsInternalSecret } = config.crossApp;
  if (!lmsUrl || !lmsInternalSecret) {
    logger.debug('LMS_URL/LMS_INTERNAL_SECRET unset — skipping LMS user sync');
    return;
  }

  try {
    const res = await fetch(`${lmsUrl.replace(/\/$/, '')}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-secret': lmsInternalSecret },
      body: JSON.stringify({
        user_id: params.userId,
        email: params.email,
        password_hash: params.passwordHash,
        full_name: params.fullName,
        role: LMS_ROLE[params.role] ?? 'member',
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn({ status: res.status, body: body.slice(0, 300) }, 'LMS user sync failed');
      return;
    }
    logger.info({ email: params.email }, 'User synced to LMS');
  } catch (err) {
    logger.warn({ err }, 'LMS user sync request failed');
  }
}

/**
 * Support Desk has no notion of Portal roles beyond "client" vs "internal
 * staff" — only client-side roles are synced. A Portal `super_admin` is
 * Aidapt platform staff, not a Support Desk agent; granting desk access is a
 * separate, deliberate action, not an automatic side effect of registration.
 */
const SD_SYNCABLE_ROLES = new Set(['member', 'admin']);

export async function syncUserToSupportDesk(params: {
  email: string;
  fullName: string | null;
  role: string;
}): Promise<void> {
  const { supportDeskBackendUrl, supportDeskInternalSecret } = config.crossApp;
  if (!supportDeskBackendUrl || !supportDeskInternalSecret) {
    logger.debug('SUPPORT_DESK_BACKEND_URL/SUPPORT_DESK_INTERNAL_SECRET unset — skipping Support Desk user sync');
    return;
  }
  if (!SD_SYNCABLE_ROLES.has(params.role)) return;

  try {
    const res = await fetch(`${supportDeskBackendUrl.replace(/\/$/, '')}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-secret': supportDeskInternalSecret },
      body: JSON.stringify({ email: params.email, full_name: params.fullName, role: params.role }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn({ status: res.status, body: body.slice(0, 300) }, 'Support Desk user sync failed');
      return;
    }
    logger.info({ email: params.email }, 'User synced to Support Desk');
  } catch (err) {
    logger.warn({ err }, 'Support Desk user sync request failed');
  }
}

export type SsoTarget = 'support-desk' | 'lms';

const TARGET_URL: Record<SsoTarget, keyof typeof config.crossApp> = {
  'support-desk': 'supportDeskUrl',
  lms: 'lmsFrontendUrl',
};

/**
 * Signs the short-lived JWT Support Desk's `/auth/callback` (and, once built,
 * LMS's equivalent) expects: `{ email, target }`.
 *
 * Was 2 minutes — too tight for a real browser redirect: a free/starter-tier
 * Render service that's gone to sleep can take well over a minute just to
 * wake up and serve its first response, on top of normal page-load and React
 * mount time. That's a real failure a live click-through hit, not a
 * hypothetical — 5 minutes gives real-world latency (including a cold start)
 * genuine room, while still being short-lived enough that a leaked token in
 * a browser history entry is stale within minutes.
 */
export function signSsoToken(email: string, target: SsoTarget): string | null {
  if (!config.crossApp.redirectTokenSecret) return null;
  return jwt.sign({ email, target }, config.crossApp.redirectTokenSecret, { expiresIn: '5m' });
}

/**
 * The URL to send the browser to so the target app logs itself in. Null when
 * that app's URL or the shared secret isn't configured — the caller shows
 * "not connected" rather than a broken link, same convention as the
 * Dashboard's LMS/Support tiles.
 */
export function ssoRedirectUrl(email: string, target: SsoTarget): string | null {
  const base = config.crossApp[TARGET_URL[target]];
  const token = signSsoToken(email, target);
  if (!base || !token) return null;
  return `${String(base).replace(/\/$/, '')}/auth/callback?token=${encodeURIComponent(token)}`;
}

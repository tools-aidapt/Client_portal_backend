import { pool } from '@infra/db/pool.js';
import { config } from '@config/index.js';
import { logger } from '@infra/logger/index.js';
import { AppError } from '@common/errors/index.js';

/**
 * Sends the invite email right now, instead of waiting for whatever drains
 * `core.outbox` (a cron/worker that may not be running — this is exactly the
 * gap that let real invites sit `pending` for days with nothing surfacing it).
 *
 * The outbox row (already written in the same transaction that created the
 * invitation, for durability) stays as the retry safety net: this marks it
 * `done` immediately on success so the eventual drain never re-sends it, and
 * deliberately leaves it `pending` on failure so the normal retry-with-backoff
 * still applies — a transient n8n outage isn't a lost invite, just a delayed
 * one. Never throws back into the caller: the invitation itself is valid the
 * moment its row exists, independent of whether the email has gone out yet.
 */
export async function sendInviteEmailNow(invitationId: string, token: string): Promise<void> {
  try {
    await sendInviteEmail(token);
    await pool.query(
      `update core.outbox set status = 'done'
        where idempotency_key = $1 and status = 'pending'`,
      [`email.invite:${invitationId}`],
    );
  } catch (err) {
    logger.warn({ err, invitationId }, 'Immediate invite-email send failed — left pending for the outbox retry');
  }
}

/**
 * Dispatch an invitation email via the n8n webhook. n8n owns the template and
 * delivery; we send it the recipient, the org, the role, and the registration
 * link (which carries the invite token).
 *
 * Called by the `email.invite` outbox handler (the retry path) and by
 * `sendInviteEmailNow` (the immediate path), so throwing triggers a retry.
 */
export async function sendInviteEmail(token: string): Promise<void> {
  const { rows } = await pool.query<{
    email: string;
    role: string;
    status: string;
    expires_at: string;
    tenant_name: string;
  }>(
    `select i.email, i.role, i.status, i.expires_at, t.name as tenant_name
       from core.invitations i
       join core.tenants t on t.id = i.tenant_id
      where i.token = $1`,
    [token],
  );
  const inv = rows[0];
  if (!inv) throw new AppError('Invitation not found for email send', 404, 'INVITE_NOT_FOUND');
  if (inv.status !== 'pending') {
    logger.info({ email: inv.email }, 'Invitation no longer pending — skipping email');
    return;
  }

  const webhook = config.n8n.inviteWebhookUrl;
  if (!webhook) {
    logger.warn('N8N_INVITE_WEBHOOK_URL unset — skipping invitation email');
    return;
  }

  const base = (config.web.portalBaseUrl ?? '').replace(/\/$/, '');
  const inviteUrl = `${base}/register?token=${token}`;

  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: inv.email,
      tenant: inv.tenant_name,
      role: inv.role,
      invite_url: inviteUrl,
      token,
      expires_at: inv.expires_at,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new AppError(`n8n invite webhook ${res.status}: ${body.slice(0, 200)}`, 502, 'N8N_INVITE_FAILED');
  }
  logger.info({ to: inv.email, tenant: inv.tenant_name }, 'Invitation email dispatched via n8n');
}

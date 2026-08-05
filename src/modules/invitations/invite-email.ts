import { pool } from '@infra/db/pool.js';
import { config } from '@config/index.js';
import { logger } from '@infra/logger/index.js';
import { AppError } from '@common/errors/index.js';

/**
 * Dispatch an invitation email via the n8n webhook. n8n owns the template and
 * delivery; we send it the recipient, the org, the role, and the registration
 * link (which carries the invite token).
 *
 * Called by the `email.invite` outbox handler, so throwing triggers a retry.
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

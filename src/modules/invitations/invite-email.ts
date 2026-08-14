import { pool } from '@infra/db/pool.js';
import { config } from '@config/index.js';
import { logger } from '@infra/logger/index.js';
import { AppError } from '@common/errors/index.js';
import {
  DEFAULT_AIDAPT_LEAD_NAME,
  DEFAULT_AIDAPT_LEAD_TITLE,
  DEFAULT_APP_3_LINE,
  DEFAULT_APP_3_NAME,
  DEFAULT_SUPPORT_EMAIL,
  guessFirstName,
  renderInviteEmail,
} from './invite-email.template.js';

export type InviteEmailExtras = {
  firstName?: string;
};

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
export async function sendInviteEmailNow(
  invitationId: string,
  token: string,
  extras?: InviteEmailExtras,
): Promise<void> {
  try {
    await sendInviteEmail(token, extras);
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
 * Dispatch an invitation email via the n8n webhook. We own the copy (subject,
 * preheader, html, text, and the merge fields from "Email 2, rewritten"); n8n
 * delivers. The email node should send `$json.subject` and `$json.html` (plain
 * `$json.text` as the fallback), not a hardcoded body — otherwise a rewrite
 * here never reaches the inbox.
 *
 * Called by the `email.invite` outbox handler (the retry path) and by
 * `sendInviteEmailNow` (the immediate path), so throwing triggers a retry.
 */
export async function sendInviteEmail(token: string, extras?: InviteEmailExtras): Promise<void> {
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
  const firstName = extras?.firstName?.trim() || guessFirstName(inv.email);

  const rendered = renderInviteEmail({
    firstName,
    portalUrl: inviteUrl,
    loginEmail: inv.email,
    trackName: inv.tenant_name,
    app3Name: DEFAULT_APP_3_NAME,
    app3Line: DEFAULT_APP_3_LINE,
    companyName: inv.tenant_name,
    accessEndDate: null,
    supportEmail: DEFAULT_SUPPORT_EMAIL,
    aidaptLeadName: DEFAULT_AIDAPT_LEAD_NAME,
    aidaptLeadTitle: DEFAULT_AIDAPT_LEAD_TITLE,
  });

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
      subject: rendered.subject,
      preheader: rendered.preheader,
      html: rendered.html,
      text: rendered.text,
      body: rendered.html,
      first_name: firstName,
      portal_url: inviteUrl,
      login_email: inv.email,
      track_name: inv.tenant_name,
      app_3_name: DEFAULT_APP_3_NAME,
      app_3_line: DEFAULT_APP_3_LINE,
      company_name: inv.tenant_name,
      access_end_date: null,
      support_email: DEFAULT_SUPPORT_EMAIL,
      aidapt_lead_name: DEFAULT_AIDAPT_LEAD_NAME,
      aidapt_lead_title: DEFAULT_AIDAPT_LEAD_TITLE,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new AppError(`n8n invite webhook ${res.status}: ${body.slice(0, 200)}`, 502, 'N8N_INVITE_FAILED');
  }
  logger.info({ to: inv.email, tenant: inv.tenant_name }, 'Invitation email dispatched via n8n');
}

import { config, isProduction } from '@config/index.js';
import { logger } from '@infra/logger/index.js';
import { AppError } from '@common/errors/index.js';

/**
 * Dispatch a one-time login code via the n8n webhook (same delivery model as
 * invitation email — n8n owns the template, we own the trigger + payload).
 *
 * Never throws for the "no webhook configured" case in non-production, so
 * local/dev environments can read the code from the log instead of wiring n8n.
 */
export async function sendOtpEmail(email: string, code: string): Promise<void> {
  const webhook = config.n8n.otpWebhookUrl;
  if (!webhook) {
    if (!isProduction) {
      logger.info({ email, code }, 'N8N_OTP_WEBHOOK_URL unset — logging OTP code for local dev');
      return;
    }
    logger.warn('N8N_OTP_WEBHOOK_URL unset — skipping OTP email');
    return;
  }

  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: email, code, expires_in_minutes: config.auth.otpTtlMinutes }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new AppError(`n8n otp webhook ${res.status}: ${body.slice(0, 200)}`, 502, 'N8N_OTP_FAILED');
  }
  logger.info({ to: email }, 'OTP email dispatched via n8n');
}

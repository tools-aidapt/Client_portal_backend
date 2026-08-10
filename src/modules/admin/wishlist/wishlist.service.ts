import { config } from '@config/index.js';
import { logger } from '@infra/logger/index.js';
import { AppError } from '@common/errors/index.js';
import type { CreateWishlistItemBody } from './wishlist.validators.js';

/**
 * Super-admin-authored wishlist items go through the SAME public n8n webhook
 * the client-facing "Aidapt Wishlist" intake form posts to. Requests are
 * meant to be authored in one pipeline only (see CLAUDE.md — Wishlist §5):
 * writing straight into `portal.wishlist_items` here would open a second path
 * the hourly `syncWishlist` job would need to reconcile against. This way the
 * item lands in ClickUp exactly like a real submission and reaches the Portal
 * on the next sync.
 *
 * The webhook itself has no auth (per n8n config) — access control is this
 * endpoint's `requirePlatformAdmin` gate, not anything on the n8n side.
 *
 * `submitter_company` carries the ClickUp "Client Group" option text
 * verbatim — that's the field the workflow uses to route the created task to
 * the right client, same as the real form's free-text company field.
 */
export const adminWishlistService = {
  async create(body: CreateWishlistItemBody): Promise<void> {
    const webhook = config.n8n.wishlistWebhookUrl;
    if (!webhook) {
      throw new AppError(
        'N8N_WISHLIST_WEBHOOK_URL is not configured',
        500,
        'WISHLIST_WEBHOOK_UNCONFIGURED',
      );
    }

    const payload = {
      __meta: {
        form: 'Aidapt Wishlist',
        submitted_at: new Date().toISOString(),
      },
      answers: {
        submitter_name: body.submitter_name,
        submitter_role: body.submitter_role,
        submitter_email: body.submitter_email,
        submitter_company: body.client_group,
        wish_title: body.title,
        // No enumerated option list exists for this field server-side, so it
        // is not exposed as a choice — this matches the real form's default
        // when a submitter has no preference.
        wish_os: { selected: 'Not sure, you decide', freeform: '' },
        wish_problem: body.problem,
        wish_who_feels: body.who_feels_pain,
        wish_urgency: { selected: body.urgency, freeform: '' },
        wish_notes: body.notes,
      },
    };

    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const responseBody = await res.text().catch(() => '');
      throw new AppError(
        `n8n wishlist webhook ${res.status}: ${responseBody.slice(0, 200)}`,
        502,
        'N8N_WISHLIST_FAILED',
      );
    }

    logger.info(
      { clientGroup: body.client_group, title: body.title },
      'Wishlist item submitted via n8n (admin-created)',
    );
  },
};

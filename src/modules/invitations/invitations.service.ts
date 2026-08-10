import { withTransaction } from '@infra/db/pool.js';
import { onboardingRepo } from '@modules/admin/clients/repositories/onboarding.repository.js';
import { sendInviteEmailNow } from '@modules/invitations/invite-email.js';

/**
 * Create an invitation and send its email immediately. Shared by the
 * platform-admin invite endpoint and the org-admin invite endpoint.
 *
 * The outbox row is still written (durability/retry if the immediate send
 * fails), but nothing here waits on a separate drain process to fire it —
 * see sendInviteEmailNow for why that mattered.
 */
export const invitationsService = {
  async invite(input: {
    tenantId: string;
    email: string;
    role: string;
    invitedBy: string | null;
  }): Promise<{ invitationId: string }> {
    const inv = await withTransaction(async (client) => {
      const created = await onboardingRepo.createInvitation(
        client,
        input.tenantId,
        input.email,
        input.role,
        input.invitedBy,
      );
      await onboardingRepo.enqueueOutbox(client, {
        aggregate: 'invitation',
        aggregateId: created.id,
        eventType: 'email.invite',
        payload: { tenantId: input.tenantId, email: input.email, token: created.token },
        idempotencyKey: `email.invite:${created.id}`,
      });
      return created;
    });
    // Outside the transaction — an external HTTP call has no business
    // holding a DB connection open.
    await sendInviteEmailNow(inv.id, inv.token);
    return { invitationId: inv.id };
  },
};

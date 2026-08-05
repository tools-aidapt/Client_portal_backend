import { withTransaction } from '@infra/db/pool.js';
import { onboardingRepo } from '@modules/admin/clients/repositories/onboarding.repository.js';

/**
 * Create an invitation and queue its email (via the outbox → n8n). Shared by the
 * platform-admin invite endpoint and the org-admin invite endpoint.
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
    return { invitationId: inv.id };
  },
};

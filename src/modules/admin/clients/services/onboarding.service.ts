import { ConflictError } from '@common/errors/index.js';
import { withTransaction } from '@infra/db/pool.js';
import { logger } from '@infra/logger/index.js';
import { sendInviteEmailNow } from '@modules/invitations/invite-email.js';
import { onboardingRepo } from '../repositories/onboarding.repository.js';
import type {
  RegisterClientInput,
  RegisterClientResult,
} from '../types/onboarding.types.js';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * Registers a client end-to-end (design §9).
 *
 * All internal rows are written in ONE transaction; the external side effects
 * are enqueued to `core.outbox` in the SAME transaction, then drained
 * asynchronously by the outbox worker. A failure anywhere in the transaction
 * rolls everything back, so no half-provisioned tenant can exist.
 */
export const onboardingService = {
  async register(
    input: RegisterClientInput,
    actorId: string | null,
  ): Promise<RegisterClientResult> {
    const result = await withTransaction(async (client) => {
      // Unique slug (append -2, -3, ... on collision).
      const base = slugify(input.name) || 'client';
      let slug = base;
      for (let i = 2; await onboardingRepo.slugExists(client, slug); i++) {
        slug = `${base}-${i}`;
        if (i > 50) throw new ConflictError('Could not derive a unique slug');
      }

      // 1. create_tenant  (+ 2. link_clickup fields live on the tenant row)
      const tenantId = await onboardingRepo.insertTenant(client, {
        name: input.name,
        slug,
        productTier: input.productTier,
        clickupFolderId: input.clickupFolderId,
        clickupClientGroup: input.clickupClientGroup,
      });

      // 2. link_clickup — seed the per-tenant status map from the global default.
      const statusRows = await onboardingRepo.seedStatusMap(client, tenantId);

      // 3. configure_domains
      await onboardingRepo.insertEmailDomains(client, tenantId, input.emailDomains);

      // 4. provision_portal
      await onboardingRepo.insertPodPlaceholders(client, tenantId);
      if (input.sigmaReady) await onboardingRepo.insertSigmaEmbed(client, tenantId);

      // 5. provision_lms — the LMS team owns the `lms` schema (self-contained,
      // LMS_-prefixed tables) and runs its own provisioning, so the Portal no
      // longer writes there. Recorded as a no-op step for observability.

      // 6. provision_support
      await onboardingRepo.insertSupportDefaults(client, tenantId);

      // 7. create_admin_invitation
      const invite = await onboardingRepo.insertAdminInvitation(
        client,
        tenantId,
        input.adminEmail,
        actorId,
      );

      // 8. open_first_cycle
      await onboardingRepo.openFirstVotingCycle(client, tenantId);

      // 9. onboarding record + step ledger (all done) + outbox enqueue
      const onboardingId = await onboardingRepo.insertOnboarding(client, tenantId, actorId);

      await onboardingRepo.insertStep(client, onboardingId, 'create_tenant', 1, 'done', { slug });
      await onboardingRepo.insertStep(client, onboardingId, 'link_clickup', 2, 'done', {
        folder_id: input.clickupFolderId ?? null,
        status_rows_seeded: statusRows,
      });
      await onboardingRepo.insertStep(client, onboardingId, 'configure_domains', 3, 'done', {
        domains: input.emailDomains,
      });
      await onboardingRepo.insertStep(client, onboardingId, 'provision_portal', 4, 'done', {
        sigma: input.sigmaReady,
      });
      await onboardingRepo.insertStep(client, onboardingId, 'provision_lms', 5, 'skipped', {
        note: 'LMS provisioning owned by the LMS team (separate schema)',
      });
      await onboardingRepo.insertStep(client, onboardingId, 'provision_support', 6, 'done');
      await onboardingRepo.insertStep(client, onboardingId, 'create_admin_invitation', 7, 'done', {
        invitation_id: invite.id,
      });
      await onboardingRepo.insertStep(client, onboardingId, 'open_first_cycle', 8, 'done');

      // External side effects — committed atomically, processed asynchronously.
      // Provision the ClickUp folder only if one wasn't linked at registration.
      if (!input.clickupFolderId) {
        await onboardingRepo.enqueueOutbox(client, {
          aggregateId: onboardingId,
          eventType: 'clickup.provision_folder',
          payload: { tenantId, name: input.name, clientGroup: input.clickupClientGroup ?? null },
          idempotencyKey: `clickup.provision_folder:${onboardingId}`,
        });
      }
      await onboardingRepo.enqueueOutbox(client, {
        aggregateId: onboardingId,
        eventType: 'email.invite',
        payload: { tenantId, email: input.adminEmail, token: invite.token },
        idempotencyKey: `email.invite:${invite.id}`,
      });
      await onboardingRepo.enqueueOutbox(client, {
        aggregateId: onboardingId,
        eventType: 'n8n.trigger_sync',
        payload: { tenantId },
        idempotencyKey: `n8n.trigger_sync:${onboardingId}`,
      });
      await onboardingRepo.enqueueOutbox(client, {
        aggregateId: onboardingId,
        eventType: 'storage.init',
        payload: { tenantId, prefix: `tenant_${tenantId}/` },
        idempotencyKey: `storage.init:${onboardingId}`,
      });

      logger.info({ tenantId, onboardingId, slug }, 'Client registered (internal txn committed)');
      return { tenantId, onboardingId, slug, adminInvite: invite };
    });

    // Outside the transaction — an external HTTP call has no business
    // holding a DB connection open. clickup.provision_folder / n8n.trigger_sync
    // / storage.init stay on the pure outbox path (still stubs today); only
    // the invite email gets this immediate-send treatment.
    await sendInviteEmailNow(result.adminInvite.id, result.adminInvite.token);
    const { adminInvite: _adminInvite, ...rest } = result;
    return rest;
  },
};

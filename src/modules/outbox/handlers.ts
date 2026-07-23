import { logger } from '@infra/logger/index.js';
import type { OutboxRow } from './outbox.repository.js';

/**
 * Handler for one outbox event type. Throwing signals a transient failure
 * (the event is retried with backoff); returning normally marks it done.
 *
 * NOTE: the external integrations (ClickUp, n8n, email, Storage) are not built
 * yet, so these are honest STUBS — they log what they *would* do and succeed so
 * the onboarding flow can complete end-to-end in development. Replace each body
 * with the real call as that integration lands (build-sequence steps 3, 7, 9).
 */
export type OutboxHandler = (row: OutboxRow) => Promise<void>;

export const handlers: Record<string, OutboxHandler> = {
  'clickup.provision_folder': async (row) => {
    logger.warn(
      { payload: row.payload },
      'STUB clickup.provision_folder — would create the Delivery folder from template and write back list IDs',
    );
  },

  'email.invite': async (row) => {
    logger.warn(
      { email: row.payload.email },
      'STUB email.invite — would send the client-admin invitation magic link',
    );
  },

  'n8n.trigger_sync': async (row) => {
    logger.warn(
      { payload: row.payload },
      'STUB n8n.trigger_sync — would kick the first delivery + sprint sync',
    );
  },

  'storage.init': async (row) => {
    logger.warn(
      { prefix: row.payload.prefix },
      'STUB storage.init — would ensure the tenant storage prefix exists',
    );
  },
};

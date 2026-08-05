import { logger } from '@infra/logger/index.js';
import { automationRepo } from './automation.repository.js';

export const automationService = {
  async register(input: {
    tenantId: string;
    n8nWorkflowId: string;
    name: string;
    description?: string;
    isClientVisible: boolean;
  }) {
    return automationRepo.register(input);
  },

  async clientHealth(tenantId: string) {
    return { workflows: await automationRepo.clientHealth(tenantId) };
  },

  /** Apply an n8n execution result; notify the tenant on error. */
  async recordExecution(
    n8nWorkflowId: string,
    status: 'success' | 'error',
    runtimeMs: number | null,
  ): Promise<{ updated: number }> {
    const affected = await automationRepo.recordExecution(n8nWorkflowId, status, runtimeMs);
    if (status === 'error') {
      for (const a of affected) await automationRepo.notifyError(a.tenant_id, a.name);
    }
    if (affected.length === 0) {
      logger.warn({ n8nWorkflowId }, 'n8n execution for an unregistered workflow — ignored');
    }
    return { updated: affected.length };
  },
};

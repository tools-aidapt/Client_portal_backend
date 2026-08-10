import { pool, withTransaction } from '@infra/db/pool.js';

export const automationRepo = {
  /** Register (or update) an n8n workflow for a tenant and seed its health row. */
  async register(input: {
    tenantId: string;
    n8nWorkflowId: string;
    name: string;
    description?: string;
    isClientVisible: boolean;
  }): Promise<{ id: string }> {
    return withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `insert into portal.automation_workflows
           (tenant_id, n8n_workflow_id, name, description, is_client_visible, is_active)
         values ($1, $2, $3, $4, $5, true)
         on conflict (tenant_id, n8n_workflow_id) do update
           set name = excluded.name, description = excluded.description,
               is_client_visible = excluded.is_client_visible, is_active = true
         returning id`,
        [input.tenantId, input.n8nWorkflowId, input.name, input.description ?? null, input.isClientVisible],
      );
      const id = rows[0]!.id;
      await client.query(
        `insert into portal.automation_health (workflow_id, state) values ($1, 'idle')
         on conflict (workflow_id) do nothing`,
        [id],
      );
      return { id };
    });
  },

  /** Client-visible workflow health for a tenant. */
  async clientHealth(tenantId: string): Promise<Array<Record<string, unknown>>> {
    const { rows } = await pool.query(
      `select w.n8n_workflow_id, w.name, w.description,
              h.state, h.last_execution_at, h.last_execution_status,
              h.executions_this_month, h.errors_this_month, h.avg_runtime_ms, h.captured_at
         from portal.automation_workflows w
         left join portal.automation_health h on h.workflow_id = w.id
        where w.tenant_id = $1 and w.is_client_visible = true and w.is_active = true
        order by w.name`,
      [tenantId],
    );
    return rows;
  },

  /**
   * Record an n8n execution result against the workflow's health row. Returns
   * the affected tenants/workflow names (empty if the workflow isn't registered).
   */
  async recordExecution(
    n8nWorkflowId: string,
    status: 'success' | 'error',
    runtimeMs: number | null,
  ): Promise<Array<{ tenant_id: string; name: string }>> {
    const { rows } = await pool.query<{ tenant_id: string; name: string }>(
      `update portal.automation_health h set
         last_execution_at = now(),
         last_execution_status = $2,
         executions_this_month = h.executions_this_month + 1,
         errors_this_month = h.errors_this_month + case when $2 = 'error' then 1 else 0 end,
         state = case when $2 = 'error' then 'error'::portal.workflow_health
                      else 'active'::portal.workflow_health end,
         avg_runtime_ms = case
           when $3::int is null then h.avg_runtime_ms
           when h.avg_runtime_ms is null then $3::int
           else ((h.avg_runtime_ms + $3::int) / 2) end,
         captured_at = now()
       from portal.automation_workflows w
       where h.workflow_id = w.id and w.n8n_workflow_id = $1
       returning w.tenant_id, w.name`,
      [n8nWorkflowId, status, runtimeMs],
    );
    return rows;
  },

  /** Notify a tenant's automation-visible members of an error. */
  async notifyError(tenantId: string, workflowName: string): Promise<void> {
    await pool.query(
      `insert into core.notifications (tenant_id, user_id, type, title, body, link_url)
       select $1, m.user_id, 'automation_error', 'An automation reported an error', $2::text, '/automations/health'
         from core.memberships m
        where m.tenant_id = $1 and m.status = 'active'
          and m.role in ('admin','super_admin')`,
      [tenantId, workflowName],
    );
  },
};

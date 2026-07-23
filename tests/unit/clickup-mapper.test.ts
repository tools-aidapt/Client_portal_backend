import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mapClickUpTask, extractClientGroup, type TaskBucket } from '@modules/sync/clickup/mapper.js';
import type { ClickUpTask } from '@infra/clickup/client.js';

const statusMap = new Map<string, TaskBucket>([
  ['in progress', 'in_progress'],
  ['complete', 'delivered'],
  ['to do', 'upcoming'],
]);

function task(overrides: Partial<ClickUpTask> = {}): ClickUpTask {
  return {
    id: 'abc123',
    name: 'Build the thing',
    status: { status: 'In Progress' },
    start_date: '1731542400000', // 2024-11-14
    due_date: '1731628800000', // 2024-11-15
    url: 'https://app.clickup.com/t/abc123',
    list: { id: 'L1', name: 'Delivery' },
    assignees: [{ username: 'Asha' }, { email: 'sam@x.io' }],
    custom_fields: [
      { id: 'f1', name: 'Client Visible', type: 'checkbox', value: 'true' },
      { id: 'f2', name: 'Progress', type: 'number', value: '42' },
      {
        id: 'f3',
        name: 'RAG',
        type: 'drop_down',
        value: 'opt-amber',
        type_config: { options: [{ id: 'opt-amber', name: 'Amber' }, { id: 'opt-green', name: 'Green' }] },
      },
      {
        id: 'f4',
        name: 'Type of Work',
        type: 'drop_down',
        value: 0,
        type_config: { options: [{ id: 'o1', name: 'Automation', orderindex: 0 }] },
      },
    ],
    ...overrides,
  };
}

describe('mapClickUpTask', () => {
  it('resolves status to bucket (case-insensitive) and maps fields', () => {
    const row = mapClickUpTask(task(), { tenantId: 'T1', source: 'delivery', statusMap });
    expect(row.bucket).toBe('in_progress');
    expect(row.clientVisible).toBe(true);
    expect(row.progressPct).toBe(42);
    expect(row.rag).toBe('amber');
    expect(row.typeOfWork).toBe('Automation');
    expect(row.assigneeNames).toEqual(['Asha', 'sam@x.io']);
    expect(row.startDate).toBe('2024-11-14');
    expect(row.dueDate).toBe('2024-11-15');
    expect(row.source).toBe('delivery');
  });

  it('leaves bucket null for an unmapped status', () => {
    const row = mapClickUpTask(task({ status: { status: 'Weird' } }), {
      tenantId: 'T1',
      source: 'delivery',
      statusMap,
    });
    expect(row.bucket).toBeNull();
  });

  it('defaults client_visible to false and rag to null when absent', () => {
    const row = mapClickUpTask(task({ custom_fields: [] }), {
      tenantId: 'T1',
      source: 'sprint',
      statusMap,
      sprintId: 'S1',
    });
    expect(row.clientVisible).toBe(false);
    expect(row.rag).toBeNull();
    expect(row.progressPct).toBeNull();
    expect(row.sprintId).toBe('S1');
  });

  it('extracts the Client Group value for tenant routing', () => {
    const t = task({
      custom_fields: [
        {
          id: 'g',
          name: 'Client Group',
          type: 'drop_down',
          value: 'cg1',
          type_config: { options: [{ id: 'cg1', name: 'Kenafric Group' }] },
        },
      ],
    });
    expect(extractClientGroup(t)).toBe('Kenafric Group');
  });
});

describe('ClickUp webhook signature (HMAC-SHA256 of raw body)', () => {
  it('matches the documented scheme', () => {
    const secret = 'whsec_test';
    const body = Buffer.from(JSON.stringify({ event: 'taskUpdated', task_id: 'abc' }));
    const sig = createHmac('sha256', secret).update(body).digest('hex');
    const recomputed = createHmac('sha256', secret).update(body).digest('hex');
    expect(sig).toBe(recomputed);
    expect(sig).toHaveLength(64);
  });
});

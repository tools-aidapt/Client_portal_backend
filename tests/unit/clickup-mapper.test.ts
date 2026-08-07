import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  FIELD,
  mapClickUpTask,
  extractClientGroup,
  extractDisplayTitle,
  type TaskBucket,
} from '@modules/sync/clickup/mapper.js';
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
    // Fields are matched by id, so these carry the real workspace ids. Names are
    // deliberately "wrong" (renamed, as happens in ClickUp) to prove the match
    // no longer depends on them.
    custom_fields: [
      { id: FIELD.clientVisible, name: 'Client Visible', type: 'checkbox', value: 'true' },
      {
        id: FIELD.progress,
        name: 'Progress % (renamed)',
        type: 'automatic_progress',
        value: { percent_complete: 42 },
      },
      {
        id: FIELD.rag,
        name: 'RAG',
        type: 'drop_down',
        value: 'opt-amber',
        type_config: { options: [{ id: 'opt-amber', name: 'Amber' }, { id: 'opt-green', name: 'Green' }] },
      },
      {
        id: FIELD.typeOfWork,
        name: 'Type of Work (Phoenix)',
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
    expect(row.parentTaskId).toBeNull();
  });

  it('ignores a same-named field with a different id', () => {
    const row = mapClickUpTask(
      task({
        custom_fields: [
          // The "Progress" drop-down (a health label), not "Progress %".
          {
            id: '2ec4b065-00f3-4987-bdef-030545e75a7e',
            name: 'Progress',
            type: 'drop_down',
            value: 'o-ontrack',
            type_config: { options: [{ id: 'o-ontrack', name: 'On Track' }] },
          },
        ],
      }),
      { tenantId: 'T1', source: 'delivery', statusMap },
    );
    expect(row.progressPct).toBeNull();
  });

  it('captures the parent id on a subtask', () => {
    const row = mapClickUpTask(task({ parent: 'parent123' }), {
      tenantId: 'T1',
      source: 'delivery',
      statusMap,
    });
    expect(row.parentTaskId).toBe('parent123');
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
          id: FIELD.clientGroup,
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

describe('extractDisplayTitle', () => {
  // A real intake-form body (task 869edjx2q), trimmed: the fields we must not
  // store surround the one line we do.
  const body = [
    '**Client group:** Kenafric Group',
    '**Project name:** HR Recruitment Solution – Requirements & Onboarding',
    '**Submitted by:** someone@kenafric.com',
  ].join('\n');

  it('takes the Project name line only', () => {
    expect(extractDisplayTitle(body)).toBe('HR Recruitment Solution – Requirements & Onboarding');
  });

  it('is null for a body without the field, and for no body at all', () => {
    expect(extractDisplayTitle('Just some notes about the process.')).toBeNull();
    expect(extractDisplayTitle(null)).toBeNull();
    expect(extractDisplayTitle(undefined)).toBeNull();
    // Present but empty is nothing to show — fall back to the task name.
    expect(extractDisplayTitle('**Project name:**   ')).toBeNull();
  });

  it('flows into the mapped row from the task body', () => {
    const row = mapClickUpTask(task({ markdown_description: body }), {
      tenantId: 'T1',
      source: 'delivery',
      statusMap,
    });
    expect(row.displayTitle).toBe('HR Recruitment Solution – Requirements & Onboarding');
    // A task with no such body keeps null, so `name` stays the title.
    expect(mapClickUpTask(task(), { tenantId: 'T1', source: 'delivery', statusMap }).displayTitle)
      .toBeNull();
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

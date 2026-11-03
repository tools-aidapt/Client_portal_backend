import { beforeEach, describe, expect, it, vi } from 'vitest';

const projects = vi.fn();
const taskStatuses = vi.fn();
vi.mock('@modules/portal/portal.repository.js', () => ({
  portalRepo: { projects: (...a: unknown[]) => projects(...a), projectTagsByList: async () => new Map(), taskStatuses: (...a: unknown[]) => taskStatuses(...a) },
}));
vi.mock('@config/index.js', () => ({ config: { web: {} } }));

const { portalService } = await import('@modules/portal/portal.service.js');

const catalogue = [
  { key: 'to_do', label: 'To do', tone: 'neutral', bucket: 'upcoming', sort_order: 10 },
  { key: 'in_progress', label: 'In progress', tone: 'info', bucket: 'in_progress', sort_order: 20 },
  { key: 'complete', label: 'Complete', tone: 'success', bucket: 'delivered', sort_order: 30 },
];

const phase = (bucket: string, status_key: string, closed_at: string | null, completion_pct: number) => ({
  bucket,
  status_key,
  closed_at,
  completion_pct,
});

describe('portalService.projects', () => {
  beforeEach(() => {
    taskStatuses.mockResolvedValue(catalogue);
  });

  it('adds display_name, capability and delivered_at, and carries no override fields', async () => {
    projects.mockResolvedValue([
      {
        clickup_list_id: 'L1',
        name: 'Ops - Invoice Automation',
        tasks: [
          phase('delivered', 'complete', '2026-10-01T10:00:00.000Z', 100),
          phase('delivered', 'complete', '2026-10-20T10:00:00.000Z', 100),
        ],
      },
    ]);
    const { projects: rows } = await portalService.projects('t1');
    const row = rows[0]!;
    expect(row).toMatchObject({
      name: 'Ops - Invoice Automation',
      display_name: 'Invoice Automation',
      capability: 'operations',
      status: 'delivered',
      status_key: 'complete',
      progress_pct: 100,
      delivered_at: '2026-10-20T10:00:00.000Z',
    });
    expect(row).not.toHaveProperty('status_overridden');
    expect(row).not.toHaveProperty('status_override_at');
  });

  it('leaves delivered_at null until every phase is delivered, and capability null without a prefix', async () => {
    projects.mockResolvedValue([
      {
        clickup_list_id: 'L2',
        name: 'Website Redesign',
        tasks: [
          phase('delivered', 'complete', '2026-10-01T10:00:00.000Z', 100),
          phase('in_progress', 'in_progress', null, 40),
        ],
      },
    ]);
    const { projects: rows } = await portalService.projects('t1');
    expect(rows[0]).toMatchObject({
      display_name: 'Website Redesign',
      capability: null,
      status: 'in_progress',
      delivered_at: null,
      progress_pct: 70,
    });
  });
});

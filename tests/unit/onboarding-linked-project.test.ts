import { describe, expect, it, vi } from 'vitest';

const onboardingTasks = vi.fn();
const projects = vi.fn();
vi.mock('@modules/portal/portal.repository.js', () => ({
  portalRepo: {
    onboardingTasks: (...a: unknown[]) => onboardingTasks(...a),
    projects: (...a: unknown[]) => projects(...a),
    projectTagsByList: async () => new Map(),
    taskStatuses: async () => [
      { key: 'in_progress', label: 'In progress', tone: 'info', bucket: 'in_progress', sort_order: 20 },
    ],
  },
}));
vi.mock('@config/index.js', () => ({ config: { web: {} } }));

const { portalService } = await import('@modules/portal/portal.service.js');

describe('portalService.onboarding', () => {
  it('adds linked_project and capability, and drops the raw project_list_id', async () => {
    onboardingTasks.mockResolvedValue([
      { clickup_task_id: 'a', name: 'Kenafric - Operations', project_list_id: 'L1', parent_task_id: null },
      { clickup_task_id: 'b', name: 'Kenafric - Operations / Intelligence', project_list_id: null },
      { clickup_task_id: 'c', name: 'Kenafric - Website', project_list_id: 'hidden' },
    ]);
    projects.mockResolvedValue([
      {
        clickup_list_id: 'L1',
        name: 'Ops - Invoice Automation',
        tasks: [{ bucket: 'in_progress', status_key: 'in_progress', completion_pct: 40 }],
      },
    ]);
    const out = await portalService.onboarding('t1');
    expect(out.tasks[0]).toMatchObject({
      clickup_task_id: 'a',
      capability: 'operations',
      linked_project: {
        list_id: 'L1',
        name: 'Invoice Automation',
        status_key: 'in_progress',
        status_label: 'In progress',
        status_tone: 'info',
        progress_pct: 40,
        capability: 'operations',
      },
    });
    expect(out.tasks[0]).not.toHaveProperty('project_list_id');
    expect(out.tasks[1]).toMatchObject({ capability: 'operations_intelligence', linked_project: null });
    expect(out.tasks[2]).toMatchObject({ capability: null, linked_project: null });
  });

  it('skips the projects computation when nothing is linked', async () => {
    projects.mockClear();
    onboardingTasks.mockResolvedValue([{ clickup_task_id: 'a', name: 'X', project_list_id: null }]);
    await portalService.onboarding('t1');
    expect(projects).not.toHaveBeenCalled();
  });
});

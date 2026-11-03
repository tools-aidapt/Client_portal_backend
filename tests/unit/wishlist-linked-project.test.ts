import { describe, expect, it, vi } from 'vitest';

const projects = vi.fn();
vi.mock('@modules/portal/portal.service.js', () => ({ portalService: { projects: (...a: unknown[]) => projects(...a) } }));
vi.mock('@modules/wishlist/wishlist.repository.js', () => ({ wishlistRepo: {} }));
vi.mock('@config/index.js', () => ({ config: { web: {} } }));

const { wishlistService } = await import('@modules/wishlist/wishlist.service.js');

describe('wishlistService.withLinkedProjects', () => {
  it('resolves linked_project from the project computation and drops the raw list id', async () => {
    projects.mockResolvedValue({
      projects: [
        {
          clickup_list_id: 'L1',
          display_name: 'Invoice Automation',
          status_key: 'in_progress',
          status_label: 'In progress',
          progress_pct: 40,
        },
      ],
    });
    const out = await wishlistService.withLinkedProjects('t1', [
      { id: 'a', project_list_id: 'L1' },
      { id: 'b', project_list_id: null },
      { id: 'c', project_list_id: 'hidden' },
    ]);
    expect(out[0]).toEqual({
      id: 'a',
      linked_project: {
        list_id: 'L1',
        name: 'Invoice Automation',
        status_key: 'in_progress',
        status_label: 'In progress',
        progress_pct: 40,
      },
    });
    expect(out[1]).toEqual({ id: 'b', linked_project: null });
    expect(out[2]).toEqual({ id: 'c', linked_project: null });
  });

  it('skips the project query when nothing is linked', async () => {
    projects.mockClear();
    await wishlistService.withLinkedProjects('t1', [{ id: 'a', project_list_id: null }]);
    expect(projects).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn();
const clientQuery = vi.fn();
vi.mock('@infra/db/pool.js', () => ({
  pool: { query: (...a: unknown[]) => query(...a) },
  withTransaction: (fn: (c: unknown) => unknown) => fn({ query: (...a: unknown[]) => clientQuery(...a) }),
}));
vi.mock('@infra/logger/index.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('@modules/portal/portal.service.js', () => ({ portalService: {} }));
vi.mock('@config/index.js', () => ({ config: { web: {} } }));

const { canCastVote, projectConflict } = await import('@modules/wishlist/vote-permission.js');
const { wishlistService } = await import('@modules/wishlist/wishlist.service.js');
const { wishlistRepo } = await import('@modules/wishlist/wishlist.repository.js');
const { votingService } = await import('@modules/wishlist/voting.service.js');

describe('canCastVote', () => {
  it('lets admins and super_admins vote regardless of the switch', () => {
    for (const role of ['admin', 'super_admin']) {
      expect(canCastVote(role, false)).toBe(true);
      expect(canCastVote(role, true)).toBe(true);
    }
  });
  it('lets members vote only when the switch is on', () => {
    expect(canCastVote('member', false)).toBe(false);
    expect(canCastVote('member', true)).toBe(true);
  });
  it('never lets an unknown role vote', () => {
    expect(canCastVote('client_facing_lead', true)).toBe(false);
  });
});

describe('wishlistService vote permission', () => {
  beforeEach(() => {
    query.mockReset();
    clientQuery.mockReset();
  });

  it('rejects a member with 403 when the switch is off, before touching votes', async () => {
    query.mockResolvedValue({ rows: [] }); // no settings row => off
    await expect(wishlistService.vote('t1', 'i1', 'u1', 'member')).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(wishlistService.unvote('t1', 'i1', 'u1', 'member')).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it('does not even read the switch for an admin', async () => {
    const spy = vi.spyOn(wishlistRepo, 'vote').mockResolvedValue({
      item_id: 'i1',
      votes: 1,
      voted: true,
      changed: true,
    });
    await wishlistService.vote('t1', 'i1', 'u1', 'admin');
    expect(query).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('lets a member vote when the switch is on', async () => {
    query.mockResolvedValue({ rows: [{ members_can_vote: true }] });
    const spy = vi.spyOn(wishlistRepo, 'vote').mockResolvedValue({
      item_id: 'i1',
      votes: 1,
      voted: true,
      changed: true,
    });
    await expect(wishlistService.vote('t1', 'i1', 'u1', 'member')).resolves.toMatchObject({
      voted: true,
    });
    spy.mockRestore();
  });
});

describe('projectConflict', () => {
  it('flags linked items and delivery states', () => {
    expect(projectConflict({ project_list_id: 'L1', state: 'candidate' })).toMatch(/already a project/);
    expect(projectConflict({ project_list_id: null, state: 'in_progress' })).not.toBeNull();
    expect(projectConflict({ project_list_id: null, state: 'shipped' })).not.toBeNull();
  });
  it('lets a plain candidate through', () => {
    expect(projectConflict({ project_list_id: null, state: 'candidate' })).toBeNull();
  });
});

describe('wishlistRepo.vote 409 guard', () => {
  beforeEach(() => {
    clientQuery.mockReset();
  });

  function mockItem(row: { state: string; project_list_id: string | null }) {
    clientQuery.mockImplementation((sql = '') => {
      if (sql.includes('from portal.wishlist_items')) return { rows: [{ tenant_id: 't1', ...row }] };
      if (sql.includes('from portal.voting_cycles')) return { rows: [{ id: 'c1' }] };
      throw new Error('vote must not be written: ' + sql);
    });
  }

  it.each([
    ['linked to a project', { state: 'candidate', project_list_id: 'L1' }],
    ['in_progress', { state: 'in_progress', project_list_id: null }],
    ['shipped', { state: 'shipped', project_list_id: null }],
  ])('returns 409 for an item that is %s', async (_n, row) => {
    mockItem(row);
    await expect(wishlistRepo.vote('t1', 'i1', 'u1')).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('votingService.closeCycle winner selection', () => {
  beforeEach(() => {
    clientQuery.mockReset();
  });

  it('excludes items that are already projects from the winner query', async () => {
    const sqls: string[] = [];
    clientQuery.mockImplementation((sql = '') => {
      sqls.push(sql);
      if (sql.includes('from portal.voting_cycles') && sql.includes('for update')) {
        return { rows: [{ id: 'c1', tenant_id: 't1', period_month: '2026-11-01' }] };
      }
      if (sql.includes('group by v.item_id')) return { rows: [] };
      return { rows: [], rowCount: 0 };
    });
    const out = await votingService.closeCycle('c1', { notify: false });
    const winnerSql = sqls.find((s) => s.includes('group by v.item_id'))!;
    expect(winnerSql).toMatch(/wi\.project_list_id is null/);
    expect(winnerSql).toMatch(/wi\.state not in \('in_progress','shipped'\)/);
    expect(out.winnerItemId).toBeNull();
  });

  it('notifies members only through the members_can_vote switch', async () => {
    const sqls: string[] = [];
    clientQuery.mockImplementation((sql = '') => {
      sqls.push(sql);
      if (sql.includes('for update')) {
        return { rows: [{ id: 'c1', tenant_id: 't1', period_month: '2026-11-01' }] };
      }
      return { rows: [], rowCount: 0 };
    });
    await votingService.closeCycle('c1', { notify: true });
    const notify = sqls.find((s) => s.includes('core.notifications'))!;
    expect(notify).toMatch(/m\.role = 'member'/);
    expect(notify).toMatch(/ws\.members_can_vote/);
  });
});

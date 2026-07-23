import { pool, withTransaction } from '@infra/db/pool.js';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@common/errors/index.js';

export const wishlistRepo = {
  /** The tenant's current open voting cycle, if any. */
  async currentCycle(tenantId: string): Promise<{ id: string; period_month: string; opens_at: string; closes_at: string } | null> {
    const { rows } = await pool.query(
      `select id, period_month, opens_at, closes_at
         from portal.voting_cycles
        where tenant_id = $1 and is_open = true
        order by period_month desc limit 1`,
      [tenantId],
    );
    return (rows[0] as { id: string; period_month: string; opens_at: string; closes_at: string }) ?? null;
  },

  /** Items with per-cycle vote counts and whether the caller has voted. */
  async items(tenantId: string, cycleId: string | null, userId: string): Promise<Array<Record<string, unknown>>> {
    const { rows } = await pool.query(
      `select wi.id, wi.title, wi.description, wi.state, wi.created_at,
              (select count(*)::int from portal.wishlist_votes v
                 where v.cycle_id = $2 and v.item_id = wi.id) as votes,
              exists(select 1 from portal.wishlist_votes v
                 where v.cycle_id = $2 and v.item_id = wi.id and v.user_id = $3) as voted_by_me
         from portal.wishlist_items wi
        where wi.tenant_id = $1
        order by votes desc, wi.created_at desc`,
      [tenantId, cycleId, userId],
    );
    return rows;
  },

  async submit(tenantId: string, userId: string, title: string, description: string | null): Promise<Record<string, unknown>> {
    const { rows } = await pool.query(
      `insert into portal.wishlist_items (tenant_id, title, description, state, submitted_by)
       values ($1, $2, $3, 'candidate', $4)
       returning id, title, description, state, created_at`,
      [tenantId, title, description, userId],
    );
    return rows[0]!;
  },

  /**
   * Cast a vote. Validates the item belongs to the caller's tenant and that the
   * tenant has an open cycle; enforces one vote per item per cycle.
   */
  async vote(tenantId: string, itemId: string, userId: string): Promise<{ itemId: string; votes: number }> {
    return withTransaction(async (client) => {
      const { rows: itemRows } = await client.query<{ tenant_id: string }>(
        `select tenant_id from portal.wishlist_items where id = $1`,
        [itemId],
      );
      const item = itemRows[0];
      if (!item) throw new NotFoundError('Wishlist item not found');
      if (item.tenant_id !== tenantId) throw new ForbiddenError('Item belongs to another tenant');

      const { rows: cycleRows } = await client.query<{ id: string }>(
        `select id from portal.voting_cycles where tenant_id = $1 and is_open = true
          order by period_month desc limit 1`,
        [tenantId],
      );
      const cycle = cycleRows[0];
      if (!cycle) throw new BadRequestError('Voting is not open for this tenant');

      const ins = await client.query(
        `insert into portal.wishlist_votes (cycle_id, item_id, user_id)
         values ($1, $2, $3)
         on conflict (cycle_id, item_id, user_id) do nothing`,
        [cycle.id, itemId, userId],
      );
      if (ins.rowCount === 0) throw new ConflictError('You have already voted for this item');

      const { rows: countRows } = await client.query<{ n: number }>(
        `select count(*)::int n from portal.wishlist_votes where cycle_id = $1 and item_id = $2`,
        [cycle.id, itemId],
      );
      return { itemId, votes: countRows[0]!.n };
    });
  },
};

import { pool } from '@infra/db/pool.js';
import { BadRequestError, ConflictError, NotFoundError } from '@common/errors/index.js';

export interface AdminCycleRow {
  id: string;
  period_month: string;
  opens_at: string;
  closes_at: string;
  is_open: boolean;
  is_overdue: boolean;
  winning_item_id: string | null;
  winning_item_title: string | null;
  total_votes: number;
  voters: number;
}

/**
 * Admin-side voting-cycle management.
 *
 * These exist because nothing could open, close, extend or reopen a cycle by hand:
 * cycles were created only by onboarding step 8 and by the month-end job's reopen,
 * and an item's `state` could only ever become `prioritised` via that job — leaving
 * `in_progress` and `shipped` unreachable from any code path at all.
 *
 * Every method is tenant-scoped on purpose. `votingService.closeDueCycles` is
 * global, so a well-meant "just close it" against production would touch every
 * client; these take a tenant and a cycle that must belong to it.
 */
export const adminVotingRepo = {
  /** Cycles for one tenant, newest first, with the tally each produced. */
  async cycles(tenantId: string, limit = 24): Promise<AdminCycleRow[]> {
    const { rows } = await pool.query<AdminCycleRow>(
      `select c.id, c.period_month, c.opens_at, c.closes_at, c.is_open,
              (c.is_open and c.closes_at <= now()) as is_overdue,
              c.winning_item_id, wi.title as winning_item_title,
              (select count(*)::int from portal.wishlist_votes v where v.cycle_id = c.id)
                as total_votes,
              (select count(distinct v.user_id)::int from portal.wishlist_votes v
                where v.cycle_id = c.id) as voters
         from portal.voting_cycles c
         left join portal.wishlist_items wi on wi.id = c.winning_item_id
        where c.tenant_id = $1
        order by c.period_month desc
        limit $2`,
      [tenantId, limit],
    );
    return rows;
  },

  /** Per-item vote breakdown for one cycle — what the admin acts on. */
  async cycleBreakdown(tenantId: string, cycleId: string): Promise<Array<Record<string, unknown>>> {
    await this.assertCycleBelongsTo(tenantId, cycleId);
    const { rows } = await pool.query(
      `select wi.id, wi.title, wi.state,
              (select count(*)::int from portal.wishlist_votes v
                where v.cycle_id = $2 and v.item_id = wi.id) as votes
         from portal.wishlist_items wi
        where wi.tenant_id = $1
        order by votes desc, wi.created_at asc`,
      [tenantId, cycleId],
    );
    return rows;
  },

  /** 404 unless this cycle exists AND belongs to this tenant. */
  async assertCycleBelongsTo(tenantId: string, cycleId: string): Promise<{ is_open: boolean }> {
    const { rows } = await pool.query<{ tenant_id: string; is_open: boolean }>(
      `select tenant_id, is_open from portal.voting_cycles where id = $1`,
      [cycleId],
    );
    const cycle = rows[0];
    if (!cycle || cycle.tenant_id !== tenantId) {
      throw new NotFoundError('Voting cycle not found for this client');
    }
    return { is_open: cycle.is_open };
  },

  /**
   * Push a cycle's close date out. Only while it is still open — moving a closed
   * cycle's window would misdate a result that has already been notified and acted
   * on. `closes_at` must also stay in the future, or the next scheduled run closes
   * it again immediately, which is not what "extend" means.
   */
  async extend(tenantId: string, cycleId: string, closesAt: string): Promise<AdminCycleRow> {
    const { is_open } = await this.assertCycleBelongsTo(tenantId, cycleId);
    if (!is_open) throw new BadRequestError('That cycle is already closed');

    const { rowCount } = await pool.query(
      `update portal.voting_cycles
          set closes_at = $2::timestamptz
        where id = $1 and $2::timestamptz > now()`,
      [cycleId, closesAt],
    );
    if (rowCount === 0) throw new BadRequestError('closes_at must be in the future');

    return (await this.cycles(tenantId)).find((c) => c.id === cycleId)!;
  },

  /**
   * Open a cycle for a tenant that has none.
   *
   * Refuses when one is already open rather than silently no-opping: the caller
   * asked for a new voting window and needs to know they didn't get one. The
   * one-open-per-tenant index (0027) would reject it anyway; this turns a raw
   * constraint error into an explanation.
   */
  async open(
    tenantId: string,
    input: { period_month?: string; closes_at?: string },
  ): Promise<AdminCycleRow> {
    const existing = (await this.cycles(tenantId)).find((c) => c.is_open);
    if (existing) {
      throw new ConflictError('This client already has an open cycle — close or extend it first');
    }

    const { rows } = await pool.query<{ id: string }>(
      `insert into portal.voting_cycles (tenant_id, period_month, opens_at, closes_at, is_open)
       values (
         $1,
         coalesce($2::date, date_trunc('month', now())::date),
         now(),
         coalesce(
           $3::timestamptz,
           (coalesce($2::date, date_trunc('month', now())::date) + interval '1 month')::timestamptz
         ),
         true
       )
       on conflict (tenant_id, period_month) do nothing
       returning id`,
      [tenantId, input.period_month ?? null, input.closes_at ?? null],
    );
    if (!rows[0]) {
      throw new ConflictError('A cycle already exists for that month — extend or reopen it instead');
    }
    return (await this.cycles(tenantId)).find((c) => c.id === rows[0]!.id)!;
  },

  /**
   * Reopen a closed cycle for more voting, clearing the winner it recorded.
   *
   * The winner is cleared because leaving it set would show the client a decided
   * result on a cycle that is accepting votes again. The winning item's `state` is
   * deliberately NOT rolled back to `candidate`: by the time anyone reopens, a Pod
   * may already have scoped it, and silently un-prioritising real work is worse
   * than an admin flipping the state back explicitly.
   */
  async reopen(tenantId: string, cycleId: string, closesAt: string): Promise<AdminCycleRow> {
    await this.assertCycleBelongsTo(tenantId, cycleId);

    const open = (await this.cycles(tenantId)).find((c) => c.is_open);
    if (open && open.id !== cycleId) {
      throw new ConflictError('Close this client\'s currently open cycle first');
    }

    const { rowCount } = await pool.query(
      `update portal.voting_cycles
          set is_open = true, closes_at = $2::timestamptz, winning_item_id = null
        where id = $1 and $2::timestamptz > now()`,
      [cycleId, closesAt],
    );
    if (rowCount === 0) throw new BadRequestError('closes_at must be in the future');

    return (await this.cycles(tenantId)).find((c) => c.id === cycleId)!;
  },

  /**
   * Move an item along the delivery states. This is the only way `in_progress` and
   * `shipped` are reachable — the close job only ever sets `prioritised`.
   */
  async setItemState(
    tenantId: string,
    itemId: string,
    state: string,
  ): Promise<{ id: string; title: string; state: string }> {
    const { rows } = await pool.query<{ id: string; title: string; state: string }>(
      `update portal.wishlist_items
          set state = $3::portal.wishlist_state
        where id = $1 and tenant_id = $2
        returning id, title, state`,
      [itemId, tenantId, state],
    );
    if (!rows[0]) throw new NotFoundError('Wishlist item not found for this client');
    return rows[0];
  },
};

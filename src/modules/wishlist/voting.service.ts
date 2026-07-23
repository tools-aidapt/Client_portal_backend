import { pool, withTransaction } from '@infra/db/pool.js';
import { logger } from '@infra/logger/index.js';

interface CycleRow {
  id: string;
  tenant_id: string;
  period_month: string;
}

export interface CloseCycleSummary {
  closed: number;
  results: Array<{ tenantId: string; cycleId: string; winnerItemId: string | null; votes: number }>;
}

/**
 * Month-end job (design §10.6): close every open cycle whose window has ended,
 * pick the most-voted item as the winner, mark it prioritised, notify the
 * tenant, and open next month's cycle. Idempotent — only closes due cycles.
 */
export const votingService = {
  async closeDueCycles(): Promise<CloseCycleSummary> {
    const { rows: due } = await pool.query<CycleRow>(
      `select id, tenant_id, period_month from portal.voting_cycles
        where is_open = true and closes_at <= now()`,
    );

    const results: CloseCycleSummary['results'] = [];

    for (const cycle of due) {
      const result = await withTransaction(async (client) => {
        // Winner = most-voted item (ties broken by earliest submission).
        const { rows: winnerRows } = await client.query<{ item_id: string; votes: number }>(
          `select v.item_id, count(*)::int votes
             from portal.wishlist_votes v
             join portal.wishlist_items wi on wi.id = v.item_id
            where v.cycle_id = $1
            group by v.item_id, wi.created_at
            order by votes desc, wi.created_at asc
            limit 1`,
          [cycle.id],
        );
        const winner = winnerRows[0] ?? null;

        await client.query(
          `update portal.voting_cycles set is_open = false, winning_item_id = $2 where id = $1`,
          [cycle.id, winner?.item_id ?? null],
        );
        if (winner) {
          await client.query(
            `update portal.wishlist_items set state = 'prioritised' where id = $1`,
            [winner.item_id],
          );
        }

        // Open next month's cycle for this tenant (idempotent on the unique key).
        await client.query(
          `insert into portal.voting_cycles (tenant_id, period_month, opens_at, closes_at, is_open)
           values (
             $1,
             (date_trunc('month', $2::date) + interval '1 month')::date,
             date_trunc('month', $2::date) + interval '1 month',
             date_trunc('month', $2::date) + interval '2 month',
             true
           )
           on conflict (tenant_id, period_month) do nothing`,
          [cycle.tenant_id, cycle.period_month],
        );

        // Notify tenant members of the result.
        await client.query(
          `insert into core.notifications (tenant_id, user_id, type, title, body)
           select $1, m.user_id, 'voting_results', 'Wishlist voting results are in',
                  case when $2::uuid is null then 'No votes were cast this cycle.'
                       else 'The winning item has been prioritised.' end
             from core.memberships m
            where m.tenant_id = $1 and m.status = 'active'`,
          [cycle.tenant_id, winner?.item_id ?? null],
        );

        return {
          tenantId: cycle.tenant_id,
          cycleId: cycle.id,
          winnerItemId: winner?.item_id ?? null,
          votes: winner?.votes ?? 0,
        };
      });

      // ClickUp writeback (design §10.6) — STUB until the wishlist-list write
      // integration lands; the winner would be pushed to the client's Wishlist list.
      if (result.winnerItemId) {
        logger.warn(
          { tenantId: result.tenantId, winnerItemId: result.winnerItemId },
          'STUB voting.writeback — would push the prioritised item to ClickUp',
        );
      }

      results.push(result);
    }

    logger.info({ closed: due.length }, 'Voting cycles closed');
    return { closed: due.length, results };
  },
};

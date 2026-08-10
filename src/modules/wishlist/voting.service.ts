import type { PoolClient } from 'pg';
import { pool, withTransaction } from '@infra/db/pool.js';
import { logger } from '@infra/logger/index.js';
import { NotFoundError } from '@common/errors/index.js';

export interface CloseCycleResult {
  tenantId: string;
  cycleId: string;
  periodMonth: string;
  winnerItemId: string | null;
  winnerTitle: string | null;
  votes: number;
  nextCycleId: string | null;
  notified: number;
}

export interface CloseCycleSummary {
  closed: number;
  results: CloseCycleResult[];
}

/**
 * Who hears about a voting event: `admin` and above.
 *
 * Not every active member — plain `member` can read the board but cannot vote, so
 * telling them "voting results are in" invites an action they don't have. The old
 * fan-out notified everyone, including members who then hit a 403.
 */
async function notifyVoters(
  client: PoolClient,
  tenantId: string,
  type: 'voting_opened' | 'voting_results' | 'item_prioritised',
  title: string,
  body: string,
): Promise<number> {
  const { rowCount } = await client.query(
    `insert into core.notifications (tenant_id, user_id, type, title, body, link_url)
     select $1, m.user_id, $2::core.notification_type, $3, $4, '/wishlist'
       from core.memberships m
      where m.tenant_id = $1
        and m.status = 'active'
        and m.role in ('admin','super_admin')`,
    [tenantId, type, title, body],
  );
  return rowCount ?? 0;
}

/**
 * Open the tenant's next cycle.
 *
 * The month is `greatest(month after the one just closed, the current month)`.
 * Deriving it purely from the closing cycle — as this used to — meant a job run
 * months late advanced only ONE month per invocation, immediately creating another
 * already-due cycle. Kenafric's July cycle sat open past its close date precisely
 * because nothing ran; a catch-up must land on today's month in one pass.
 *
 * The `where not exists` guard is required by the one-open-cycle-per-tenant index
 * (migration 0027): without it, a manually-opened future cycle would turn this
 * insert into a constraint violation that aborts the whole month-end job.
 */
async function openNextCycle(
  client: PoolClient,
  tenantId: string,
  closedPeriodMonth: string,
): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    `with target as (
       select greatest(
                (date_trunc('month', $2::date) + interval '1 month')::date,
                date_trunc('month', now())::date
              ) as pm
     )
     insert into portal.voting_cycles (tenant_id, period_month, opens_at, closes_at, is_open)
     select $1, t.pm, t.pm::timestamptz, (t.pm + interval '1 month')::timestamptz, true
       from target t
      where not exists (
        select 1 from portal.voting_cycles where tenant_id = $1 and is_open = true
      )
     on conflict (tenant_id, period_month) do nothing
     returning id`,
    [tenantId, closedPeriodMonth],
  );
  return rows[0]?.id ?? null;
}

export const votingService = {
  /**
   * Close ONE cycle: pick the winner, prioritise it, notify, open the next.
   *
   * Split out from `closeDueCycles` so a single tenant's cycle can be closed
   * deliberately — by the admin endpoint or a smoke test — without touching every
   * other tenant's.
   *
   * `notify: false` closes silently. That exists for exactly the case Kenafric is
   * in: a cycle that expired with zero votes, where "No votes were cast this
   * cycle" would be a client's first-ever wishlist notification.
   */
  async closeCycle(cycleId: string, opts: { notify?: boolean } = {}): Promise<CloseCycleResult> {
    const notify = opts.notify ?? true;

    const result = await withTransaction(async (client) => {
      const { rows: cycleRows } = await client.query<{
        id: string;
        tenant_id: string;
        period_month: string;
      }>(
        // Locked so two concurrent closes can't both pick a winner.
        `select id, tenant_id, period_month from portal.voting_cycles
          where id = $1 for update`,
        [cycleId],
      );
      const cycle = cycleRows[0];
      if (!cycle) throw new NotFoundError('Voting cycle not found');

      // Winner = most votes, ties to the earliest submission. `items()` in the
      // repository orders the client's board the same way, so the item shown on
      // top is the item that wins.
      const { rows: winnerRows } = await client.query<{
        item_id: string;
        title: string;
        votes: number;
      }>(
        `select v.item_id, wi.title, count(*)::int votes
           from portal.wishlist_votes v
           join portal.wishlist_items wi on wi.id = v.item_id
          where v.cycle_id = $1
          group by v.item_id, wi.title, wi.created_at
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
        await client.query(`update portal.wishlist_items set state = 'prioritised' where id = $1`, [
          winner.item_id,
        ]);
      }

      const nextCycleId = await openNextCycle(client, cycle.tenant_id, cycle.period_month);

      let notified = 0;
      if (notify) {
        // Name the winner. The old body said only "The winning item has been
        // prioritised", which told the client nothing they could act on.
        notified += await notifyVoters(
          client,
          cycle.tenant_id,
          'voting_results',
          'Wishlist voting results are in',
          winner
            ? `"${winner.title}" won with ${winner.votes} vote${winner.votes === 1 ? '' : 's'}. Your Pod will scope it via Onboarding.`
            : 'No votes were cast this cycle, so nothing was prioritised.',
        );
        if (winner) {
          notified += await notifyVoters(
            client,
            cycle.tenant_id,
            'item_prioritised',
            'A wishlist request was prioritised',
            `"${winner.title}" is next up. Your Pod will scope it via Onboarding.`,
          );
        }
        if (nextCycleId) {
          notified += await notifyVoters(
            client,
            cycle.tenant_id,
            'voting_opened',
            'A new wishlist voting cycle is open',
            'Vote for what you want your Pod to build next.',
          );
        }
      }

      return {
        tenantId: cycle.tenant_id,
        cycleId: cycle.id,
        periodMonth: cycle.period_month,
        winnerItemId: winner?.item_id ?? null,
        winnerTitle: winner?.title ?? null,
        votes: winner?.votes ?? 0,
        nextCycleId,
        notified,
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
    return result;
  },

  /**
   * Close every cycle whose window has ended, for EVERY tenant.
   *
   * Note the scope: this is the month-end job, and it is global. Anything that
   * should affect one client only must call `closeCycle` instead.
   *
   * Loops to convergence because `openNextCycle` can open a cycle that is itself
   * already due (a manually shortened window, a `period_month` set in the past).
   * With the catch-up arithmetic above the second pass is normally a no-op; the
   * cap turns a runaway into a loud log rather than a hung request.
   */
  async closeDueCycles(opts: { notify?: boolean } = {}): Promise<CloseCycleSummary> {
    const results: CloseCycleResult[] = [];
    const MAX_PASSES = 24;

    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const { rows: due } = await pool.query<{ id: string }>(
        `select id from portal.voting_cycles where is_open = true and closes_at <= now()`,
      );
      if (due.length === 0) break;

      for (const cycle of due) results.push(await this.closeCycle(cycle.id, opts));

      if (pass === MAX_PASSES - 1) {
        logger.error(
          { passes: MAX_PASSES },
          'closeDueCycles hit its pass cap — cycles are not advancing',
        );
      }
    }

    logger.info({ closed: results.length }, 'Voting cycles closed');
    return { closed: results.length, results };
  },
};

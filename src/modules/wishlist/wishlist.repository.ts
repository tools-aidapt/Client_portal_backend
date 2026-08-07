import type { PoolClient } from 'pg';
import { pool, withTransaction } from '@infra/db/pool.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '@common/errors/index.js';
import type { WishlistItemUpsert } from '@modules/sync/clickup/wishlist-mapper.js';

/**
 * The shape both vote and unvote return. snake_case to match every other
 * response in this API — `vote` used to return camelCase `{ itemId, votes }`,
 * alone in doing so. `changed` says whether this call actually altered anything,
 * since both endpoints are idempotent.
 */
export interface VoteResult {
  item_id: string;
  votes: number;
  voted: boolean;
  changed: boolean;
}

async function countVotes(client: PoolClient, cycleId: string, itemId: string): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    `select count(*)::int n from portal.wishlist_votes where cycle_id = $1 and item_id = $2`,
    [cycleId, itemId],
  );
  return rows[0]!.n;
}

export interface CycleRow {
  id: string;
  period_month: string;
  opens_at: string;
  closes_at: string;
  is_open: boolean;
  /** Open but past its close date — the honest state when nothing closed it. */
  is_overdue: boolean;
  winning_item_id: string | null;
  winning_item_title: string | null;
}

export const wishlistRepo = {
  /**
   * The tenant's recent cycles, newest first.
   *
   * Replaces the old `currentCycle`, which filtered `is_open = true` and omitted
   * `winning_item_id` — so a CLOSED cycle was invisible and a winner could never
   * be reported, despite the UI having a "this month's winner" card. One row also
   * can't serve the page: when August is open and July closed with a winner, the
   * board needs both ("vote now" AND "last month's winner"). The service picks.
   */
  async cycles(tenantId: string, limit = 12): Promise<CycleRow[]> {
    const { rows } = await pool.query<CycleRow>(
      `select c.id, c.period_month, c.opens_at, c.closes_at, c.is_open,
              (c.is_open and c.closes_at <= now()) as is_overdue,
              c.winning_item_id, wi.title as winning_item_title
         from portal.voting_cycles c
         left join portal.wishlist_items wi on wi.id = c.winning_item_id
        where c.tenant_id = $1
        order by c.period_month desc
        limit $2`,
      [tenantId, limit],
    );
    return rows;
  },

  /**
   * The board, with vote counts.
   *
   * `countingCycleId` is the open cycle, or the most recent closed one when
   * nothing is open. That second case is why this takes two cycle ids: the old
   * query passed a single id that was NULL between cycles, so `v.cycle_id = null`
   * matched nothing and every item reported `votes: 0` — a board of zeros that
   * silently misrepresented the client's own history.
   *
   * `openCycleId` scopes `voted_by_me` and `can_vote`, which must reflect the
   * OPEN cycle only. Sourcing them from a closed cycle would render a "Voted"
   * toggle the user cannot undo, because un-voting requires an open cycle.
   */
  async items(
    tenantId: string,
    countingCycleId: string | null,
    openCycleId: string | null,
    userId: string,
    filter: { state?: string } = {},
  ): Promise<Array<Record<string, unknown>>> {
    const { rows } = await pool.query(
      `select wi.id, wi.title, wi.description, wi.reference_video_url, wi.department,
              wi.state, wi.created_at,
              wi.problem, wi.who_feels_pain, wi.urgency, wi.submitter_notes,
              wi.submitter_name, wi.submitter_role, wi.submitter_company, wi.submitted_at,
              -- Only when the parse found nothing: keeps the list payload small in
              -- the normal case while an unrecognised body still reaches the client
              -- verbatim. Same contract as /usecases/:slug.
              case when wi.problem is null then wi.body_md end as body_md,
              -- Provenance WITHOUT leaking the ClickUp task id: the whole point of
              -- the portal schema is that client responses carry no Aidapt-internal
              -- ClickUp structure, and the raw id is useless without workspace access.
              case when wi.clickup_task_id is null then 'portal' else 'request_form' end as source,
              (select count(*)::int from portal.wishlist_votes v
                 where v.cycle_id = $2 and v.item_id = wi.id) as votes,
              (select count(*)::int from portal.wishlist_votes v
                 where v.item_id = wi.id) as votes_all_time,
              ($3::uuid is not null and exists(
                 select 1 from portal.wishlist_votes v
                  where v.cycle_id = $3 and v.item_id = wi.id and v.user_id = $4)) as voted_by_me,
              ($3::uuid is not null and wi.state = 'candidate') as can_vote
         from portal.wishlist_items wi
        where wi.tenant_id = $1
          and ($5::portal.wishlist_state is null or wi.state = $5::portal.wishlist_state)
        -- Shipped items sink rather than disappear: "you asked for this, we
        -- shipped it" is the whole point of the wishlist -> onboarding loop.
        -- Ties break on created_at ASC to match the winner query in
        -- voting.service.ts; they used to break DESC here, so on a tie the item
        -- at the top of the client's board was NOT the one that would win.
        order by (wi.state = 'shipped'), votes desc, wi.created_at asc`,
      [tenantId, countingCycleId, openCycleId, userId, filter.state ?? null],
    );
    return rows;
  },

  async submit(
    tenantId: string,
    userId: string,
    input: {
      title: string;
      description: string | null;
      referenceVideoUrl: string | null;
      department: string | null;
    },
  ): Promise<Record<string, unknown>> {
    const { rows } = await pool.query(
      `insert into portal.wishlist_items
         (tenant_id, title, description, reference_video_url, department, state, submitted_by)
       values ($1, $2, $3, $4, $5, 'candidate', $6)
       returning id, title, description, reference_video_url, department, state, created_at`,
      [tenantId, input.title, input.description, input.referenceVideoUrl, input.department, userId],
    );
    return rows[0]!;
  },

  /**
   * Upsert a wishlist item synced from ClickUp (ORG - Client - Wishlist), keyed
   * by clickup_task_id. Portal-native submissions (clickup_task_id null) are
   * never touched by this — the partial unique index only covers non-null ids.
   *
   * `state` is deliberately absent from the update list: a `prioritised` winner
   * (or an admin-set `in_progress`/`shipped`) must survive every re-sync. So is
   * `created_at`, which stays the original ClickUp submission time because the
   * winner tie-break orders on it.
   *
   * The parsed detail columns (migration 0027) ARE refreshed, so correcting a
   * typo in the ClickUp form flows through on the next sync.
   */
  async upsertFromClickUp(input: WishlistItemUpsert & { submittedBy: string | null }): Promise<void> {
    const d = input.detail;
    await pool.query(
      `insert into portal.wishlist_items
         (tenant_id, clickup_task_id, title, state, created_at,
          problem, who_feels_pain, urgency, submitter_notes,
          submitter_name, submitter_role, submitter_company, submitted_at,
          body_md, submitted_by, synced_at)
       values ($1, $2, $3, 'candidate', coalesce($4::timestamptz, now()),
               $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, $13, $14, now())
       on conflict (clickup_task_id) where clickup_task_id is not null do update set
         tenant_id         = excluded.tenant_id,
         title             = excluded.title,
         problem           = excluded.problem,
         who_feels_pain    = excluded.who_feels_pain,
         urgency           = excluded.urgency,
         submitter_notes   = excluded.submitter_notes,
         submitter_name    = excluded.submitter_name,
         submitter_role    = excluded.submitter_role,
         submitter_company = excluded.submitter_company,
         submitted_at      = excluded.submitted_at,
         body_md           = excluded.body_md,
         -- Never clear an attribution we already made: a form email that stops
         -- resolving (the person left the tenant) shouldn't orphan the request.
         submitted_by      = coalesce(excluded.submitted_by, portal.wishlist_items.submitted_by),
         synced_at         = now()`,
      [
        input.tenantId, input.clickupTaskId, input.title, input.createdAt,
        d.problem, d.whoFeelsPain, d.urgency, d.submitterNotes,
        d.submitterName, d.submitterRole, d.submitterCompany, d.submittedAt,
        d.bodyMd, input.submittedBy,
      ],
    );
  },

  /**
   * Resolve the votable item + open cycle for a tenant, or throw the reason why
   * not. Shared by vote and unvote so the two can never drift on their guards.
   */
  async resolveVoteContext(
    client: PoolClient,
    tenantId: string,
    itemId: string,
  ): Promise<{ cycleId: string; state: string }> {
    const { rows: itemRows } = await client.query<{ tenant_id: string; state: string }>(
      `select tenant_id, state from portal.wishlist_items where id = $1`,
      [itemId],
    );
    const item = itemRows[0];
    if (!item) throw new NotFoundError('Wishlist item not found');
    if (item.tenant_id !== tenantId) throw new ForbiddenError('Item belongs to another tenant');

    // The one-open-cycle-per-tenant index (migration 0027) makes this unambiguous.
    const { rows: cycleRows } = await client.query<{ id: string }>(
      `select id from portal.voting_cycles where tenant_id = $1 and is_open = true
        order by period_month desc limit 1`,
      [tenantId],
    );
    const cycle = cycleRows[0];
    if (!cycle) throw new BadRequestError('Voting is not open for this tenant');

    return { cycleId: cycle.id, state: item.state };
  },

  /**
   * Cast a vote — one per person per item per cycle, unlimited items.
   *
   * IDEMPOTENT: voting twice returns the same 200 with `already: true` rather
   * than the old 409. With a Vote/Voted toggle in the UI a repeat tap is routine,
   * and a 409 the frontend has to translate into "fine, you already voted" is a
   * sign the status code was wrong.
   */
  async vote(tenantId: string, itemId: string, userId: string): Promise<VoteResult> {
    return withTransaction(async (client) => {
      const { cycleId, state } = await this.resolveVoteContext(client, tenantId, itemId);
      // Nothing stopped this before, so a client could spend a vote on something
      // already won and shipped.
      if (state !== 'candidate') throw new BadRequestError('This item is no longer up for vote');

      const ins = await client.query(
        `insert into portal.wishlist_votes (cycle_id, item_id, user_id)
         values ($1, $2, $3)
         on conflict (cycle_id, item_id, user_id) do nothing`,
        [cycleId, itemId, userId],
      );

      return {
        item_id: itemId,
        votes: await countVotes(client, cycleId, itemId),
        voted: true,
        changed: (ins.rowCount ?? 0) > 0,
      };
    });
  },

  /**
   * Remove the caller's vote from an item.
   *
   * IDEMPOTENT: removing a vote that isn't there is a 200 with `changed: false`,
   * not a 404 — the desired post-state ("no vote of mine on this item") already
   * holds, so a double-tap must not raise an error banner.
   *
   * Requires an OPEN cycle: retracting from a closed cycle would rewrite a result
   * that has already been acted on.
   */
  async unvote(tenantId: string, itemId: string, userId: string): Promise<VoteResult> {
    return withTransaction(async (client) => {
      const { cycleId } = await this.resolveVoteContext(client, tenantId, itemId);

      const del = await client.query(
        `delete from portal.wishlist_votes
          where cycle_id = $1 and item_id = $2 and user_id = $3`,
        [cycleId, itemId, userId],
      );

      return {
        item_id: itemId,
        votes: await countVotes(client, cycleId, itemId),
        voted: false,
        changed: (del.rowCount ?? 0) > 0,
      };
    });
  },
};

import { pool } from '@infra/db/pool.js';

export interface OutboxRow {
  id: string;
  aggregate: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
  idempotency_key: string | null;
}

export const outboxRepo = {
  /**
   * Atomically claim up to `limit` due events, flipping them to `processing`.
   * FOR UPDATE SKIP LOCKED lets multiple workers run without contending.
   */
  async claimBatch(limit: number): Promise<OutboxRow[]> {
    const { rows } = await pool.query<OutboxRow>(
      `with due as (
         select id from core.outbox
         where status = 'pending' and next_attempt_at <= now()
         order by next_attempt_at
         limit $1
         for update skip locked
       )
       update core.outbox o
          set status = 'processing'
         from due
        where o.id = due.id
       returning o.id, o.aggregate, o.aggregate_id, o.event_type,
                 o.payload, o.attempts, o.idempotency_key`,
      [limit],
    );
    return rows;
  },

  async markDone(id: string): Promise<void> {
    await pool.query(`update core.outbox set status = 'done' where id = $1`, [id]);
  },

  /** Transient failure: back to pending with a future next_attempt_at. */
  async markRetry(id: string, error: string, delayMs: number): Promise<void> {
    await pool.query(
      `update core.outbox
          set status = 'pending',
              attempts = attempts + 1,
              last_error = $2,
              next_attempt_at = now() + ($3::int * interval '1 millisecond')
        where id = $1`,
      [id, error, Math.round(delayMs)],
    );
  },

  /** Terminal failure after the retry ceiling. */
  async markDead(id: string, error: string): Promise<void> {
    await pool.query(
      `update core.outbox
          set status = 'dead', attempts = attempts + 1, last_error = $2
        where id = $1`,
      [id, error],
    );
  },

  /** True when every outbox event for this onboarding aggregate is done. */
  async allEventsDone(onboardingId: string): Promise<boolean> {
    const { rows } = await pool.query<{ pending: string }>(
      `select count(*)::text as pending
         from core.outbox
        where aggregate = 'onboarding' and aggregate_id = $1 and status <> 'done'`,
      [onboardingId],
    );
    return rows[0]!.pending === '0';
  },
};

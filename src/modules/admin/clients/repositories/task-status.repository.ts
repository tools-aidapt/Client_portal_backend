import { pool } from '@infra/db/pool.js';

/** One row of the client-facing status catalogue (`portal.task_statuses`). */
export interface TaskStatus {
  key: string;
  label: string;
  tone: 'neutral' | 'info' | 'warning' | 'error' | 'success' | 'teal';
  bucket: 'delivered' | 'in_progress' | 'upcoming';
  sort_order: number;
  description: string | null;
}

/** The client-facing status catalogue. Status itself comes only from ClickUp. */
export const taskStatusRepo = {
  /** The full catalogue, in display order. Small and global, so no caching. */
  async catalogue(): Promise<TaskStatus[]> {
    const { rows } = await pool.query<TaskStatus>(
      `select key, label, tone, bucket, sort_order, description
         from portal.task_statuses
        order by sort_order`,
    );
    return rows;
  },
};

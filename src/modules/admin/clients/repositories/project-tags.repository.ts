import { pool, withTransaction } from '@infra/db/pool.js';
import { ConflictError, NotFoundError, ValidationError } from '@common/errors/index.js';
import { slugifyTagKey, type ProjectTag } from '@modules/portal/project-tags.js';

export interface TagRow {
  id: string;
  key: string;
  label: string;
  tone: string;
  sort_order: number;
}

/**
 * Admin writes for project tags. The vocabulary is global (like the status
 * catalogue); assignments are per project, so every assignment write is checked
 * against the tenant's own `purpose = 'project'` mapping first.
 */
export const projectTagsRepo = {
  async list(): Promise<TagRow[]> {
    const { rows } = await pool.query<TagRow>(
      `select id, key, label, tone, sort_order from portal.project_tags order by sort_order, label`,
    );
    return rows;
  },

  /** New tags sort after every existing one. 409 when the slug is already taken. */
  async create(label: string, tone: string, userId: string): Promise<TagRow> {
    const key = slugifyTagKey(label);
    try {
      const { rows } = await pool.query<TagRow>(
        `insert into portal.project_tags (key, label, tone, sort_order, created_by)
         values ($1, $2, $3, coalesce((select max(sort_order) from portal.project_tags), 0) + 10, $4)
         returning id, key, label, tone, sort_order`,
        [key, label, tone, userId],
      );
      return rows[0]!;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictError(`A tag with the key "${key}" already exists`);
      }
      throw err;
    }
  },

  /**
   * Replace the project's tag set atomically. The caller has already validated
   * the shape (no duplicates, primary within the set, max 8); here we check the
   * project is this tenant's and that every tag id exists. Returns the new set
   * in display order (primary first, then sort_order, label).
   */
  async replaceForProject(
    tenantId: string,
    listId: string,
    tagIds: string[],
    primaryTagId: string | null,
    userId: string,
  ): Promise<ProjectTag[]> {
    return withTransaction(async (client) => {
      const { rows: mapping } = await client.query(
        `select 1 from portal.clickup_list_mappings
          where tenant_id = $1 and clickup_list_id = $2 and purpose = 'project'`,
        [tenantId, listId],
      );
      if (!mapping[0]) throw new NotFoundError('No project with that list id for this client');

      if (tagIds.length > 0) {
        const { rows: found } = await client.query(
          `select id from portal.project_tags where id = any($1::uuid[])`,
          [tagIds],
        );
        if (found.length !== tagIds.length) throw new ValidationError('One or more tag_ids do not exist');
      }

      await client.query(
        `delete from portal.project_tag_assignments where tenant_id = $1 and clickup_list_id = $2`,
        [tenantId, listId],
      );
      if (tagIds.length > 0) {
        await client.query(
          `insert into portal.project_tag_assignments (tenant_id, clickup_list_id, tag_id, is_primary, created_by)
           select $1, $2, t, coalesce(t = $3::uuid, false), $4 from unnest($5::uuid[]) as t`,
          [tenantId, listId, primaryTagId, userId, tagIds],
        );
      }

      const { rows } = await client.query<ProjectTag>(
        `select t.id, t.key, t.label, t.tone, a.is_primary
           from portal.project_tag_assignments a
           join portal.project_tags t on t.id = a.tag_id
          where a.tenant_id = $1 and a.clickup_list_id = $2
          order by a.is_primary desc, t.sort_order, t.label`,
        [tenantId, listId],
      );
      return rows;
    });
  },
};

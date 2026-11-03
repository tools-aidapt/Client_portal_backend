import { pool, withTransaction } from '@infra/db/pool.js';
import { NotFoundError } from '@common/errors/index.js';

export interface TaskWishlistLink {
  clickup_task_id: string;
  name: string;
  source_wishlist_item_id: string | null;
  source_wishlist_title: string | null;
}

/**
 * Admin writes that link a cached ClickUp task back to the Portal-native record
 * it originated from. Deliberately separate from the sync repository: these are
 * human curation decisions, not anything a sync can derive (see migration
 * 0024 and docs/database/portal.md).
 */
export const taskLinksRepo = {
  /**
   * Point an onboarding task at the wishlist item it came from, or clear the
   * link when `wishlistItemId` is null.
   *
   * Both sides are validated against the SAME tenant before the write. The FK
   * alone can't do this — it only proves the wishlist item exists somewhere, so
   * without the check an admin could staple one client's wishlist item onto
   * another client's task and the title would surface on the wrong Portal.
   * Two lookups rather than one guarded UPDATE so the two failure modes give
   * distinguishable errors instead of a bare "not found".
   */
  async setWishlistSource(
    tenantId: string,
    clickupTaskId: string,
    wishlistItemId: string | null,
  ): Promise<TaskWishlistLink> {
    return withTransaction(async (client) => {
      const { rows: taskRows } = await client.query<{ id: string }>(
        `select id from portal.task_cache where clickup_task_id = $1 and tenant_id = $2`,
        [clickupTaskId, tenantId],
      );
      if (!taskRows[0]) {
        throw new NotFoundError('No cached task with that ClickUp id for this client');
      }

      let title: string | null = null;
      if (wishlistItemId) {
        const { rows: itemRows } = await client.query<{ title: string }>(
          `select title from portal.wishlist_items where id = $1 and tenant_id = $2`,
          [wishlistItemId, tenantId],
        );
        if (!itemRows[0]) {
          throw new NotFoundError('No wishlist item with that id for this client');
        }
        title = itemRows[0].title;
      }

      const { rows } = await client.query<TaskWishlistLink>(
        `update portal.task_cache
            set source_wishlist_item_id = $3
          where clickup_task_id = $1 and tenant_id = $2
          returning clickup_task_id, name, source_wishlist_item_id`,
        [clickupTaskId, tenantId, wishlistItemId],
      );
      return { ...rows[0]!, source_wishlist_title: title };
    });
  },

  /**
   * The tenant's wishlist items an admin can link to, newest first, with the
   * task (if any) each one is already linked to — so the admin can see at a
   * glance which prioritised items still need a Process List task attached.
   */
  async listLinkableWishlistItems(tenantId: string): Promise<Array<Record<string, unknown>>> {
    const { rows } = await pool.query(
      `select wi.id, wi.title, wi.state, wi.created_at,
              tc.clickup_task_id as linked_clickup_task_id, tc.name as linked_task_name
         from portal.wishlist_items wi
         left join portal.task_cache tc
           on tc.source_wishlist_item_id = wi.id and tc.tenant_id = wi.tenant_id
        where wi.tenant_id = $1 and wi.archived_at is null
        order by wi.created_at desc`,
      [tenantId],
    );
    return rows;
  },

  /**
   * Point a wishlist item at the project that delivered it, or clear the link
   * with null. The item and the list are both checked against the tenant first
   * (the composite FK enforces the list half too, but only as a 500).
   */
  async setWishlistProject(
    tenantId: string,
    itemId: string,
    projectListId: string | null,
  ): Promise<{ item_id: string; project_list_id: string | null }> {
    return withTransaction(async (client) => {
      const { rows: itemRows } = await client.query(
        `select 1 from portal.wishlist_items where id = $1 and tenant_id = $2`,
        [itemId, tenantId],
      );
      if (!itemRows[0]) throw new NotFoundError('No wishlist item with that id for this client');

      if (projectListId) {
        const { rows: listRows } = await client.query(
          `select 1 from portal.clickup_list_mappings
            where tenant_id = $1 and clickup_list_id = $2 and purpose = 'project'`,
          [tenantId, projectListId],
        );
        if (!listRows[0]) throw new NotFoundError('No project with that list id for this client');
      }

      await client.query(
        `update portal.wishlist_items set project_list_id = $3 where id = $1 and tenant_id = $2`,
        [itemId, tenantId, projectListId],
      );
      return { item_id: itemId, project_list_id: projectListId };
    });
  },

  /**
   * Point an onboarding request at the project delivering it, or clear the link
   * with null. The task must be a top-level task on THIS tenant's onboarding
   * list (a shared list: other clients' rows never match) and the list must be
   * this tenant's project mapping; either miss is a 404.
   */
  async setOnboardingProject(
    tenantId: string,
    clickupTaskId: string,
    projectListId: string | null,
  ): Promise<{ task_id: string; project_list_id: string | null }> {
    return withTransaction(async (client) => {
      const { rows: taskRows } = await client.query(
        `select 1
           from portal.task_cache tc
           join portal.clickup_list_mappings m
             on m.tenant_id = tc.tenant_id and m.clickup_list_id = tc.clickup_list_id
          where tc.clickup_task_id = $1 and tc.tenant_id = $2
            and m.purpose = 'onboarding' and tc.parent_task_id is null`,
        [clickupTaskId, tenantId],
      );
      if (!taskRows[0]) throw new NotFoundError('No onboarding request with that ClickUp id for this client');

      if (projectListId) {
        const { rows: listRows } = await client.query(
          `select 1 from portal.clickup_list_mappings
            where tenant_id = $1 and clickup_list_id = $2 and purpose = 'project'`,
          [tenantId, projectListId],
        );
        if (!listRows[0]) throw new NotFoundError('No project with that list id for this client');
      }

      await client.query(
        `update portal.task_cache set project_list_id = $3 where clickup_task_id = $1 and tenant_id = $2`,
        [clickupTaskId, tenantId, projectListId],
      );
      return { task_id: clickupTaskId, project_list_id: projectListId };
    });
  },
};

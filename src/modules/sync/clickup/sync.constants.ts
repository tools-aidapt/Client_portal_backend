/**
 * Fixed ClickUp locations the sync reads from.
 *
 * These are ids, not env config, because they are single shared locations that
 * every tenant's sync reads — there is nothing per-environment about them, and
 * leaving them only in the n8n schedule's request body means the repo can't tell
 * you what the sync actually points at.
 */

/**
 * The shared "ORG - Client - Wishlist" list (Delivery space `90127425952`,
 * `Forms` folder `901211070729`). Every client's intake-form submissions land
 * here together and are routed per-task by the "Client Group" custom field.
 *
 * Do NOT point the wishlist sync at a per-client mirror list (`KEN - Wishlist`
 * `901218210637`, `ABL - Wishlist`, `JFX - Wishlist`, `TCC - Wishlist`). Those are
 * ClickUp-automation copies created ~1.2s after the original by `ClickBot`, they
 * carry DIFFERENT task ids (so syncing both duplicates every row), and their
 * descriptions are EMPTY — the request detail exists only on the shared list.
 * `isProjectList` in mapper.ts already excludes them from the delivery sweep.
 */
export const WISHLIST_LIST_ID = '901218207431';

/**
 * The shared "ORG - Client - Process List" (same `Forms` folder) — engagement /
 * process-onboarding submissions, also routed per-task by Client Group.
 */
export const PROCESS_LIST_ID = '901218190381';

/**
 * "Case Study Library" folder. Hardcoded rather than env-configured because it
 * lives in a "Shared with me" space the service account cannot enumerate — it
 * has folder-level access only, so the folder id cannot be discovered at runtime.
 */
export const CASE_STUDY_FOLDER_ID = '90129732418';

/**
 * Monthly report folders are deliberately NOT listed here.
 *
 * Each client has its own "Monthly Progress Reports" folder in the Delivery
 * space (ABL `901212877810`, TRO `901212877735`, JFX `901212877721`,
 * KEN `901212877607`, TCC `901212877707` as of 2026-08-07), holding one Doc per
 * month. Unlike the shared lists above, these are per-tenant, so the mapping
 * belongs to the tenant: `core.tenants.clickup_reports_folder_id`, set through
 * `PUT /admin/clients/:id/clickup-mapping`. Hardcoding them here as well would
 * be a second source of truth that silently disagrees the first time a client is
 * added or a folder is moved.
 *
 * Note the folders are SIBLINGS of the client folders, not children — ClickUp
 * cannot nest folders — and all five carry the identical name, so neither the
 * folder name nor `clickup_folder_id` can route a Doc to a tenant.
 */

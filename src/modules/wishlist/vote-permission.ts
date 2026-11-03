/**
 * Who may cast or retract a wishlist vote.
 *
 * Client admins (and Aidapt platform staff, who resolve to `super_admin`) always
 * can. A plain `member` can only when Aidapt has switched on `members_can_vote`
 * for that client (portal.wishlist_settings, migration 0048).
 */
export function canCastVote(role: string, membersCanVote: boolean): boolean {
  return role === 'admin' || role === 'super_admin' || (role === 'member' && membersCanVote);
}

/** Roles that vote regardless of the per-client switch. */
export function votesAlways(role: string): boolean {
  return role === 'admin' || role === 'super_admin';
}

/**
 * Why an item can no longer take votes because it already is a project: linked to
 * a delivery project, or moved to a delivery state by staff. Null when votable.
 * Existing votes are kept as history; they are simply no longer competing.
 */
export function projectConflict(item: {
  project_list_id: string | null;
  state: string;
}): string | null {
  if (item.project_list_id !== null || item.state === 'in_progress' || item.state === 'shipped') {
    return 'This request is already a project, so it is no longer up for vote';
  }
  return null;
}

/**
 * Role hierarchy used for capability gating (design §2.5).
 *
 * Three roles, deliberately 1:1 with the LMS's own vocabulary so a role means
 * the same thing in every Aidapt app. The previous ladder
 * (member/member_plus/member_pro/org_admin) collapsed three ways on the way out
 * — all three "member_*" tiers became a single LMS `member` — and `org_admin`
 * mapped to an `admin` the LMS then rejected outright, so its highest client
 * role could never be provisioned there at all.
 *
 * `member_plus`, `member_pro` and `org_admin` all folded into `admin`
 * (migration 0031).
 */
export const ROLE_RANK = {
  member: 1, // read-only: wishlist, pod, notifications
  admin: 2, // the client's own admin: full portal + invite/manage own org
  super_admin: 99, // Aidapt platform staff (cross-tenant)
} as const;

export type RoleName = keyof typeof ROLE_RANK;

export function meetsRole(role: RoleName, min: RoleName): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

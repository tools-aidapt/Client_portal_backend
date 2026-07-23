/** Role hierarchy used for capability gating (design §2.5). */
export const ROLE_RANK = {
  member: 1,
  member_plus: 2,
  member_pro: 3,
  super_admin: 99,
} as const;

export type RoleName = keyof typeof ROLE_RANK;

export function meetsRole(role: RoleName, min: RoleName): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

import { z } from 'zod';

// A bare domain like "kenafric.com" (no scheme, no path).
const domain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'Must be a bare domain, e.g. acme.com');

export const registerClientBody = z.object({
  name: z.string().trim().min(1).max(200),
  email_domains: z.array(domain).min(1).max(20),
  product_tier: z.string().trim().max(100).optional(),
  clickup_folder_id: z.string().trim().max(64).optional(),
  clickup_client_group: z.string().trim().max(200).optional(),
  admin_email: z.string().trim().toLowerCase().email(),
  sigma_ready: z.boolean().default(false),
});

export const tenantIdParam = z.object({
  id: z.string().uuid(),
});

export const updateClientBody = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    product_tier: z.string().trim().max(100).optional(),
    status: z.enum(['prospect', 'onboarding', 'active', 'offboarded']).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'No fields to update' });

// --- Members of one client's account ---

/**
 * The roles that mean something *inside* one client's account.
 *
 * `super_admin` is deliberately absent. It is platform-wide Aidapt staff
 * access (it also sets `profiles.is_platform_admin` at registration), which is
 * a categorically heavier grant than "add this person to this client" — so it
 * is not reachable from anything scoped to a single tenant. Granting it stays
 * on `POST /admin/clients/:id/invitations`, whose own validator still allows
 * it as the one deliberate path.
 */
export const TENANT_ROLES = ['member', 'member_plus', 'member_pro', 'org_admin'] as const;

/**
 * A role a tenant-scoped endpoint may set. Rejects `super_admin` by name
 * first, so the caller gets "that's the wrong endpoint" rather than a generic
 * "invalid enum value" listing four roles and leaving them to infer why the
 * fifth one they know exists isn't there.
 */
const tenantScopedRole = z
  .string()
  .refine((role) => role !== 'super_admin', {
    message:
      'super_admin is platform-wide access, not a role within one client — use the invitations endpoint',
  })
  .pipe(z.enum(TENANT_ROLES));

export const memberParams = tenantIdParam.extend({ userId: z.string().uuid() });

export const updateMemberBody = z
  .object({
    role: tenantScopedRole.optional(),
    // Mirrors `core.membership_status`. `suspended` is how access is revoked —
    // deleting the row would erase the fact the membership ever existed.
    status: z.enum(['invited', 'active', 'suspended']).optional(),
  })
  .refine((b) => b.role !== undefined || b.status !== undefined, {
    message: 'Provide a role, a status, or both',
  });

export type RegisterClientBody = z.infer<typeof registerClientBody>;
export type TenantRole = (typeof TENANT_ROLES)[number];
export type UpdateMemberBody = z.infer<typeof updateMemberBody>;
export type MembershipStatus = NonNullable<UpdateMemberBody['status']>;

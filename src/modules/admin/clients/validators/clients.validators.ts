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
 * access (it also sets `profiles.is_platform_admin`), which is a categorically
 * heavier grant than "add this person to this client" — so it is never a role
 * a customer's account can hold. It is grantable only inside Aidapt's own
 * client group, via `ASSIGNABLE_ROLES` below.
 */
export const TENANT_ROLES = ['member', 'admin'] as const;

/**
 * Every role a membership may hold, including the platform one.
 *
 * `super_admin` is Aidapt staff access (it also drives
 * `profiles.is_platform_admin`), so it is grantable ONLY inside Aidapt's own
 * client group. That is a fact about the tenant, not about the request body,
 * so the schema accepts the value and `membersController.update` refuses it
 * for every tenant where `is_protected` is false. Doing it there rather than
 * here is what lets the error say *why* — a zod enum can only say "invalid".
 */
export const ASSIGNABLE_ROLES = ['member', 'admin', 'super_admin'] as const;

export const memberParams = tenantIdParam.extend({ userId: z.string().uuid() });

export const updateMemberBody = z
  .object({
    role: z.enum(ASSIGNABLE_ROLES).optional(),
    // Mirrors `core.membership_status`. `suspended` is how access is revoked —
    // deleting the row would erase the fact the membership ever existed.
    status: z.enum(['invited', 'active', 'suspended']).optional(),
  })
  .refine((b) => b.role !== undefined || b.status !== undefined, {
    message: 'Provide a role, a status, or both',
  });

export type RegisterClientBody = z.infer<typeof registerClientBody>;
export type TenantRole = (typeof TENANT_ROLES)[number];
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];
export type UpdateMemberBody = z.infer<typeof updateMemberBody>;
export type MembershipStatus = NonNullable<UpdateMemberBody['status']>;

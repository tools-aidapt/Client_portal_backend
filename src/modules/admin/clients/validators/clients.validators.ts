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

export type RegisterClientBody = z.infer<typeof registerClientBody>;

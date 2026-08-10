import { z } from 'zod';

/**
 * Mirrors the "Client Group" custom field options on the shared wishlist
 * ClickUp list (fetched directly from ClickUp on 2026-08-10). This is the
 * text n8n's workflow matches to route the created task's Client Group field
 * — the same free-text company value the public intake form sends — so these
 * must stay in sync with ClickUp by hand; there is no live lookup at request
 * time.
 */
export const CLIENT_GROUPS = [
  'Aidapt',
  'Allied Bank',
  'Auto Audit Group',
  'BankIslami',
  'Habib Bank Limited',
  'JewelFX',
  'Kenafric Group',
  'Tile Centre Group',
  'Trolley',
  'Vivo Fashion Group',
] as const;

export const createWishlistItemBody = z.object({
  client_group: z.enum(CLIENT_GROUPS),
  submitter_name: z.string().trim().min(1).max(200),
  submitter_role: z.string().trim().max(200).default(''),
  submitter_email: z.string().trim().toLowerCase().email(),
  title: z.string().trim().min(1).max(300),
  problem: z.string().trim().min(1).max(4000),
  who_feels_pain: z.string().trim().max(300).default(''),
  urgency: z.string().trim().min(1).max(200),
  notes: z.string().trim().max(4000).default(''),
});

export type CreateWishlistItemBody = z.infer<typeof createWishlistItemBody>;

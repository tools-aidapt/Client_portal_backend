import { z } from 'zod';

export const acceptInvitationBody = z.object({
  token: z.string().trim().min(1),
});

export type AcceptInvitationBody = z.infer<typeof acceptInvitationBody>;

const email = z.string().trim().toLowerCase().email();
const password = z.string().min(8).max(128);

// Shared profile fields collected at registration and editable via PATCH /auth/me.
const profileFields = {
  fullName: z.string().trim().min(1).max(200).optional(),
  jobTitle: z.string().trim().max(200).optional(),
  department: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(40).optional(),
  avatarUrl: z.string().url().max(2000).optional(),
  interests: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
  locale: z.string().trim().max(10).optional(),
};

// Registration is invitation-only: the email comes from the invitation (so a
// user can only register into the org they were invited to).
export const registerBody = z.object({
  token: z.string().trim().min(1),
  password,
  ...profileFields,
  fullName: z.string().trim().min(1).max(200), // required at registration
});

export type RegisterBody = z.infer<typeof registerBody>;

export const updateProfileBody = z
  .object(profileFields)
  .refine((b) => Object.keys(b).length > 0, { message: 'No profile fields to update' });

export type UpdateProfileBody = z.infer<typeof updateProfileBody>;

export const loginBody = z.object({
  email,
  password: z.string().min(1).max(128),
});

export type LoginBody = z.infer<typeof loginBody>;

export const refreshBody = z.object({
  refreshToken: z.string().trim().min(1),
});

export type RefreshBody = z.infer<typeof refreshBody>;

export const logoutBody = z.object({
  refreshToken: z.string().trim().min(1),
});

export type LogoutBody = z.infer<typeof logoutBody>;

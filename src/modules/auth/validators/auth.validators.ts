import { z } from 'zod';

export const acceptInvitationBody = z.object({
  token: z.string().trim().min(1),
});

export type AcceptInvitationBody = z.infer<typeof acceptInvitationBody>;

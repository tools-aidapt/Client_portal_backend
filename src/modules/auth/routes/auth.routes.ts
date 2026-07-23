import { Router } from 'express';
import { asyncHandler } from '@common/utils/async-handler.js';
import { authenticate } from '@/api/middlewares/authenticate.js';
import { validate } from '@/api/middlewares/validate.js';
import { authController } from '../controllers/auth.controller.js';
import { acceptInvitationBody } from '../validators/auth.validators.js';

/**
 * Identity endpoints (design §10.1). Sign-in/OTP itself is handled by Supabase
 * Auth on the client; these are the server-side identity helpers.
 */
export const authRoutes = Router();

// Profile + memberships + which apps the caller can open.
authRoutes.get('/me', authenticate, asyncHandler(authController.me));

/**
 * Invitation acceptance (design §9.3 / §10.3). The caller must already be
 * authenticated (they've completed OTP); the invitation is matched to their
 * email. Mounted at /invitations by the root router.
 */
export const invitationRoutes = Router();

invitationRoutes.post(
  '/accept',
  authenticate,
  validate({ body: acceptInvitationBody }),
  asyncHandler(authController.acceptInvitation),
);

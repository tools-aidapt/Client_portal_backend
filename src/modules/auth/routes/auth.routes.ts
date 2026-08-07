import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { asyncHandler } from '@common/utils/async-handler.js';
import { BadRequestError } from '@common/errors/index.js';
import { authenticate } from '@/api/middlewares/authenticate.js';
import { requireTenantRole } from '@/api/middlewares/tenant.js';
import { validate } from '@/api/middlewares/validate.js';
import { authController } from '../controllers/auth.controller.js';
import { invitationsController } from '@modules/invitations/invitations.controller.js';
import {
  acceptInvitationBody,
  loginBody,
  logoutBody,
  otpRequestBody,
  otpVerifyBody,
  refreshBody,
  registerBody,
  updateProfileBody,
} from '../validators/auth.validators.js';

/**
 * Identity endpoints (design §10.1). Self-hosted JWT auth: register/login issue
 * a short-lived access token + a rotating refresh token; refresh exchanges and
 * rotates; logout revokes.
 */
export const authRoutes = Router();

// Credential sign-up / sign-in.
authRoutes.post('/register', validate({ body: registerBody }), asyncHandler(authController.register));
authRoutes.post('/login', validate({ body: loginBody }), asyncHandler(authController.login));

// Passwordless sign-in — optional alternative to /login, not a replacement.
authRoutes.post(
  '/otp/request',
  validate({ body: otpRequestBody }),
  asyncHandler(authController.requestOtp),
);
authRoutes.post(
  '/otp/verify',
  validate({ body: otpVerifyBody }),
  asyncHandler(authController.verifyOtp),
);

// Rotate a refresh token for a new token pair.
authRoutes.post('/refresh', validate({ body: refreshBody }), asyncHandler(authController.refresh));

// Revoke the presented refresh token (this device) / all tokens (needs auth).
authRoutes.post('/logout', validate({ body: logoutBody }), asyncHandler(authController.logout));
authRoutes.post('/logout-all', authenticate, asyncHandler(authController.logoutAll));

// Profile + memberships + which apps the caller can open.
authRoutes.get('/me', authenticate, asyncHandler(authController.me));
authRoutes.patch(
  '/me',
  authenticate,
  validate({ body: updateProfileBody }),
  asyncHandler(authController.updateMe),
);

// Avatar upload (multipart form field "file", images only, max 2MB).
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new BadRequestError('Only image files are allowed'));
  },
});
authRoutes.post(
  '/me/avatar',
  authenticate,
  avatarUpload.single('file'),
  asyncHandler(authController.uploadAvatar),
);

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

/**
 * Org-admin invite: a MemberPro invites a teammate into their OWN tenant.
 * Cannot grant super_admin (platform-staff only, via the admin endpoint).
 */
invitationRoutes.post(
  '/',
  authenticate,
  requireTenantRole('org_admin'),
  validate({
    body: z.object({
      email: z.string().trim().toLowerCase().email(),
      role: z.enum(['member', 'member_plus', 'member_pro', 'org_admin']).default('member'),
    }),
  }),
  asyncHandler(invitationsController.inviteToMyOrg),
);

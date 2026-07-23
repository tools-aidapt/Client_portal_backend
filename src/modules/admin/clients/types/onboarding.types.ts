/** Input to the client-registration orchestration (POST /admin/clients). */
export interface RegisterClientInput {
  name: string;
  emailDomains: string[];
  productTier?: string;
  clickupFolderId?: string;
  clickupClientGroup?: string;
  adminEmail: string;
  sigmaReady: boolean;
}

export interface RegisterClientResult {
  tenantId: string;
  onboardingId: string;
  slug: string;
}

/** Ordered internal steps written atomically during registration. */
export const ONBOARDING_STEPS = [
  'create_tenant',
  'link_clickup',
  'configure_domains',
  'provision_portal',
  'provision_lms',
  'provision_support',
  'create_admin_invitation',
  'open_first_cycle',
] as const;

export type OnboardingStepKey = (typeof ONBOARDING_STEPS)[number];

/** External side effects enqueued to the outbox and drained asynchronously. */
export type OutboxEventType =
  | 'clickup.provision_folder'
  | 'email.invite'
  | 'n8n.trigger_sync'
  | 'storage.init';

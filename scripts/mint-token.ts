/** Throwaway: print a Kenafric member_pro access token for browser smoke tests. */
import 'dotenv/config';
import { signAccessToken } from '../src/modules/auth/utils/tokens.js';

const TENANT = '01176988-95b1-44d5-851b-c5e3d52bfe66';
const USER = '933d55ea-c42e-48a1-9dd4-703fa40888b9';
process.stdout.write(
  signAccessToken(USER, 'smoke@aidapt.co', {
    platform_admin: false,
    tenant_roles: { [TENANT]: 'member_pro' },
  }),
);

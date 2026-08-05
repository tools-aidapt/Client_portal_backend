import bcrypt from 'bcryptjs';
import { config } from '@config/index.js';

/** Hashes a plaintext password with the configured bcrypt cost. */
export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, config.auth.bcryptRounds);
}

/** Constant-time comparison of a plaintext password against a stored hash. */
export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

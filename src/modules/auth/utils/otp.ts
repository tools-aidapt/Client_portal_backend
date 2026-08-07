import { createHash, randomInt } from 'node:crypto';

/** A fresh 6-digit numeric code (000000–999999, zero-padded). */
export function generateOtpCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/**
 * SHA-256 of an OTP code. Codes are short-lived (minutes) and attempt-limited,
 * so a fast hash is fine here — the same posture as refresh token hashing.
 */
export function hashOtpCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/** Constant-time-enough comparison via hash equality (codes are single-use anyway). */
export function verifyOtpCode(code: string, hash: string): boolean {
  return hashOtpCode(code) === hash;
}

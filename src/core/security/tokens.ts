/**
 * Opaque high-entropy tokens (refresh, verification, reset, invite) and their storage hashes —
 * AUTHENTICATION_AUTHORIZATION.md §6.2, §9.2. Only the hash is persisted.
 */
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** 32 random bytes, base64url (43 chars, 256 bits). */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * SHA-256 hex (64 chars, fits `CHAR(64)`). With a pepper, HMAC-SHA-256 is used instead
 * (`REFRESH_TOKEN_PEPPER`), so a database leak without the pepper yields nothing usable.
 */
export function hashToken(token: string, pepper?: string): string {
  if (pepper === undefined) return createHash('sha256').update(token, 'utf8').digest('hex');
  return createHmac('sha256', pepper).update(token, 'utf8').digest('hex');
}

/** Numeric OTP from a CSPRNG (§6.3). */
export function generateOtp(length = 6): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += String(randomInt(0, 10));
  return out;
}

/** Constant-time comparison of two hex digests of equal length. */
export function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

/** Short stable hash of a user agent (grace-window comparison, §9.5). */
export function userAgentFingerprint(userAgent: string | undefined): string {
  return createHash('sha256')
    .update(userAgent ?? '', 'utf8')
    .digest('hex')
    .slice(0, 16);
}

/**
 * TOTP (RFC 6238) for staff MFA — AUTHENTICATION_AUTHORIZATION.md §13, decision OQ-30:
 * 6 digits, 30 s step, ±1 step tolerance, HMAC-SHA-1 (authenticator compatibility).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32.charAt((value << (5 - bits)) & 31);
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error('Invalid base32 secret.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** 160-bit secret, base32 (32 chars). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(message).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const code =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    ((digest[offset + 1] ?? 0) << 16) |
    ((digest[offset + 2] ?? 0) << 8) |
    (digest[offset + 3] ?? 0);
  return String(code % 10 ** digits).padStart(digits, '0');
}

export function totpStep(now: Date, stepSeconds = 30): number {
  return Math.floor(now.getTime() / 1000 / stepSeconds);
}

/**
 * Returns the matched time step (for replay protection — the caller rejects a step ≤ the last
 * accepted one) or `undefined`.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  now: Date,
  window = 1,
): number | undefined {
  if (!/^\d{6}$/.test(code)) return undefined;
  const secret = base32Decode(secretBase32);
  const current = totpStep(now);
  for (let delta = -window; delta <= window; delta += 1) {
    const candidate = hotp(secret, current + delta);
    if (timingSafeEqual(Buffer.from(candidate), Buffer.from(code))) return current + delta;
  }
  return undefined;
}

export function otpauthUri(issuer: string, account: string, secretBase32: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

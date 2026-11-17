import { randomBytes } from 'node:crypto';

// Crockford base32 alphabet used by the ULID spec.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Generates a ULID (48-bit millisecond timestamp + 80 bits of randomness, 26 characters).
 * Used for request IDs (`req_<ULID>`, BACKEND_STRUCTURE.md §5.1). Pure apart from the clock and
 * CSPRNG; `now` can be injected for tests.
 */
export function ulid(now: number = Date.now()): string {
  let time = '';
  let remaining = Math.floor(now);
  for (let i = 0; i < 10; i += 1) {
    time = ALPHABET.charAt(remaining % 32) + time;
    remaining = Math.floor(remaining / 32);
  }

  const bytes = randomBytes(16);
  let random = '';
  for (let i = 0; i < 16; i += 1) {
    random += ALPHABET.charAt((bytes[i] ?? 0) % 32);
  }
  return time + random;
}

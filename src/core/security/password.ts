/**
 * Password hashing and policy — AUTHENTICATION_AUTHORIZATION.md §4, decision C3 (Argon2id via
 * the native `argon2` package, OWASP baseline m=19456 KiB, t=2, p=1).
 *
 * Policy (§4.2): 10–128 characters, NFC-normalised, no composition rules, context check (email
 * local part / names / brand placeholder), small offline common-password list. The breached-
 * password range API (HIBP) is an external call and is NOT wired: it needs an outbound-network
 * decision; recorded as a deferred item in the B1 report.
 */
import { createHmac } from 'node:crypto';

import argon2 from 'argon2';

export interface PasswordHasherOptions {
  readonly memoryKib: number;
  readonly iterations: number;
  readonly pepper: string | undefined;
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
  needsRehash(hash: string): boolean;
  /** Burns equivalent time when the account does not exist (timing-safe login, §4.1). */
  verifyDummy(password: string): Promise<void>;
}

function prepare(password: string, pepper: string | undefined): string {
  const normalized = password.normalize('NFC');
  if (pepper === undefined) return normalized;
  return createHmac('sha256', pepper).update(normalized, 'utf8').digest('base64');
}

export function createPasswordHasher(options: PasswordHasherOptions): PasswordHasher {
  const params = {
    type: argon2.argon2id,
    memoryCost: options.memoryKib,
    timeCost: options.iterations,
    parallelism: 1,
  } as const;
  let dummyHash: Promise<string> | undefined;

  return {
    async hash(password) {
      return argon2.hash(prepare(password, options.pepper), params);
    },
    async verify(hash, password) {
      try {
        return await argon2.verify(hash, prepare(password, options.pepper));
      } catch {
        return false;
      }
    },
    needsRehash(hash) {
      return argon2.needsRehash(hash, params);
    },
    async verifyDummy(password) {
      dummyHash ??= argon2.hash('dummy-password-for-timing', params);
      await argon2.verify(await dummyHash, prepare(password, options.pepper)).catch(() => false);
    },
  };
}

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

/** Offline fallback list (§4.2 "common-password list"); extend with the top-10k list when sourced. */
const COMMON_PASSWORDS = new Set([
  '1234567890',
  '0123456789',
  '12345678910',
  'qwertyuiop',
  'password123',
  'password1234',
  'iloveyou123',
  'qwerty12345',
  'abcdefghij',
  '1q2w3e4r5t',
  'administrator',
  'welcome1234',
  'letmein1234',
  'passw0rd123',
  'aaaaaaaaaa',
  '1111111111',
]);

export interface PasswordContext {
  readonly email?: string | undefined;
  readonly firstName?: string | undefined;
  readonly lastName?: string | undefined;
}

/** Returns a user-facing problem message, or `undefined` when the password is acceptable. */
export function checkPasswordPolicy(
  password: string,
  context: PasswordContext = {},
): string | undefined {
  const normalized = password.normalize('NFC');
  // Count user-perceived characters (grapheme clusters), not UTF-16 units.
  let length = 0;
  for (const _segment of new Intl.Segmenter().segment(normalized)) length += 1;
  if (length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (length > PASSWORD_MAX_LENGTH) {
    return `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`;
  }
  const lower = normalized.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) return 'This password is too common. Please choose another.';
  const fragments = [
    context.email?.split('@')[0],
    context.firstName,
    context.lastName,
    '[brand_name]',
  ]
    .map((value) => value?.trim().toLowerCase())
    .filter((value): value is string => value !== undefined && value.length >= 3);
  if (fragments.some((fragment) => lower.includes(fragment))) {
    return 'Password must not contain your name or email address.';
  }
  return undefined;
}

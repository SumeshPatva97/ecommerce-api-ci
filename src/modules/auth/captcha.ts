/**
 * Provider-agnostic CAPTCHA — AUTHENTICATION_AUTHORIZATION.md §12.3, decision OQ-71 / D-48.
 *
 * The THRESHOLD logic is real (per-IP failure counter, per-account flag for 24 h after a lockout);
 * the provider is `none` until a vendor is chosen, so verification is a no-op adapter that accepts
 * every request. Swapping in a vendor = a new `CaptchaVerifier`; callers do not change.
 *
 * LIMITATION — counters live in the in-memory KeyValueStore (D-38): single instance only.
 */
import { AppError } from '../../core/errors/AppError.js';
import type { KeyValueStore } from '../../core/store/memoryStore.js';

export interface CaptchaVerifier {
  readonly provider: string;
  verify(token: string | undefined, ip: string | undefined): Promise<boolean>;
}

/** `CAPTCHA_PROVIDER=none`: verification is a no-op (accepts), thresholds still evaluated. */
export const noopCaptchaVerifier: CaptchaVerifier = {
  provider: 'none',
  verify: () => Promise.resolve(true),
};

export function createCaptchaVerifier(_provider: 'none'): CaptchaVerifier {
  // Only `none` exists until a vendor is chosen (OQ-71); add adapters here.
  return noopCaptchaVerifier;
}

export interface CaptchaPolicy {
  /** True when the next attempt from this IP / for this account must carry a CAPTCHA. */
  isRequired(ip: string | undefined, userId?: string): boolean;
  recordIpFailure(ip: string | undefined): void;
  flagAccount(userId: string): void;
  /** Throws 422 `captchaToken` when required and the provider rejects the token. */
  enforce(
    ip: string | undefined,
    userId: string | undefined,
    token: string | undefined,
  ): Promise<void>;
}

export const CAPTCHA_IP_THRESHOLD = 3;
const IP_WINDOW_SECONDS = 3600;
const ACCOUNT_FLAG_SECONDS = 24 * 3600;

export function createCaptchaPolicy(
  store: KeyValueStore,
  verifier: CaptchaVerifier,
  scope: 'customer' | 'staff',
): CaptchaPolicy {
  const ipKey = (ip: string | undefined): string => `captcha:${scope}:ip:${ip ?? 'unknown'}`;
  const accountKey = (userId: string): string => `captcha:${scope}:acct:${userId}`;

  const policy: CaptchaPolicy = {
    isRequired(ip, userId) {
      const failures = store.get(ipKey(ip));
      if (typeof failures === 'number' && failures >= CAPTCHA_IP_THRESHOLD) return true;
      return userId !== undefined && store.get(accountKey(userId)) === true;
    },
    recordIpFailure(ip) {
      store.increment(ipKey(ip), IP_WINDOW_SECONDS);
    },
    flagAccount(userId) {
      store.set(accountKey(userId), true, ACCOUNT_FLAG_SECONDS);
    },
    async enforce(ip, userId, token) {
      if (!policy.isRequired(ip, userId)) return;
      const valid = await verifier.verify(token, ip);
      if (!valid) {
        throw new AppError('VALIDATION_ERROR', undefined, {
          details: [
            {
              field: 'captchaToken',
              code: 'CAPTCHA_FAILED',
              message: 'Please complete the verification challenge.',
            },
          ],
        });
      }
    },
  };
  return policy;
}

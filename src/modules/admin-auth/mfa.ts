/**
 * Staff MFA (TOTP) — AUTHENTICATION_AUTHORIZATION.md §13, decision OQ-30 / D-45 (TOTP, mandatory
 * for Superadmin and Admin, no "trust this browser" — D-51).
 *
 * - Login step-up challenge: random id, 5-minute TTL, single use, bound to IP + UA fingerprint,
 *   invalidated after 5 wrong codes (each wrong code also counts toward account lockout).
 * - TOTP secret is stored encrypted (`users.mfa_secret_encrypted`, AES-256-GCM via FieldCipher).
 * - Replay protection: a code whose time step is ≤ the last accepted step for the user is
 *   rejected. The last step is kept in the memory store.
 *
 * LIMITATION (D-38 / OQ-35): challenges, last-step markers and enrolment tokens live in the
 * in-memory KeyValueStore — valid for ONE instance only (a multi-instance deployment needs Redis;
 * a restart drops pending challenges, which only forces the user to log in again).
 *
 * Recovery codes are NOT implemented: the approved schema has no table/column for them (deferred,
 * PHASE4 decision log §4).
 */
import { randomUUID } from 'node:crypto';

import type { FieldCipher } from '../../core/security/fieldCipher.js';
import {
  generateOpaqueToken,
  hashToken,
  userAgentFingerprint,
} from '../../core/security/tokens.js';
import { generateTotpSecret, otpauthUri, verifyTotp } from '../../core/security/totp.js';
import type { KeyValueStore } from '../../core/store/memoryStore.js';

export const MFA_CHALLENGE_TTL_SECONDS = 300;
export const MFA_MAX_FAILURES = 5;
const LAST_STEP_TTL_SECONDS = 180; // > (±1 step tolerance + current step) × 30 s
const ENROLLMENT_TTL_SECONDS = 15 * 60;

export interface MfaChallenge {
  readonly id: string;
  readonly userId: string;
  readonly ip: string | undefined;
  readonly uaFingerprint: string;
  readonly expiresAt: number;
  failures: number;
}

export interface MfaService {
  createChallenge(
    userId: string,
    ip: string | undefined,
    userAgent: string | undefined,
  ): MfaChallenge;
  /** The live challenge if it exists and is bound to this IP + UA. */
  getChallenge(
    id: string,
    ip: string | undefined,
    userAgent: string | undefined,
  ): MfaChallenge | undefined;
  /** Counts a wrong code; returns true when the challenge is now invalidated. */
  recordFailure(challenge: MfaChallenge): boolean;
  consumeChallenge(challenge: MfaChallenge): void;
  /** Verifies a TOTP code against the encrypted secret with replay protection. */
  verifyCode(userId: string, encryptedSecret: string, code: string): boolean;
  /** Low-level enrolment helper (secret, otpauth URI, ciphertext); routes use startPendingEnrollment. */
  beginEnrollment(accountLabel: string): {
    readonly secret: string;
    readonly otpauthUri: string;
    readonly encryptedSecret: string;
  };
  /** One-time enrolment token handed out by accept-invite / login when MFA is mandatory. */
  issueEnrollmentToken(userId: string): string;
  /** Resolves (and consumes) an enrolment token. */
  redeemEnrollmentToken(token: string): string | undefined;
  /** Resolves an enrolment token WITHOUT consuming it (enroll step; confirm consumes). */
  peekEnrollmentToken(token: string): string | undefined;
  /**
   * Starts (or restarts) a pending enrolment: a fresh secret is kept ENCRYPTED in the memory store
   * for 15 min and nothing is written to the database until `verifyPending` succeeds. Calling it
   * again replaces the previous pending secret (an abandoned QR code stops working).
   */
  startPendingEnrollment(
    userId: string,
    accountLabel: string,
  ): { readonly secret: string; readonly otpauthUri: string; readonly expiresIn: number };
  /**
   * Verifies a code against the pending secret. `OK` returns the ciphertext to persist and clears
   * the pending state. 5 wrong codes discard the pending secret (`EXPIRED`).
   */
  verifyPending(
    userId: string,
    code: string,
  ):
    | { readonly status: 'OK'; readonly encryptedSecret: string }
    | { readonly status: 'INVALID' | 'EXPIRED' | 'NONE' };
}

interface PendingEnrollment {
  readonly encryptedSecret: string;
  readonly expiresAt: number;
  failures: number;
}

export function createMfaService(deps: {
  readonly store: KeyValueStore;
  readonly cipher: FieldCipher;
  readonly clock: () => Date;
  readonly issuer: string;
  readonly pepper: string | undefined;
}): MfaService {
  const { store, cipher, clock } = deps;
  const challengeKey = (id: string): string => `mfa:challenge:${id}`;
  const lastStepKey = (userId: string): string => `mfa:laststep:${userId}`;
  const enrollKey = (token: string): string => `mfa:enroll:${hashToken(token, deps.pepper)}`;
  const pendingKey = (userId: string): string => `mfa:pending:${userId}`;

  const remaining = (challenge: MfaChallenge): number =>
    Math.max(1, Math.ceil((challenge.expiresAt - clock().getTime()) / 1000));

  return {
    createChallenge(userId, ip, userAgent) {
      const challenge: MfaChallenge = {
        id: randomUUID(),
        userId,
        ip,
        uaFingerprint: userAgentFingerprint(userAgent),
        expiresAt: clock().getTime() + MFA_CHALLENGE_TTL_SECONDS * 1000,
        failures: 0,
      };
      store.set(challengeKey(challenge.id), challenge, MFA_CHALLENGE_TTL_SECONDS);
      return challenge;
    },

    getChallenge(id, ip, userAgent) {
      const challenge = store.get(challengeKey(id)) as MfaChallenge | undefined;
      if (challenge === undefined) return undefined;
      if (challenge.ip !== ip || challenge.uaFingerprint !== userAgentFingerprint(userAgent)) {
        return undefined;
      }
      return challenge;
    },

    recordFailure(challenge) {
      challenge.failures += 1;
      if (challenge.failures >= MFA_MAX_FAILURES) {
        store.delete(challengeKey(challenge.id));
        return true;
      }
      store.set(challengeKey(challenge.id), challenge, remaining(challenge));
      return false;
    },

    consumeChallenge(challenge) {
      store.delete(challengeKey(challenge.id));
    },

    verifyCode(userId, encryptedSecret, code) {
      let secret: string;
      try {
        secret = cipher.decrypt(encryptedSecret);
      } catch {
        return false;
      }
      const step = verifyTotp(secret, code, clock());
      if (step === undefined) return false;
      const last = store.get(lastStepKey(userId));
      if (typeof last === 'number' && step <= last) return false; // replay
      store.set(lastStepKey(userId), step, LAST_STEP_TTL_SECONDS);
      return true;
    },

    beginEnrollment(accountLabel) {
      const secret = generateTotpSecret();
      return {
        secret,
        otpauthUri: otpauthUri(deps.issuer, accountLabel, secret),
        encryptedSecret: cipher.encrypt(secret),
      };
    },

    issueEnrollmentToken(userId) {
      const token = generateOpaqueToken();
      store.set(enrollKey(token), userId, ENROLLMENT_TTL_SECONDS);
      return token;
    },

    redeemEnrollmentToken(token) {
      const key = enrollKey(token);
      const userId = store.get(key);
      store.delete(key);
      return typeof userId === 'string' ? userId : undefined;
    },

    peekEnrollmentToken(token) {
      const userId = store.get(enrollKey(token));
      return typeof userId === 'string' ? userId : undefined;
    },

    startPendingEnrollment(userId, accountLabel) {
      const secret = generateTotpSecret();
      const pending: PendingEnrollment = {
        encryptedSecret: cipher.encrypt(secret),
        expiresAt: clock().getTime() + ENROLLMENT_TTL_SECONDS * 1000,
        failures: 0,
      };
      store.set(pendingKey(userId), pending, ENROLLMENT_TTL_SECONDS);
      return {
        secret,
        otpauthUri: otpauthUri(deps.issuer, accountLabel, secret),
        expiresIn: ENROLLMENT_TTL_SECONDS,
      };
    },

    verifyPending(userId, code) {
      const key = pendingKey(userId);
      const pending = store.get(key) as PendingEnrollment | undefined;
      if (pending === undefined) return { status: 'NONE' };
      let secret: string;
      try {
        secret = cipher.decrypt(pending.encryptedSecret);
      } catch {
        store.delete(key);
        return { status: 'NONE' };
      }
      const step = verifyTotp(secret, code, clock());
      const last = store.get(lastStepKey(userId));
      if (step === undefined || (typeof last === 'number' && step <= last)) {
        pending.failures += 1;
        if (pending.failures >= MFA_MAX_FAILURES) {
          store.delete(key);
          return { status: 'EXPIRED' };
        }
        const ttl = Math.max(1, Math.ceil((pending.expiresAt - clock().getTime()) / 1000));
        store.set(key, pending, ttl);
        return { status: 'INVALID' };
      }
      store.set(lastStepKey(userId), step, LAST_STEP_TTL_SECONDS);
      store.delete(key);
      return { status: 'OK', encryptedSecret: pending.encryptedSecret };
    },
  };
}

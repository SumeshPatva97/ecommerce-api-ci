/**
 * Password verification with lockout, CAPTCHA thresholds and timing safety —
 * AUTHENTICATION_AUTHORIZATION.md §4.1, §7.1, §7.2, §12.
 *
 * - Unknown email / wrong account type / no password yet → dummy Argon2 verify, generic 401.
 * - Locked account → dummy verify (a correct password still fails), generic 401, audit `LOCKED`.
 * - Wrong password → `failed_login_count++`; at the threshold `locked_until = now + lock`, the
 *   counter restarts, the account is CAPTCHA-flagged for 24 h and the owner is emailed.
 * - Correct password but SUSPENDED/DISABLED → 403 FORBIDDEN (only after the password matched).
 *
 * Used by both login endpoints and by change-password / re-auth (failures count toward lockout).
 */
import type { AppContainer } from '../../container.js';
import { AppError } from '../../core/errors/AppError.js';
import { maskEmail } from '../../lib/redact.js';
import { addMinutes } from '../../lib/time.js';
import {
  ACCOUNT_TYPE,
  appBaseUrl,
  sendEmailSafe,
  userActor,
  type Audience,
  type RequestMeta,
} from './auth.context.js';
import { findUserByEmail, findUserById, type LoginUserRow } from './auth.repository.js';
import { createCaptchaPolicy, createCaptchaVerifier, type CaptchaPolicy } from './captcha.js';

export const INVALID_CREDENTIALS = 'Invalid email or password.';

export type FailureReason =
  'BAD_CREDENTIALS' | 'LOCKED' | 'INACTIVE' | 'CAPTCHA_FAILED' | 'MFA_FAILED';

export interface CredentialService {
  readonly captcha: CaptchaPolicy;
  /** Full login check; returns the user when the password is correct and the account may log in. */
  verifyLogin(input: {
    readonly email: string;
    readonly password: string;
    readonly captchaToken: string | undefined;
    readonly audience: Audience;
    readonly meta: RequestMeta;
  }): Promise<LoginUserRow>;
  /** Re-verifies the password of a signed-in user (change-password, re-auth). */
  verifyCurrentPassword(input: {
    readonly userId: string;
    readonly password: string;
    readonly audience: Audience;
    readonly meta: RequestMeta;
    readonly eventKey: string;
  }): Promise<LoginUserRow>;
  /** Records one failed factor for a known user (wrong password, wrong MFA code). */
  registerFailure(
    user: LoginUserRow,
    audience: Audience,
    meta: RequestMeta,
    reason: FailureReason,
    eventKey?: string,
  ): Promise<void>;
}

export function createCredentialService(
  container: AppContainer,
  audience: Audience,
): CredentialService {
  const { db, clock, config, passwords } = container;
  const policy = audience === 'admin' ? config.auth.lockout.staff : config.auth.lockout.customer;
  const captcha = createCaptchaPolicy(
    container.store,
    createCaptchaVerifier(config.auth.captchaProvider),
    audience === 'admin' ? 'staff' : 'customer',
  );

  const generic = (): AppError => new AppError('UNAUTHENTICATED', INVALID_CREDENTIALS);

  async function auditFailure(
    meta: RequestMeta,
    user: LoginUserRow | undefined,
    reason: FailureReason,
    eventKey: string,
    email?: string,
  ): Promise<void> {
    const actor = user === undefined ? meta.actor : userActor(meta, user.id, audience);
    await container.audit.recordSafe(db, actor, {
      action: 'LOGIN_FAILED',
      module: 'auth',
      entityType: 'User',
      entityId: user?.id ?? null,
      outcome: 'FAILURE',
      eventKey,
      diff: false,
      metadata: {
        reason,
        audience,
        ...(email === undefined ? {} : { email: maskEmail(email) }),
      },
    });
  }

  async function registerFailure(
    user: LoginUserRow,
    aud: Audience,
    meta: RequestMeta,
    reason: FailureReason,
    eventKey = 'auth.login_failed',
  ): Promise<void> {
    const now = clock();
    captcha.recordIpFailure(meta.ip);
    const attempts = user.failedLoginCount + 1;
    if (attempts >= policy.maxAttempts) {
      const lockedUntil = addMinutes(now, policy.lockMinutes);
      await db.user.update({
        where: { id: user.id },
        data: { failedLoginCount: 0, lockedUntil },
      });
      captcha.flagAccount(user.id);
      await container.audit.recordSafe(db, userActor(meta, user.id, aud), {
        action: 'LOGIN_FAILED',
        module: 'auth',
        entityType: 'User',
        entityId: user.id,
        outcome: 'FAILURE',
        eventKey: 'auth.account_locked',
        diff: false,
        metadata: { reason, audience: aud, lockedUntil: lockedUntil.toISOString() },
      });
      await sendEmailSafe(container, {
        to: user.email,
        subject: 'Unusual sign-in attempts on your account',
        templateKey: 'SECURITY_ALERT',
        variables: {
          firstName: user.firstName,
          reason: 'ACCOUNT_LOCKED',
          lockedUntil: lockedUntil.toISOString(),
          resetUrl: `${appBaseUrl(container, aud)}/forgot-password`,
        },
      });
      if (aud === 'admin') {
        container.logger.warn(
          { alert: 'staff_account_locked', userId: user.id },
          'staff account locked after repeated failures',
        );
      }
      return;
    }
    await db.user.update({
      where: { id: user.id },
      data: { failedLoginCount: { increment: 1 } },
    });
    await auditFailure(meta, user, reason, eventKey);
  }

  const isLocked = (user: LoginUserRow): boolean =>
    user.lockedUntil !== null && user.lockedUntil > clock();

  return {
    captcha,
    registerFailure,

    async verifyLogin({ email, password, captchaToken, meta }) {
      const user = await findUserByEmail(db, email);
      const usable =
        user !== null &&
        user.accountType === ACCOUNT_TYPE[audience] &&
        user.deletedAt === null &&
        user.passwordHash !== null;
      if (!usable) {
        await passwords.verifyDummy(password);
        captcha.recordIpFailure(meta.ip);
        await auditFailure(meta, undefined, 'BAD_CREDENTIALS', 'auth.login_failed', email);
        throw generic();
      }
      try {
        await captcha.enforce(meta.ip, user.id, captchaToken);
      } catch (error) {
        await auditFailure(meta, user, 'CAPTCHA_FAILED', 'auth.login_failed');
        throw error;
      }
      if (isLocked(user)) {
        await passwords.verifyDummy(password);
        await auditFailure(meta, user, 'LOCKED', 'auth.login_failed');
        throw generic();
      }
      const valid = await passwords.verify(user.passwordHash, password);
      if (!valid) {
        await registerFailure(user, audience, meta, 'BAD_CREDENTIALS');
        throw generic();
      }
      if (user.status === 'SUSPENDED' || user.status === 'DISABLED') {
        await auditFailure(meta, user, 'INACTIVE', 'auth.login_failed');
        throw new AppError('FORBIDDEN', 'Your account is not active. Please contact support.', {
          details: [
            {
              code: user.status === 'SUSPENDED' ? 'ACCOUNT_SUSPENDED' : 'ACCOUNT_DISABLED',
              message: 'Your account is not active. Please contact support.',
            },
          ],
        });
      }
      if (audience === 'admin' && user.status !== 'ACTIVE') {
        // Invited staff who have not accepted the invitation cannot log in (§3).
        await auditFailure(meta, user, 'INACTIVE', 'auth.login_failed');
        throw generic();
      }
      return user;
    },

    async verifyCurrentPassword({ userId, password, meta, eventKey }) {
      const user = await findUserById(db, userId);
      if (user?.passwordHash == null || user.deletedAt !== null) {
        await passwords.verifyDummy(password);
        throw new AppError('UNAUTHENTICATED', 'Please sign in to continue.');
      }
      if (isLocked(user)) {
        await passwords.verifyDummy(password);
        await auditFailure(meta, user, 'LOCKED', eventKey);
        throw new AppError('UNAUTHENTICATED', 'The password is incorrect.');
      }
      const valid = await passwords.verify(user.passwordHash, password);
      if (!valid) {
        await registerFailure(user, audience, meta, 'BAD_CREDENTIALS', eventKey);
        throw new AppError('UNAUTHENTICATED', 'The password is incorrect.');
      }
      return user;
    },
  };
}

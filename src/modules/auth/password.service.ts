/**
 * Forgot / reset / change password for both audiences — AUTHENTICATION_AUTHORIZATION.md §11.
 *
 * - forgot: enumeration-safe (the controller always answers 202 with the same body); a token is
 *   created only for an existing ACTIVE/PENDING account of the audience. TTL 30 min customer /
 *   15 min staff. A Superadmin without MFA gets no reset email (§11.1 → recovery procedure §21).
 * - reset: single-use token, policy check, revokes ALL sessions (`PASSWORD_CHANGED`), clears the
 *   lock counters, verifies a pending customer's email (the link proves mailbox control).
 * - change: current password verified (counts toward lockout), other sessions revoked by default.
 *   The current family is kept but NOT rotated: the refresh cookie's Path (`/api/v1/auth`,
 *   `/api/v1/admin/auth`) does not reach `/me/change-password`, so the token is not available here.
 *
 * Every session/password change drops cached auth contexts after commit.
 * Staff password history (§4.2 reuse rule) is NOT enforced: `users.password_history` is not in
 * the approved schema.
 */
import type { AppContainer } from '../../container.js';
import { withTransaction } from '../../core/db/transaction.js';
import { AppError } from '../../core/errors/AppError.js';
import { checkPasswordPolicy } from '../../core/security/password.js';
import { generateOpaqueToken, hashToken } from '../../core/security/tokens.js';
import { maskEmail } from '../../lib/redact.js';
import { addMinutes } from '../../lib/time.js';
import {
  ACCOUNT_TYPE,
  appBaseUrl,
  sendEmailSafe,
  truncate,
  userActor,
  type Audience,
  type RequestMeta,
} from './auth.context.js';
import {
  consumeVerification,
  createVerificationRow,
  findUserByEmail,
  findUserById,
  findVerificationByHash,
  invalidateOpenTokens,
  type LoginUserRow,
  type VerificationRow,
} from './auth.repository.js';
import type { CredentialService } from './credentials.js';
import { revokeUserSessions } from './sessions.js';

export function tokenInvalid(field = 'token'): AppError {
  return new AppError('VALIDATION_ERROR', 'The link is invalid or has expired.', {
    details: [
      { field, code: 'TOKEN_INVALID_OR_EXPIRED', message: 'The link is invalid or has expired.' },
    ],
  });
}

export function policyViolation(message: string, field = 'newPassword'): AppError {
  return new AppError('VALIDATION_ERROR', undefined, { details: [{ field, message }] });
}

export function assertPasswordPolicy(
  password: string,
  user: { readonly email: string; readonly firstName: string; readonly lastName: string | null },
  field = 'newPassword',
): void {
  const problem = checkPasswordPolicy(password, {
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName ?? undefined,
  });
  if (problem !== undefined) throw policyViolation(problem, field);
}

/** Looks up a verification token by raw value and checks purpose, expiry, use and target. */
export async function loadUsableToken(
  container: AppContainer,
  raw: string,
  purpose: VerificationRow['purpose'],
): Promise<{ token: VerificationRow; user: LoginUserRow } | null> {
  const token = await findVerificationByHash(
    container.db,
    hashToken(raw, container.config.auth.refresh.pepper),
  );
  const now = container.clock();
  if (
    token?.purpose !== purpose ||
    token.consumedAt !== null ||
    token.invalidatedAt !== null ||
    token.expiresAt <= now
  ) {
    return null;
  }
  const user = await findUserById(container.db, token.userId);
  if (user?.deletedAt !== null || user.emailNormalized !== token.target) {
    return null;
  }
  return { token, user };
}

export interface PasswordService {
  forgot(email: string, meta: RequestMeta): Promise<void>;
  reset(rawToken: string, newPassword: string, meta: RequestMeta): Promise<void>;
  change(input: {
    readonly userId: string;
    readonly sid: string;
    readonly currentPassword: string;
    readonly newPassword: string;
    readonly signOutOtherDevices: boolean;
    readonly meta: RequestMeta;
  }): Promise<{ revokedSessions: number }>;
}

export function createPasswordService(
  container: AppContainer,
  audience: Audience,
  credentials: CredentialService,
): PasswordService {
  const { db, clock, config } = container;
  const pepper = config.auth.refresh.pepper;
  const ttlMinutes =
    audience === 'admin' ? config.auth.staffResetTtlMinutes : config.auth.passwordResetTtlMinutes;

  const notifyChanged = (user: LoginUserRow) => () =>
    sendEmailSafe(container, {
      to: user.email,
      subject: 'Your password was changed',
      templateKey: 'PASSWORD_CHANGED',
      variables: {
        firstName: user.firstName,
        supportUrl: `${appBaseUrl(container, audience)}/forgot-password`,
      },
    });

  return {
    async forgot(email, meta) {
      const user = await findUserByEmail(db, email);
      const eligible =
        user !== null &&
        user.accountType === ACCOUNT_TYPE[audience] &&
        user.deletedAt === null &&
        (user.status === 'ACTIVE' ||
          (audience === 'storefront' && user.status === 'PENDING_VERIFICATION')) &&
        !(user.isSuperadmin && !user.mfaEnabled);
      if (!eligible) {
        // Same work profile as the success path as far as practical (no DB write, no email).
        generateOpaqueToken();
        return;
      }
      const now = clock();
      const raw = generateOpaqueToken();
      await withTransaction(db, async (ctx) => {
        const { tx } = ctx;
        await invalidateOpenTokens(tx, user.id, 'PASSWORD_RESET', now);
        await createVerificationRow(tx, {
          userId: user.id,
          purpose: 'PASSWORD_RESET',
          channel: 'EMAIL',
          target: user.emailNormalized,
          tokenHash: hashToken(raw, pepper),
          expiresAt: addMinutes(now, ttlMinutes),
          ipAddress: truncate(meta.ip, 45),
          now,
        });
        await container.audit.record(tx, userActor(meta, user.id, audience), {
          action: 'PASSWORD_RESET',
          module: 'auth',
          entityType: 'User',
          entityId: user.id,
          eventKey: 'auth.password_reset_requested',
          diff: false,
          metadata: { audience, email: maskEmail(user.email) },
        });
        ctx.afterCommit(() =>
          sendEmailSafe(container, {
            to: user.email,
            subject: 'Reset your password',
            templateKey: 'PASSWORD_RESET_REQUESTED',
            variables: {
              firstName: user.firstName,
              link: `${appBaseUrl(container, audience)}/reset-password?token=${raw}`,
              expiresInMinutes: ttlMinutes,
            },
          }),
        );
      });
    },

    async reset(rawToken, newPassword, meta) {
      const found = await loadUsableToken(container, rawToken, 'PASSWORD_RESET');
      if (found?.user.accountType !== ACCOUNT_TYPE[audience]) throw tokenInvalid();
      const { token, user } = found;
      assertPasswordPolicy(newPassword, user);
      const passwordHash = await container.passwords.hash(newPassword);
      const now = clock();
      await withTransaction(db, async (ctx) => {
        const { tx } = ctx;
        if (!(await consumeVerification(tx, token.id, now))) throw tokenInvalid();
        const verifyEmail = audience === 'storefront' && user.status === 'PENDING_VERIFICATION';
        await tx.user.update({
          where: { id: user.id },
          data: {
            passwordHash,
            passwordChangedAt: now,
            failedLoginCount: 0,
            lockedUntil: null,
            ...(verifyEmail
              ? { status: 'ACTIVE' as const, emailVerifiedAt: user.emailVerifiedAt ?? now }
              : {}),
          },
        });
        const revoked = await revokeUserSessions(tx, user.id, 'PASSWORD_CHANGED', now);
        await container.audit.record(tx, userActor(meta, user.id, audience), {
          action: 'PASSWORD_RESET',
          module: 'auth',
          entityType: 'User',
          entityId: user.id,
          eventKey: 'auth.password_reset_completed',
          diff: false,
          metadata: { audience, revokedTokens: revoked, emailVerified: verifyEmail },
        });
        ctx.afterCommit(() => {
          container.permissions.invalidateUser(user.id);
        });
        ctx.afterCommit(notifyChanged(user));
      });
    },

    async change({ userId, sid, currentPassword, newPassword, signOutOtherDevices, meta }) {
      const user = await credentials.verifyCurrentPassword({
        userId,
        password: currentPassword,
        audience,
        meta,
        eventKey: 'auth.password_change_failed',
      });
      if (newPassword.normalize('NFC') === currentPassword.normalize('NFC')) {
        throw policyViolation('The new password must be different from the current one.');
      }
      assertPasswordPolicy(newPassword, user);
      const passwordHash = await container.passwords.hash(newPassword);
      const now = clock();
      return withTransaction(db, async (ctx) => {
        const { tx } = ctx;
        await tx.user.update({
          where: { id: user.id },
          data: { passwordHash, passwordChangedAt: now, failedLoginCount: 0, lockedUntil: null },
        });
        const revoked = signOutOtherDevices
          ? await revokeUserSessions(tx, user.id, 'PASSWORD_CHANGED', now, sid)
          : 0;
        await container.audit.record(tx, userActor(meta, user.id, audience), {
          action: 'UPDATE',
          module: 'auth',
          entityType: 'User',
          entityId: user.id,
          eventKey: 'auth.password_changed',
          diff: false,
          metadata: { audience, signOutOtherDevices, revokedTokens: revoked },
        });
        ctx.afterCommit(() => {
          container.permissions.invalidateUser(user.id);
        });
        ctx.afterCommit(notifyChanged(user));
        return { revokedSessions: revoked };
      });
    },
  };
}

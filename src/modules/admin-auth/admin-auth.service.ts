/**
 * Staff authentication use-cases — API_DOCUMENTATION.md §4.1, AUTHENTICATION_AUTHORIZATION.md
 * §7.2, §13–§15, decisions D-45 (TOTP mandatory for Superadmin/Admin), D-51 (no MFA browser trust).
 *
 * MFA enforcement (owner decision 2026-11-19, routes `POST /admin/auth/mfa/enroll` + `/confirm`):
 * a Superadmin/Admin without MFA receives NO session after a correct password (login or
 * accept-invite) — only a short-lived, single-use `enrollmentToken`. The session is issued by
 * `mfa/confirm` once a TOTP code proves the new secret. Refresh of a session belonging to an
 * unenrolled mandatory-MFA user is refused and the family revoked. Other staff may enrol
 * voluntarily with their existing session.
 */
import type { AppContainer } from '../../container.js';
import { withTransaction, type Queryable } from '../../core/db/transaction.js';
import { AppError } from '../../core/errors/AppError.js';
import { PERMISSIONS } from '../../lib/permissions.js';
import { truncate, userActor, type RequestMeta } from '../auth/auth.context.js';
import { findUserById, type LoginUserRow } from '../auth/auth.repository.js';
import { createCredentialService, type CredentialService } from '../auth/credentials.js';
import {
  assertPasswordPolicy,
  createPasswordService,
  loadUsableToken,
  tokenInvalid,
  type PasswordService,
} from '../auth/password.service.js';
import {
  createSessionService,
  isLoginAllowedStatus,
  type IssuedSession,
  type SessionService,
} from '../auth/session.service.js';
import type { AuthContext } from '../rbac/permission.service.js';
import {
  toStaffLoginUser,
  toStaffProfile,
  type StaffLoginUserDto,
  type StaffProfileDto,
  type StaffRole,
} from './admin-auth.mapper.js';
import type {
  AcceptInviteInput,
  AdminLoginInput,
  MfaVerifyInput,
  ReauthInput,
} from './admin-auth.schemas.js';
import { MFA_CHALLENGE_TTL_SECONDS, createMfaService, type MfaService } from './mfa.js';
import { revokeFamily } from '../auth/sessions.js';

const AUDIENCE = 'admin';

export interface StaffLoginResult {
  readonly kind: 'session';
  readonly session: IssuedSession;
  readonly user: StaffLoginUserDto;
}

/** Mandatory MFA not yet enrolled: no session; enrol + confirm with this token (15 min, single use). */
export interface StaffEnrollmentRequiredResult {
  readonly kind: 'enrollment';
  readonly enrollmentToken: string;
  readonly expiresIn: number;
}

export interface MfaEnrollmentStart {
  readonly secret: string;
  readonly otpauthUri: string;
  readonly issuer: string;
  readonly accountLabel: string;
  readonly expiresIn: number;
}

export interface MfaEnrollmentPrincipal {
  /** Present for the login/accept-invite flow. */
  readonly enrollmentToken?: string | undefined;
  /** Present for voluntary enrolment by a signed-in staff member. */
  readonly ctx?: AuthContext | undefined;
}

export interface StaffMfaChallengeResult {
  readonly kind: 'mfa';
  readonly mfaChallengeId: string;
  readonly expiresIn: number;
}

export interface StaffMeDto {
  readonly user: StaffProfileDto;
  readonly roles: readonly StaffRole[];
  readonly permissions: readonly string[];
  readonly deniedOverrides: readonly string[];
  readonly session: {
    readonly id: string;
    readonly reauthenticatedAt: string | null;
    readonly reauthValidUntil: string | null;
    readonly expiresAt: string | null;
  };
}

export interface AdminAuthService {
  readonly sessions: SessionService;
  readonly passwords: PasswordService;
  readonly credentials: CredentialService;
  readonly mfa: MfaService;
  login(
    input: AdminLoginInput,
    meta: RequestMeta,
  ): Promise<StaffLoginResult | StaffMfaChallengeResult | StaffEnrollmentRequiredResult>;
  enrollMfa(principal: MfaEnrollmentPrincipal, meta: RequestMeta): Promise<MfaEnrollmentStart>;
  confirmMfa(
    principal: MfaEnrollmentPrincipal,
    totpCode: string,
    meta: RequestMeta,
  ): Promise<StaffLoginResult | { readonly kind: 'enabled' }>;
  verifyMfa(input: MfaVerifyInput, meta: RequestMeta): Promise<StaffLoginResult>;
  refresh(rawToken: string, meta: RequestMeta): Promise<StaffLoginResult>;
  me(ctx: AuthContext): Promise<StaffMeDto>;
  reauth(
    ctx: AuthContext,
    input: ReauthInput,
    meta: RequestMeta,
  ): Promise<{ reauthenticatedAt: string; validUntil: string }>;
  acceptInvite(
    input: AcceptInviteInput,
    meta: RequestMeta,
  ): Promise<StaffLoginResult | StaffEnrollmentRequiredResult>;
}

export async function loadStaffRoles(db: Queryable, userId: string): Promise<StaffRole[]> {
  const rows = await db.userRole.findMany({
    where: { userId, role: { isActive: true } },
    select: { role: { select: { id: true, code: true, name: true, isSystem: true } } },
  });
  return rows.map((r) => r.role).sort((a, b) => a.code.localeCompare(b.code));
}

/** OQ-30 / D-45: MFA is mandatory for Superadmins and holders of the system role ADMIN. */
export function isMfaMandatory(
  user: { readonly isSuperadmin: boolean },
  roles: readonly StaffRole[],
) {
  return user.isSuperadmin || roles.some((r) => r.code === 'ADMIN');
}

function mfaError(code: 'MFA_INVALID' | 'MFA_CHALLENGE_EXPIRED'): AppError {
  const message =
    code === 'MFA_INVALID'
      ? 'The verification code is incorrect.'
      : 'The sign-in attempt has expired. Please sign in again.';
  return new AppError('UNAUTHENTICATED', message, { details: [{ code, message }] });
}

function enrollmentError(
  code: 'MFA_ENROLLMENT_REQUIRED' | 'MFA_ENROLLMENT_INVALID' | 'MFA_ENROLLMENT_EXPIRED',
): AppError {
  const message =
    code === 'MFA_ENROLLMENT_REQUIRED'
      ? 'Two-factor authentication must be set up before you can sign in.'
      : code === 'MFA_ENROLLMENT_EXPIRED'
        ? 'The two-factor setup has expired. Please sign in again.'
        : 'The two-factor setup link is invalid or has expired. Please sign in again.';
  return new AppError('UNAUTHENTICATED', message, { details: [{ code, message }] });
}

export function createAdminAuthService(container: AppContainer): AdminAuthService {
  const { db, clock, config, store } = container;
  const sessions = createSessionService(container);
  const credentials = createCredentialService(container, AUDIENCE);
  const passwords = createPasswordService(container, AUDIENCE, credentials);
  const mfa = createMfaService({
    store,
    cipher: container.cipher,
    clock,
    issuer: config.auth.mfaIssuer,
    pepper: config.auth.refresh.pepper,
  });

  const generic = (): AppError => new AppError('UNAUTHENTICATED', 'Invalid email or password.');

  interface InviteAcceptance {
    readonly passwordHash: string;
    readonly firstName?: string;
    readonly lastName?: string;
    readonly tokenId: string;
  }

  async function finishLogin(
    user: LoginUserRow,
    roles: readonly StaffRole[],
    meta: RequestMeta,
    extra: { readonly mfa: boolean; readonly inviteAccepted?: InviteAcceptance },
  ): Promise<StaffLoginResult> {
    const { session, merged } = await runLogin(user, roles, meta, { ...extra, issueSession: true });
    if (session === undefined) throw new Error('Session expected.');
    return { kind: 'session', session, user: toStaffLoginUser(merged, roles) };
  }

  /** Accept-invite for a mandatory-MFA user: password set + ACTIVE, but NO session (D-45). */
  async function finishLoginWithoutSession(
    user: LoginUserRow,
    roles: readonly StaffRole[],
    meta: RequestMeta,
    inviteAccepted: InviteAcceptance,
  ): Promise<void> {
    await runLogin(user, roles, meta, { mfa: false, issueSession: false, inviteAccepted });
  }

  async function runLogin(
    user: LoginUserRow,
    roles: readonly StaffRole[],
    meta: RequestMeta,
    extra: {
      readonly mfa: boolean;
      readonly issueSession: boolean;
      readonly inviteAccepted?: InviteAcceptance;
    },
  ) {
    const now = clock();
    const issueSession = extra.issueSession;
    const alert =
      extra.inviteAccepted === undefined
        ? await sessions.newDeviceAlert(user, AUDIENCE, meta)
        : undefined;
    const roleCode = user.isSuperadmin ? 'SUPERADMIN' : roles[0]?.code;
    const actor = userActor(meta, user.id, AUDIENCE, roleCode);
    const session = await withTransaction(db, async (ctx) => {
      const { tx } = ctx;
      const invite = extra.inviteAccepted;
      if (invite !== undefined) {
        const consumed = await tx.verificationToken.updateMany({
          where: { id: invite.tokenId, consumedAt: null, invalidatedAt: null },
          data: { consumedAt: now },
        });
        if (consumed.count !== 1) throw tokenInvalid();
      }
      await tx.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: 0,
          lockedUntil: null,
          ...(issueSession ? { lastLoginAt: now, lastLoginIp: truncate(meta.ip, 45) } : {}),
          ...(invite === undefined
            ? {}
            : {
                passwordHash: invite.passwordHash,
                passwordChangedAt: now,
                emailVerifiedAt: user.emailVerifiedAt ?? now,
                status: 'ACTIVE' as const,
                ...(invite.firstName === undefined ? {} : { firstName: invite.firstName }),
                ...(invite.lastName === undefined ? {} : { lastName: invite.lastName }),
              }),
        },
      });
      const issued = issueSession ? await sessions.issue(tx, user.id, AUDIENCE, meta) : undefined;
      if (invite !== undefined) {
        await container.audit.record(tx, actor, {
          action: 'UPDATE',
          module: 'auth',
          entityType: 'User',
          entityId: user.id,
          eventKey: 'auth.invite_accepted',
          before: { status: user.status },
          after: { status: 'ACTIVE' },
        });
      }
      if (issued !== undefined) {
        await container.audit.record(tx, actor, {
          action: 'LOGIN',
          module: 'auth',
          entityType: 'User',
          entityId: user.id,
          eventKey: 'auth.login',
          diff: false,
          metadata: { audience: AUDIENCE, sessionId: issued.familyId, mfa: extra.mfa },
        });
      }
      ctx.afterCommit(() => {
        container.permissions.invalidateUser(user.id);
      });
      if (alert !== undefined) ctx.afterCommit(alert);
      return issued;
    });
    const merged = {
      ...user,
      ...(extra.inviteAccepted?.firstName === undefined
        ? {}
        : { firstName: extra.inviteAccepted.firstName }),
      ...(extra.inviteAccepted?.lastName === undefined
        ? {}
        : { lastName: extra.inviteAccepted.lastName }),
    };
    return { session, merged };
  }

  async function enrollmentRequired(
    user: LoginUserRow,
    meta: RequestMeta,
  ): Promise<StaffEnrollmentRequiredResult> {
    const enrollmentToken = mfa.issueEnrollmentToken(user.id);
    await container.audit.recordSafe(db, userActor(meta, user.id, AUDIENCE, undefined), {
      action: 'LOGIN',
      module: 'auth',
      entityType: 'User',
      entityId: user.id,
      outcome: 'FAILURE',
      reason: 'MFA_ENROLLMENT_REQUIRED',
      eventKey: 'auth.mfa_enrollment_required',
      diff: false,
    });
    return { kind: 'enrollment', enrollmentToken, expiresIn: 15 * 60 };
  }

  /** Resolves the enrolling staff member (token flow or signed-in session) and re-checks state. */
  async function resolveEnrollee(principal: MfaEnrollmentPrincipal): Promise<LoginUserRow> {
    let userId: string | undefined;
    if (principal.enrollmentToken !== undefined) {
      userId = mfa.peekEnrollmentToken(principal.enrollmentToken);
      if (userId === undefined) throw enrollmentError('MFA_ENROLLMENT_INVALID');
    } else if (principal.ctx !== undefined) {
      userId = principal.ctx.userId;
    } else {
      throw new AppError('UNAUTHENTICATED', 'Please sign in to continue.');
    }
    const user = await findUserById(db, userId);
    if (
      user === null ||
      !isLoginAllowedStatus(user, AUDIENCE) ||
      (user.lockedUntil !== null && user.lockedUntil > clock())
    ) {
      throw enrollmentError('MFA_ENROLLMENT_INVALID');
    }
    if (user.mfaEnabled) {
      throw new AppError('CONFLICT', 'Two-factor authentication is already enabled.', {
        details: [
          { code: 'MFA_ALREADY_ENABLED', message: 'Two-factor authentication is already enabled.' },
        ],
      });
    }
    return user;
  }

  return {
    sessions,
    passwords,
    credentials,
    mfa,

    async login(input, meta) {
      const user = await credentials.verifyLogin({
        email: input.email,
        password: input.password,
        captchaToken: input.captchaToken,
        audience: AUDIENCE,
        meta,
      });
      const roles = await loadStaffRoles(db, user.id);
      if (user.mfaEnabled) {
        if (user.mfaSecretEncrypted === null) {
          container.logger.error({ userId: user.id }, 'MFA enabled without a stored secret');
          throw generic();
        }
        const challenge = mfa.createChallenge(user.id, meta.ip, meta.userAgent);
        return {
          kind: 'mfa',
          mfaChallengeId: challenge.id,
          expiresIn: MFA_CHALLENGE_TTL_SECONDS,
        };
      }
      if (isMfaMandatory(user, roles)) return enrollmentRequired(user, meta);
      return finishLogin(user, roles, meta, { mfa: false });
    },

    async enrollMfa(principal, meta) {
      const user = await resolveEnrollee(principal);
      const start = mfa.startPendingEnrollment(user.id, user.email);
      await container.audit.recordSafe(db, userActor(meta, user.id, AUDIENCE, undefined), {
        action: 'UPDATE',
        module: 'auth',
        entityType: 'User',
        entityId: user.id,
        eventKey: 'auth.mfa_enrollment_started',
        diff: false,
        metadata: { via: principal.enrollmentToken === undefined ? 'session' : 'enrollmentToken' },
      });
      return { ...start, issuer: config.auth.mfaIssuer, accountLabel: user.email };
    },

    async confirmMfa(principal, totpCode, meta) {
      const user = await resolveEnrollee(principal);
      const outcome = mfa.verifyPending(user.id, totpCode);
      if (outcome.status === 'NONE') {
        throw new AppError('CONFLICT', 'Start two-factor setup first.', {
          details: [
            { code: 'MFA_ENROLLMENT_NOT_STARTED', message: 'Start two-factor setup first.' },
          ],
        });
      }
      if (outcome.status !== 'OK') {
        await credentials.registerFailure(
          user,
          AUDIENCE,
          meta,
          'MFA_FAILED',
          'auth.mfa_enrollment_failed',
        );
        if (outcome.status === 'EXPIRED') throw enrollmentError('MFA_ENROLLMENT_EXPIRED');
        throw mfaError('MFA_INVALID');
      }
      const roles = await loadStaffRoles(db, user.id);
      const actor = userActor(
        meta,
        user.id,
        AUDIENCE,
        user.isSuperadmin ? 'SUPERADMIN' : roles[0]?.code,
      );
      await withTransaction(db, async (ctx) => {
        const updated = await ctx.tx.user.updateMany({
          where: { id: user.id, mfaEnabled: false },
          data: { mfaEnabled: true, mfaSecretEncrypted: outcome.encryptedSecret },
        });
        if (updated.count !== 1) {
          throw new AppError('CONFLICT', 'Two-factor authentication is already enabled.', {
            details: [
              {
                code: 'MFA_ALREADY_ENABLED',
                message: 'Two-factor authentication is already enabled.',
              },
            ],
          });
        }
        await container.audit.record(ctx.tx, actor, {
          action: 'UPDATE',
          module: 'auth',
          entityType: 'User',
          entityId: user.id,
          eventKey: 'auth.mfa_enrolled',
          before: { mfaEnabled: false },
          after: { mfaEnabled: true },
        });
        ctx.afterCommit(() => {
          container.permissions.invalidateUser(user.id);
        });
      });
      if (principal.enrollmentToken === undefined) return { kind: 'enabled' as const };
      mfa.redeemEnrollmentToken(principal.enrollmentToken);
      return finishLogin({ ...user, mfaEnabled: true }, roles, meta, { mfa: true });
    },

    async verifyMfa(input, meta) {
      const challenge = mfa.getChallenge(input.mfaChallengeId, meta.ip, meta.userAgent);
      if (challenge === undefined) throw mfaError('MFA_CHALLENGE_EXPIRED');
      if (input.recoveryCode !== undefined) {
        // Recovery codes need a schema change (deferred, decision log §4).
        throw new AppError('VALIDATION_ERROR', undefined, {
          details: [
            {
              field: 'recoveryCode',
              code: 'NOT_SUPPORTED',
              message: 'Recovery codes are not available yet. Use your authenticator app.',
            },
          ],
        });
      }
      const user = await findUserById(db, challenge.userId);
      if (
        user?.mfaSecretEncrypted == null ||
        !user.mfaEnabled ||
        !isLoginAllowedStatus(user, AUDIENCE) ||
        (user.lockedUntil !== null && user.lockedUntil > clock())
      ) {
        mfa.consumeChallenge(challenge);
        throw mfaError('MFA_CHALLENGE_EXPIRED');
      }
      const valid = mfa.verifyCode(user.id, user.mfaSecretEncrypted, input.totpCode ?? '');
      if (!valid) {
        const invalidated = mfa.recordFailure(challenge);
        await credentials.registerFailure(user, AUDIENCE, meta, 'MFA_FAILED');
        throw mfaError(invalidated ? 'MFA_CHALLENGE_EXPIRED' : 'MFA_INVALID');
      }
      mfa.consumeChallenge(challenge);
      const roles = await loadStaffRoles(db, user.id);
      return finishLogin(user, roles, meta, { mfa: true });
    },

    async refresh(rawToken, meta) {
      const { session, user } = await sessions.refresh(rawToken, AUDIENCE, meta);
      const roles = await loadStaffRoles(db, user.id);
      if (isMfaMandatory(user, roles) && !user.mfaEnabled) {
        // e.g. promoted to ADMIN after signing in: the session cannot continue without MFA.
        await revokeFamily(db, user.id, session.familyId, 'MFA_RESET', clock());
        sessions.forgetSession(session.familyId);
        container.permissions.invalidateUser(user.id);
        throw enrollmentError('MFA_ENROLLMENT_REQUIRED');
      }
      return { kind: 'session', session, user: toStaffLoginUser(user, roles) };
    },

    async me(ctx) {
      const now = clock();
      const user = await findUserById(db, ctx.userId);
      if (user === null) throw new AppError('UNAUTHENTICATED', 'Please sign in to continue.');
      const [roles, effective, denied, active] = await Promise.all([
        loadStaffRoles(db, ctx.userId),
        container.permissions.effectivePermissions(db, ctx.userId, user.isSuperadmin),
        db.userPermissionOverride.findMany({
          where: { userId: ctx.userId, effect: 'DENY' },
          select: { permission: { select: { code: true } } },
        }),
        db.refreshToken.findFirst({
          where: { userId: ctx.userId, familyId: ctx.sid, revokedAt: null },
          orderBy: { issuedAt: 'desc' },
          select: { expiresAt: true, absoluteExpiresAt: true },
        }),
      ]);
      const marker = store.get(`reauth:${ctx.sid}`);
      const reauthAt = typeof marker === 'number' ? new Date(marker) : null;
      const reauthUntil =
        reauthAt === null
          ? null
          : new Date(reauthAt.getTime() + config.auth.reauthWindowMinutes * 60_000);
      const permissions =
        effective === 'ALL' ? ['*', ...PERMISSIONS.map((p) => p.key)] : [...effective];
      const expiresAt =
        active === null
          ? null
          : active.expiresAt < active.absoluteExpiresAt
            ? active.expiresAt
            : active.absoluteExpiresAt;
      return {
        user: toStaffProfile(user),
        roles,
        permissions,
        deniedOverrides: denied.map((d) => d.permission.code).sort(),
        session: {
          id: ctx.sid,
          reauthenticatedAt: reauthAt?.toISOString() ?? null,
          reauthValidUntil:
            reauthUntil !== null && reauthUntil > now ? reauthUntil.toISOString() : null,
          expiresAt: expiresAt?.toISOString() ?? null,
        },
      };
    },

    async reauth(ctx, input, meta) {
      const user = await credentials.verifyCurrentPassword({
        userId: ctx.userId,
        password: input.password,
        audience: AUDIENCE,
        meta,
        eventKey: 'auth.reauth_failed',
      });
      if (user.mfaEnabled) {
        if (input.totpCode === undefined) {
          throw new AppError('VALIDATION_ERROR', undefined, {
            details: [
              { field: 'totpCode', message: 'Enter the 6-digit code from your authenticator app.' },
            ],
          });
        }
        const valid =
          user.mfaSecretEncrypted !== null &&
          mfa.verifyCode(user.id, user.mfaSecretEncrypted, input.totpCode);
        if (!valid) {
          await credentials.registerFailure(
            user,
            AUDIENCE,
            meta,
            'MFA_FAILED',
            'auth.reauth_failed',
          );
          throw mfaError('MFA_INVALID');
        }
      }
      const now = clock();
      const windowSeconds = config.auth.reauthWindowMinutes * 60;
      store.set(`reauth:${ctx.sid}`, now.getTime(), windowSeconds);
      if (user.failedLoginCount > 0) {
        await db.user.update({ where: { id: user.id }, data: { failedLoginCount: 0 } });
      }
      await container.audit.recordSafe(db, meta.actor, {
        action: 'LOGIN',
        module: 'auth',
        entityType: 'User',
        entityId: user.id,
        eventKey: 'auth.reauth_success',
        diff: false,
        metadata: { sessionId: ctx.sid, mfa: user.mfaEnabled },
      });
      return {
        reauthenticatedAt: now.toISOString(),
        validUntil: new Date(now.getTime() + windowSeconds * 1000).toISOString(),
      };
    },

    async acceptInvite(input, meta) {
      const found = await loadUsableToken(container, input.token, 'STAFF_INVITE');
      if (found?.user.accountType !== 'STAFF' || found.user.status !== 'PENDING_VERIFICATION') {
        throw tokenInvalid();
      }
      const { token, user } = found;
      assertPasswordPolicy(
        input.password,
        {
          email: user.email,
          firstName: input.firstName ?? user.firstName,
          lastName: input.lastName ?? user.lastName,
        },
        'password',
      );
      const passwordHash = await container.passwords.hash(input.password);
      const roles = await loadStaffRoles(db, user.id);
      const mustEnroll = isMfaMandatory(user, roles) && !user.mfaEnabled;
      if (mustEnroll) {
        await finishLoginWithoutSession(user, roles, meta, {
          passwordHash,
          tokenId: token.id,
          ...(input.firstName === undefined ? {} : { firstName: input.firstName }),
          ...(input.lastName === undefined ? {} : { lastName: input.lastName }),
        });
        return enrollmentRequired({ ...user, status: 'ACTIVE' }, meta);
      }
      return finishLogin(user, roles, meta, {
        mfa: false,
        inviteAccepted: {
          passwordHash,
          tokenId: token.id,
          ...(input.firstName === undefined ? {} : { firstName: input.firstName }),
          ...(input.lastName === undefined ? {} : { lastName: input.lastName }),
        },
      });
    },
  };
}

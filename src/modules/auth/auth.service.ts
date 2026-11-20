/**
 * Customer authentication use-cases — API_DOCUMENTATION.md §3.1, AUTHENTICATION_AUTHORIZATION.md
 * §5–§12, decisions D-41 (email-link verification, optional phone OTP), D-46 (no OTP login),
 * D-48 (CAPTCHA provider `none`), D-51 (remember me).
 */
import { randomUUID } from 'node:crypto';

import type { AppContainer } from '../../container.js';
import { withTransaction } from '../../core/db/transaction.js';
import { AppError } from '../../core/errors/AppError.js';
import { isPrismaKnownError } from '../../core/errors/prismaErrorMapper.js';
import {
  generateOpaqueToken,
  generateOtp,
  hashToken,
  safeEqualHex,
} from '../../core/security/tokens.js';
import { normalizePhone } from '../../lib/normalize.js';
import { maskEmail } from '../../lib/redact.js';
import { addMinutes } from '../../lib/time.js';
import {
  appBaseUrl,
  sendEmailSafe,
  truncate,
  userActor,
  type RequestMeta,
} from './auth.context.js';
import { toCustomerUserDto, type CustomerUserDto } from './auth.mapper.js';
import {
  consumeVerification,
  createVerificationRow,
  findUserByEmail,
  invalidateOpenTokens,
  type LoginUserRow,
} from './auth.repository.js';
import type { LoginInput, OtpSendInput, OtpVerifyInput, RegisterInput } from './auth.schemas.js';
import { createCredentialService, type CredentialService } from './credentials.js';
import {
  assertPasswordPolicy,
  createPasswordService,
  loadUsableToken,
  tokenInvalid,
  type PasswordService,
} from './password.service.js';
import {
  createSessionService,
  type IssuedSession,
  type SessionService,
} from './session.service.js';

export interface LoginResult {
  readonly session: IssuedSession;
  readonly user: CustomerUserDto;
}

export const REGISTER_ACCEPTED = Object.freeze({
  accepted: true,
  message:
    "If this email can be registered, we've sent a verification link. Please check your inbox.",
  verification: Object.freeze({ channel: 'EMAIL_LINK' }),
});

export const OTP_TTL_MINUTES = 10;
export const OTP_RESEND_SECONDS = 60;
const OTP_MAX_ATTEMPTS = 5;
const OTP_PER_HOUR_TARGET = 5;
const OTP_PER_DAY_TARGET = 10;
const OTP_PER_HOUR_IP = 20;
const RESEND_COOLDOWN_SECONDS = 60;
const RESEND_PER_HOUR_ACCOUNT = 5;

export interface AuthService {
  readonly sessions: SessionService;
  readonly credentials: CredentialService;
  readonly passwords: PasswordService;
  register(input: RegisterInput, meta: RequestMeta): Promise<void>;
  login(input: LoginInput, meta: RequestMeta): Promise<LoginResult>;
  refresh(rawToken: string, meta: RequestMeta): Promise<LoginResult>;
  verifyEmail(rawToken: string, meta: RequestMeta): Promise<{ status: LoginUserRow['status'] }>;
  resendVerification(email: string, meta: RequestMeta): Promise<void>;
  sendOtp(input: OtpSendInput, meta: RequestMeta, authUserId: string | undefined): Promise<void>;
  verifyOtp(
    input: OtpVerifyInput,
    meta: RequestMeta,
    authUserId: string | undefined,
  ): Promise<void>;
}

function otpError(code: 'OTP_INVALID' | 'OTP_EXPIRED' | 'OTP_ATTEMPTS_EXCEEDED'): AppError {
  const messages = {
    OTP_INVALID: 'The code is incorrect.',
    OTP_EXPIRED: 'The code has expired. Please request a new one.',
    OTP_ATTEMPTS_EXCEEDED: 'Too many incorrect attempts. Please request a new code.',
  } as const;
  return new AppError('VALIDATION_ERROR', messages[code], {
    details: [{ field: 'otp', code, message: messages[code] }],
  });
}

function otpUnsupported(field: 'purpose' | 'channel', message: string): AppError {
  return new AppError('VALIDATION_ERROR', undefined, {
    details: [{ field, code: 'NOT_SUPPORTED', message }],
  });
}

export function createAuthService(container: AppContainer): AuthService {
  const { db, clock, config, store } = container;
  const pepper = config.auth.refresh.pepper;
  const sessions = createSessionService(container);
  const credentials = createCredentialService(container, 'storefront');
  const passwordService = createPasswordService(container, 'storefront', credentials);

  /** OTP hash binds the code to its row id so equal codes never collide on the unique index. */
  const otpHash = (rowId: string, code: string): string =>
    hashToken(`otp:${rowId}:${code}`, pepper);

  async function issueVerificationEmail(
    user: Pick<LoginUserRow, 'id' | 'email' | 'emailNormalized' | 'firstName'>,
    meta: RequestMeta,
  ): Promise<void> {
    const now = clock();
    const raw = generateOpaqueToken();
    await withTransaction(db, async (ctx) => {
      const { tx } = ctx;
      await invalidateOpenTokens(tx, user.id, 'EMAIL_VERIFICATION', now);
      await createVerificationRow(tx, {
        userId: user.id,
        purpose: 'EMAIL_VERIFICATION',
        channel: 'EMAIL',
        target: user.emailNormalized,
        tokenHash: hashToken(raw, pepper),
        expiresAt: addMinutes(now, config.auth.verificationTtlMinutes),
        ipAddress: truncate(meta.ip, 45),
        now,
      });
      ctx.afterCommit(() => sendVerificationLink(user, raw));
    });
  }

  const sendVerificationLink = (user: Pick<LoginUserRow, 'email' | 'firstName'>, raw: string) =>
    sendEmailSafe(container, {
      to: user.email,
      subject: 'Verify your email address',
      templateKey: 'VERIFICATION_REQUESTED',
      variables: {
        firstName: user.firstName,
        link: `${appBaseUrl(container, 'storefront')}/verify-email?token=${raw}`,
        expiresInMinutes: config.auth.verificationTtlMinutes,
      },
    });

  async function sendAccountExistsNotice(user: LoginUserRow): Promise<void> {
    const base = appBaseUrl(container, 'storefront');
    await sendEmailSafe(container, {
      to: user.email,
      subject: 'You already have an account',
      templateKey: 'ACCOUNT_ALREADY_EXISTS',
      variables: {
        firstName: user.firstName,
        loginUrl: `${base}/login`,
        forgotPasswordUrl: `${base}/forgot-password`,
      },
    });
  }

  async function finishLogin(
    user: LoginUserRow,
    meta: RequestMeta,
    rememberMe: boolean,
  ): Promise<LoginResult> {
    const now = clock();
    const alert = await sessions.newDeviceAlert(user, 'storefront', meta);
    const session = await withTransaction(db, async (ctx) => {
      const { tx } = ctx;
      await tx.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: 0,
          lockedUntil: null,
          lastLoginAt: now,
          lastLoginIp: truncate(meta.ip, 45),
        },
      });
      const issued = await sessions.issue(tx, user.id, 'storefront', meta, { rememberMe });
      await container.audit.record(tx, userActor(meta, user.id, 'storefront'), {
        action: 'LOGIN',
        module: 'auth',
        entityType: 'User',
        entityId: user.id,
        eventKey: 'auth.login',
        diff: false,
        metadata: { audience: 'storefront', sessionId: issued.familyId, rememberMe },
      });
      ctx.afterCommit(() => {
        container.permissions.invalidateUser(user.id);
      });
      if (alert !== undefined) ctx.afterCommit(alert);
      return issued;
    });
    return { session, user: toCustomerUserDto(user) };
  }

  return {
    sessions,
    credentials,
    passwords: passwordService,

    async register(input, meta) {
      await credentials.captcha.enforce(meta.ip, undefined, input.captchaToken);
      // Policy depends only on the input, so a 422 here reveals nothing about the email (R-07).
      assertPasswordPolicy(
        input.password,
        { email: input.email, firstName: input.firstName, lastName: input.lastName ?? null },
        'password',
      );
      // Hash first on BOTH paths so latency does not reveal whether the email exists (R-07).
      const passwordHash = await container.passwords.hash(input.password);
      const existing = await findUserByEmail(db, input.email);
      if (existing !== null) {
        await sendAccountExistsNotice(existing);
        return;
      }

      let phone: string | null = input.phone ?? null;
      if (phone !== null) {
        const owner = await db.user.findUnique({ where: { phone }, select: { id: true } });
        if (owner !== null) phone = null; // silently not attached (enumeration-safe)
      }
      const now = clock();
      const userId = randomUUID();
      const raw = generateOpaqueToken();
      const consent = input.marketingConsent ?? { email: false, whatsapp: false };
      try {
        await withTransaction(db, async (ctx) => {
          const { tx } = ctx;
          await tx.user.create({
            data: {
              id: userId,
              accountType: 'CUSTOMER',
              email: input.email,
              emailNormalized: input.email,
              phone,
              passwordHash,
              passwordChangedAt: now,
              firstName: input.firstName,
              lastName: input.lastName ?? null,
              status: 'PENDING_VERIFICATION',
            },
          });
          await tx.notificationPreference.createMany({
            data: (['EMAIL', 'WHATSAPP'] as const).map((channel) => {
              const optedIn = channel === 'EMAIL' ? consent.email : consent.whatsapp;
              return {
                id: randomUUID(),
                userId,
                channel,
                category: 'MARKETING' as const,
                isOptedIn: optedIn,
                consentSource: 'registration',
                consentedAt: optedIn ? now : null,
                ipAddress: truncate(meta.ip, 45),
              };
            }),
          });
          await createVerificationRow(tx, {
            userId,
            purpose: 'EMAIL_VERIFICATION',
            channel: 'EMAIL',
            target: input.email,
            tokenHash: hashToken(raw, pepper),
            expiresAt: addMinutes(now, config.auth.verificationTtlMinutes),
            ipAddress: truncate(meta.ip, 45),
            now,
          });
          await container.audit.record(tx, userActor(meta, userId, 'storefront'), {
            action: 'CREATE',
            module: 'auth',
            entityType: 'User',
            entityId: userId,
            eventKey: 'auth.registered',
            diff: false,
            after: {
              accountType: 'CUSTOMER',
              status: 'PENDING_VERIFICATION',
              email: maskEmail(input.email),
              phoneAttached: phone !== null,
              marketingConsent: consent,
            },
          });
          ctx.afterCommit(() =>
            sendVerificationLink({ email: input.email, firstName: input.firstName }, raw),
          );
        });
      } catch (error) {
        // Race on the unique email index → same generic 202 (R-07). Other errors propagate.
        if (isPrismaKnownError(error) && error.code === 'P2002') return;
        throw error;
      }
    },

    async login(input, meta) {
      const user = await credentials.verifyLogin({
        email: input.email,
        password: input.password,
        captchaToken: input.captchaToken,
        audience: 'storefront',
        meta,
      });
      // Parameters below current policy → transparent re-hash (§4.1); never fails the login.
      if (container.passwords.needsRehash(user.passwordHash ?? '')) {
        try {
          const upgraded = await container.passwords.hash(input.password);
          await db.user.update({ where: { id: user.id }, data: { passwordHash: upgraded } });
        } catch (error) {
          container.logger.warn({ err: error, userId: user.id }, 'password re-hash failed');
        }
      }
      return finishLogin(user, meta, input.rememberMe);
    },

    async refresh(rawToken, meta) {
      const { session, user } = await sessions.refresh(rawToken, 'storefront', meta);
      return { session, user: toCustomerUserDto(user) };
    },

    async verifyEmail(rawToken, meta) {
      const now = clock();
      const found = await loadUsableToken(container, rawToken, 'EMAIL_VERIFICATION');
      if (found === null) {
        // Idempotent: an already-used link of an already-verified account answers 200.
        const used = await db.verificationToken.findUnique({
          where: { tokenHash: hashToken(rawToken, pepper) },
          select: {
            purpose: true,
            consumedAt: true,
            user: { select: { emailVerifiedAt: true, status: true } },
          },
        });
        if (
          used?.purpose === 'EMAIL_VERIFICATION' &&
          used.consumedAt !== null &&
          used.user.emailVerifiedAt !== null
        ) {
          return { status: used.user.status };
        }
        throw tokenInvalid();
      }
      const { token, user } = found;
      if (user.accountType !== 'CUSTOMER') throw tokenInvalid();
      const status = user.status === 'PENDING_VERIFICATION' ? 'ACTIVE' : user.status;
      await withTransaction(db, async (ctx) => {
        const { tx } = ctx;
        if (!(await consumeVerification(tx, token.id, now))) throw tokenInvalid();
        await tx.user.update({
          where: { id: user.id },
          data: { emailVerifiedAt: user.emailVerifiedAt ?? now, status },
        });
        await container.audit.record(tx, userActor(meta, user.id, 'storefront'), {
          action: 'UPDATE',
          module: 'auth',
          entityType: 'User',
          entityId: user.id,
          eventKey: 'auth.email_verified',
          before: { status: user.status, emailVerified: user.emailVerifiedAt !== null },
          after: { status, emailVerified: true },
        });
        ctx.afterCommit(() => {
          container.permissions.invalidateUser(user.id);
        });
      });
      return { status };
    },

    async resendVerification(email, meta) {
      const user = await findUserByEmail(db, email);
      if (
        user?.accountType !== 'CUSTOMER' ||
        user.deletedAt !== null ||
        user.emailVerifiedAt !== null ||
        (user.status !== 'PENDING_VERIFICATION' && user.status !== 'ACTIVE')
      ) {
        return;
      }
      const coolKey = `resend:cool:${user.id}`;
      if (store.get(coolKey) !== undefined) return;
      if (store.increment(`resend:hour:${user.id}`, 3600) > RESEND_PER_HOUR_ACCOUNT) return;
      store.set(coolKey, true, RESEND_COOLDOWN_SECONDS);
      await issueVerificationEmail(user, meta);
    },

    async sendOtp(input, meta, authUserId) {
      if (input.purpose === 'LOGIN') {
        throw otpUnsupported('purpose', 'Sign-in with a one-time code is not available.');
      }
      if (input.purpose === 'VERIFY_EMAIL') {
        throw otpUnsupported('purpose', 'Email addresses are verified with the emailed link.');
      }
      if (input.channel !== 'WHATSAPP') {
        throw otpUnsupported('channel', 'Codes can currently be sent on WhatsApp only.');
      }
      const target = normalizePhone(input.destination);
      if (target === undefined) {
        throw new AppError('VALIDATION_ERROR', undefined, {
          details: [{ field: 'destination', message: 'Enter a valid Indian mobile number (+91).' }],
        });
      }
      // Throttles (§6.3) — silent: the response is identical either way.
      const ipCount = store.increment(`otp:ip:${meta.ip ?? 'unknown'}`, 3600);
      if (ipCount > OTP_PER_HOUR_IP) {
        throw new AppError(
          'RATE_LIMITED',
          'Too many attempts. Please try again in a few minutes.',
          {
            headers: { 'Retry-After': '3600' },
          },
        );
      }
      if (store.get(`otp:cool:${target}`) !== undefined) return;

      const user = await db.user.findUnique({
        where: { phone: target },
        select: { id: true, accountType: true, deletedAt: true, phoneVerifiedAt: true },
      });
      if (
        user?.accountType !== 'CUSTOMER' ||
        user.deletedAt !== null ||
        user.phoneVerifiedAt !== null ||
        (authUserId !== undefined && authUserId !== user.id)
      ) {
        return;
      }
      if (store.increment(`otp:hour:${target}`, 3600) > OTP_PER_HOUR_TARGET) return;
      if (store.increment(`otp:day:${target}`, 24 * 3600) > OTP_PER_DAY_TARGET) return;
      store.set(`otp:cool:${target}`, true, OTP_RESEND_SECONDS);

      const now = clock();
      const code = generateOtp(6);
      const rowId = randomUUID();
      await withTransaction(db, async (ctx) => {
        const { tx } = ctx;
        await invalidateOpenTokens(tx, user.id, 'PHONE_VERIFICATION', now);
        await createVerificationRow(tx, {
          id: rowId,
          userId: user.id,
          purpose: 'PHONE_VERIFICATION',
          channel: 'WHATSAPP',
          target,
          tokenHash: otpHash(rowId, code),
          expiresAt: addMinutes(now, OTP_TTL_MINUTES),
          ipAddress: truncate(meta.ip, 45),
          maxAttempts: OTP_MAX_ATTEMPTS,
          now,
        });
        ctx.afterCommit(async () => {
          try {
            await container.providers.whatsapp.send({
              to: target,
              templateKey: 'OTP_VERIFY_PHONE',
              variables: { code, expiresInMinutes: OTP_TTL_MINUTES },
            });
          } catch (error) {
            container.logger.warn({ err: error }, 'OTP delivery failed');
          }
        });
      });
    },

    async verifyOtp(input, meta, authUserId) {
      if (input.purpose !== 'VERIFY_PHONE') {
        throw otpUnsupported('purpose', 'This verification method is not available.');
      }
      const target = normalizePhone(input.destination);
      if (target === undefined) throw otpError('OTP_INVALID');
      const now = clock();
      const token = await db.verificationToken.findFirst({
        where: {
          target,
          purpose: 'PHONE_VERIFICATION',
          consumedAt: null,
          invalidatedAt: null,
          ...(authUserId === undefined ? {} : { userId: authUserId }),
        },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          userId: true,
          tokenHash: true,
          attemptCount: true,
          maxAttempts: true,
          expiresAt: true,
        },
      });
      if (token === null) throw otpError('OTP_INVALID');
      if (token.expiresAt <= now) throw otpError('OTP_EXPIRED');
      if (token.attemptCount >= token.maxAttempts) throw otpError('OTP_ATTEMPTS_EXCEEDED');
      if (!safeEqualHex(otpHash(token.id, input.otp), token.tokenHash)) {
        const attempts = token.attemptCount + 1;
        await db.verificationToken.update({
          where: { id: token.id },
          data: {
            attemptCount: { increment: 1 },
            ...(attempts >= token.maxAttempts ? { invalidatedAt: now } : {}),
          },
        });
        throw otpError(attempts >= token.maxAttempts ? 'OTP_ATTEMPTS_EXCEEDED' : 'OTP_INVALID');
      }
      await withTransaction(db, async (ctx) => {
        const { tx } = ctx;
        if (!(await consumeVerification(tx, token.id, now))) throw otpError('OTP_INVALID');
        const updated = await tx.user.updateMany({
          where: { id: token.userId, phone: target, deletedAt: null },
          data: { phoneVerifiedAt: now },
        });
        if (updated.count !== 1) throw otpError('OTP_INVALID'); // phone changed meanwhile
        await container.audit.record(tx, userActor(meta, token.userId, 'storefront'), {
          action: 'UPDATE',
          module: 'auth',
          entityType: 'User',
          entityId: token.userId,
          eventKey: 'auth.phone_verified',
          diff: false,
          metadata: { channel: 'WHATSAPP' },
        });
        ctx.afterCommit(() => {
          container.permissions.invalidateUser(token.userId);
        });
      });
    },
  };
}

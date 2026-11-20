/**
 * Staff auth controller — API_DOCUMENTATION.md §4.1.
 */
import type { Request, Response } from 'express';

import type { AppContainer } from '../../container.js';
import { AppError } from '../../core/errors/AppError.js';
import { readRefreshCookie } from '../../core/http/cookies.js';
import { ok } from '../../core/http/envelope.js';
import { requireAuthz } from '../../core/middleware/auth.js';
import { getValidated } from '../../core/middleware/validate.js';
import {
  bearerIdentity,
  clearCookieOnAuthError,
  clearSessionCookie,
  requestMeta,
  setSessionCookie,
} from '../auth/auth.http.js';
import {
  AcceptInviteBody,
  AdminLoginBody,
  ChangePasswordBody,
  EmailOnlyBody,
  LogoutBody,
  MfaConfirmBody,
  MfaEnrollBody,
  MfaVerifyBody,
  ReauthBody,
  ResetPasswordBody,
  SessionIdParams,
} from './admin-auth.schemas.js';
import type {
  AdminAuthService,
  StaffEnrollmentRequiredResult,
  StaffLoginResult,
} from './admin-auth.service.js';

const AUDIENCE = 'admin';

function loginPayload(result: StaffLoginResult) {
  return {
    accessToken: result.session.accessToken,
    tokenType: 'Bearer' as const,
    expiresIn: result.session.expiresIn,
    user: result.user,
  };
}

/** No session and no cookie: the client must call mfa/enroll then mfa/confirm with this token. */
function enrollmentPayload(result: StaffEnrollmentRequiredResult) {
  return {
    mfaEnrollmentRequired: true as const,
    enrollmentToken: result.enrollmentToken,
    expiresIn: result.expiresIn,
  };
}

export function createAdminAuthController(container: AppContainer, service: AdminAuthService) {
  const sendSession = (req: Request, res: Response, result: StaffLoginResult): void => {
    setSessionCookie(container, res, AUDIENCE, result.session);
    ok(req, res, loginPayload(result));
  };
  const sendSessionOrEnrollment = (
    req: Request,
    res: Response,
    result: StaffLoginResult | StaffEnrollmentRequiredResult,
  ): void => {
    if (result.kind === 'enrollment') {
      ok(req, res, enrollmentPayload(result));
      return;
    }
    sendSession(req, res, result);
  };

  return {
    login: async (req: Request, res: Response): Promise<void> => {
      const result = await service.login(
        getValidated(req, 'body', AdminLoginBody),
        requestMeta(req, AUDIENCE),
      );
      if (result.kind === 'mfa') {
        ok(req, res, {
          mfaRequired: true,
          mfaChallengeId: result.mfaChallengeId,
          expiresIn: result.expiresIn,
        });
        return;
      }
      sendSessionOrEnrollment(req, res, result);
    },

    enrollMfa: async (req: Request, res: Response): Promise<void> => {
      const { enrollmentToken } = getValidated(req, 'body', MfaEnrollBody);
      const result = await service.enrollMfa(
        { enrollmentToken, ctx: enrollmentToken === undefined ? req.authz : undefined },
        requestMeta(req, AUDIENCE),
      );
      // The secret is shown exactly once (manual entry fallback for the QR code); responses are
      // `Cache-Control: no-store` globally and the secret is never logged or stored unencrypted.
      ok(req, res, result);
    },

    confirmMfa: async (req: Request, res: Response): Promise<void> => {
      const { enrollmentToken, totpCode } = getValidated(req, 'body', MfaConfirmBody);
      const result = await service.confirmMfa(
        { enrollmentToken, ctx: enrollmentToken === undefined ? req.authz : undefined },
        totpCode,
        requestMeta(req, AUDIENCE),
      );
      if (result.kind === 'enabled') {
        ok(req, res, { mfaEnabled: true });
        return;
      }
      sendSession(req, res, result);
    },

    verifyMfa: async (req: Request, res: Response): Promise<void> => {
      const result = await service.verifyMfa(
        getValidated(req, 'body', MfaVerifyBody),
        requestMeta(req, AUDIENCE),
      );
      sendSession(req, res, result);
    },

    refresh: async (req: Request, res: Response): Promise<void> => {
      const raw = readRefreshCookie(req, AUDIENCE);
      if (raw === undefined) {
        clearSessionCookie(container, res, AUDIENCE);
        throw new AppError('UNAUTHENTICATED', 'Please sign in to continue.');
      }
      let result: StaffLoginResult;
      try {
        result = await service.refresh(raw, requestMeta(req, AUDIENCE));
      } catch (error) {
        clearCookieOnAuthError(container, res, AUDIENCE, error);
      }
      sendSession(req, res, result);
    },

    logout: async (req: Request, res: Response): Promise<void> => {
      const { allDevices } = getValidated(req, 'body', LogoutBody);
      const raw = readRefreshCookie(req, AUDIENCE);
      const bearer = bearerIdentity(req, container, AUDIENCE);
      await service.sessions.logout(
        AUDIENCE,
        {
          ...(raw === undefined ? {} : { rawToken: raw }),
          ...(bearer === undefined ? {} : { userId: bearer.userId, sid: bearer.sid }),
        },
        allDevices,
        requestMeta(req, AUDIENCE),
      );
      clearSessionCookie(container, res, AUDIENCE);
      ok(req, res, { loggedOut: true });
    },

    forgotPassword: async (req: Request, res: Response): Promise<void> => {
      const { email } = getValidated(req, 'body', EmailOnlyBody);
      await service.passwords.forgot(email, requestMeta(req, AUDIENCE));
      ok(req, res, { sent: true }, { status: 202 });
    },

    resetPassword: async (req: Request, res: Response): Promise<void> => {
      const { token, newPassword } = getValidated(req, 'body', ResetPasswordBody);
      await service.passwords.reset(token, newPassword, requestMeta(req, AUDIENCE));
      ok(req, res, { reset: true });
    },

    acceptInvite: async (req: Request, res: Response): Promise<void> => {
      const result = await service.acceptInvite(
        getValidated(req, 'body', AcceptInviteBody),
        requestMeta(req, AUDIENCE),
      );
      sendSessionOrEnrollment(req, res, result);
    },

    me: async (req: Request, res: Response): Promise<void> => {
      ok(req, res, await service.me(requireAuthz(req)));
    },

    reauth: async (req: Request, res: Response): Promise<void> => {
      const result = await service.reauth(
        requireAuthz(req),
        getValidated(req, 'body', ReauthBody),
        requestMeta(req, AUDIENCE),
      );
      ok(req, res, result);
    },

    changePassword: async (req: Request, res: Response): Promise<void> => {
      const ctx = requireAuthz(req);
      const body = getValidated(req, 'body', ChangePasswordBody);
      await service.passwords.change({
        userId: ctx.userId,
        sid: ctx.sid,
        currentPassword: body.currentPassword,
        newPassword: body.newPassword,
        signOutOtherDevices: body.signOutOtherDevices,
        meta: requestMeta(req, AUDIENCE),
      });
      ok(req, res, { changed: true });
    },

    listSessions: async (req: Request, res: Response): Promise<void> => {
      const ctx = requireAuthz(req);
      ok(req, res, await service.sessions.list(ctx.userId, AUDIENCE, ctx.sid));
    },

    revokeSession: async (req: Request, res: Response): Promise<void> => {
      const ctx = requireAuthz(req);
      const { sessionId } = getValidated(req, 'params', SessionIdParams);
      await service.sessions.revokeOwn(ctx.userId, AUDIENCE, sessionId, requestMeta(req, AUDIENCE));
      ok(req, res, { id: sessionId, deleted: true, current: sessionId === ctx.sid });
    },
  };
}

/**
 * Customer auth controller — HTTP adapter for `auth.service.ts` (API_DOCUMENTATION.md §3.1).
 */
import type { Request, Response } from 'express';

import type { AppContainer } from '../../container.js';
import { AppError } from '../../core/errors/AppError.js';
import { readRefreshCookie } from '../../core/http/cookies.js';
import { ok } from '../../core/http/envelope.js';
import { getValidated } from '../../core/middleware/validate.js';
import {
  bearerIdentity,
  clearCookieOnAuthError,
  clearSessionCookie,
  requestMeta,
  setSessionCookie,
} from './auth.http.js';
import {
  EmailOnlyBody,
  LoginBody,
  LogoutBody,
  OtpSendBody,
  OtpVerifyBody,
  RegisterBody,
  ResetPasswordBody,
  VerifyEmailBody,
} from './auth.schemas.js';
import {
  OTP_RESEND_SECONDS,
  OTP_TTL_MINUTES,
  REGISTER_ACCEPTED,
  type AuthService,
  type LoginResult,
} from './auth.service.js';

const AUDIENCE = 'storefront';

function loginPayload(result: LoginResult) {
  return {
    accessToken: result.session.accessToken,
    tokenType: 'Bearer' as const,
    expiresIn: result.session.expiresIn,
    user: result.user,
  };
}

export function createAuthController(container: AppContainer, service: AuthService) {
  return {
    register: async (req: Request, res: Response): Promise<void> => {
      await service.register(getValidated(req, 'body', RegisterBody), requestMeta(req, AUDIENCE));
      ok(req, res, REGISTER_ACCEPTED, { status: 202 });
    },

    login: async (req: Request, res: Response): Promise<void> => {
      const result = await service.login(
        getValidated(req, 'body', LoginBody),
        requestMeta(req, AUDIENCE),
      );
      setSessionCookie(container, res, AUDIENCE, result.session);
      ok(req, res, loginPayload(result));
    },

    refresh: async (req: Request, res: Response): Promise<void> => {
      const raw = readRefreshCookie(req, AUDIENCE);
      if (raw === undefined) {
        clearSessionCookie(container, res, AUDIENCE);
        throw new AppError('UNAUTHENTICATED', 'Please sign in to continue.');
      }
      let result: LoginResult;
      try {
        result = await service.refresh(raw, requestMeta(req, AUDIENCE));
      } catch (error) {
        clearCookieOnAuthError(container, res, AUDIENCE, error);
      }
      setSessionCookie(container, res, AUDIENCE, result.session);
      ok(req, res, loginPayload(result));
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

    verifyEmail: async (req: Request, res: Response): Promise<void> => {
      const { token } = getValidated(req, 'body', VerifyEmailBody);
      const { status } = await service.verifyEmail(token, requestMeta(req, AUDIENCE));
      ok(req, res, { verified: true, user: { status } });
    },

    resendVerification: async (req: Request, res: Response): Promise<void> => {
      const { email } = getValidated(req, 'body', EmailOnlyBody);
      await service.resendVerification(email, requestMeta(req, AUDIENCE));
      ok(req, res, { sent: true }, { status: 202 });
    },

    sendOtp: async (req: Request, res: Response): Promise<void> => {
      await service.sendOtp(
        getValidated(req, 'body', OtpSendBody),
        requestMeta(req, AUDIENCE),
        req.authz?.userId,
      );
      ok(req, res, {
        sent: true,
        expiresIn: OTP_TTL_MINUTES * 60,
        resendAfter: OTP_RESEND_SECONDS,
      });
    },

    verifyOtp: async (req: Request, res: Response): Promise<void> => {
      await service.verifyOtp(
        getValidated(req, 'body', OtpVerifyBody),
        requestMeta(req, AUDIENCE),
        req.authz?.userId,
      );
      ok(req, res, { verified: true });
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
  };
}

/**
 * Customer auth routes (mounted at `/api/v1`) — API_DOCUMENTATION.md §3.1.
 *
 * | Route                          | Rate class    | Notes                                       |
 * | POST /auth/register            | auth-strict   | always 202 (R-07)                           |
 * | POST /auth/login               | auth-strict   | sets sf_rt                                  |
 * | POST /auth/logout              | auth-refresh  | cookie endpoint: Origin + X-Client required |
 * | POST /auth/refresh             | auth-refresh  | cookie endpoint: Origin + X-Client required |
 * | POST /auth/verify-email        | auth-strict   |                                             |
 * | POST /auth/resend-verification | auth-strict   | always 202                                  |
 * | POST /auth/otp/send            | auth-strict   | VERIFY_PHONE only (D-41, D-46)              |
 * | POST /auth/otp/verify          | auth-strict   |                                             |
 * | POST /auth/forgot-password     | auth-strict   | always 202                                  |
 * | POST /auth/reset-password      | auth-strict   |                                             |
 */
import { Router } from 'express';

import type { AppContainer } from '../../container.js';
import { respondsWith } from '../../core/http/successStatus.js';
import { requireCookieOrigin } from '../../core/http/cookies.js';
import { validate } from '../../core/middleware/validate.js';
import { appOrigin } from './auth.context.js';
import { createAuthController } from './auth.controller.js';
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
import type { AuthService } from './auth.service.js';

export function createAuthRouter(container: AppContainer, service: AuthService): Router {
  const router = Router();
  const c = createAuthController(container, service);
  const strict = container.rateLimit('auth-strict');
  const refreshLimit = container.rateLimit('auth-refresh');
  const cookieGuard = requireCookieOrigin('storefront', appOrigin(container, 'storefront'));

  router.post(
    '/auth/register',
    strict,
    validate({ body: RegisterBody }),
    respondsWith(202),
    c.register,
  );
  router.post('/auth/login', strict, validate({ body: LoginBody }), c.login);
  router.post('/auth/logout', cookieGuard, refreshLimit, validate({ body: LogoutBody }), c.logout);
  router.post('/auth/refresh', cookieGuard, refreshLimit, c.refresh);
  router.post('/auth/verify-email', strict, validate({ body: VerifyEmailBody }), c.verifyEmail);
  router.post(
    '/auth/resend-verification',
    strict,
    validate({ body: EmailOnlyBody }),
    respondsWith(202),
    c.resendVerification,
  );
  router.post(
    '/auth/otp/send',
    strict,
    container.auth.optionalAuthenticate('storefront'),
    validate({ body: OtpSendBody }),
    c.sendOtp,
  );
  router.post(
    '/auth/otp/verify',
    strict,
    container.auth.optionalAuthenticate('storefront'),
    validate({ body: OtpVerifyBody }),
    c.verifyOtp,
  );
  router.post(
    '/auth/forgot-password',
    strict,
    validate({ body: EmailOnlyBody }),
    respondsWith(202),
    c.forgotPassword,
  );
  router.post(
    '/auth/reset-password',
    strict,
    validate({ body: ResetPasswordBody }),
    c.resetPassword,
  );
  return router;
}

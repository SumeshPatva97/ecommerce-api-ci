/**
 * Staff auth routes (mounted at `/api/v1/admin`) — API_DOCUMENTATION.md §4.1, PROJECT_CONTEXT
 * §15 R-13.
 *
 * Before admin authentication (`adminPublicRouter`):
 * | POST /auth/login           | auth-strict  | MFA step-up when enabled              |
 * | POST /auth/mfa/verify      | auth-strict  | challenge-bound                       |
 * | POST /auth/mfa/enroll      | auth-strict  | enrollmentToken OR optional admin Bearer |
 * | POST /auth/mfa/confirm     | auth-strict  | enrollmentToken OR optional admin Bearer |
 * | POST /auth/logout          | auth-refresh | cookie endpoint: Origin + X-Client    |
 * | POST /auth/refresh         | auth-refresh | cookie endpoint: Origin + X-Client    |
 * | POST /auth/forgot-password | auth-strict  | always 202                            |
 * | POST /auth/reset-password  | auth-strict  |                                       |
 * | POST /auth/accept-invite   | auth-strict  |                                       |
 *
 * After `authenticate('admin')` (`adminRouter`, self-service — no permission key):
 * | GET    /auth/me                  | admin-read (router level) |
 * | POST   /auth/reauth              | auth-strict               |
 * | POST   /auth/change-password     | auth-strict               |
 * | GET    /auth/sessions            | admin-read (router level) |
 * | DELETE /auth/sessions/:sessionId | admin-write               |
 */
import { Router } from 'express';

import type { AppContainer } from '../../container.js';
import { respondsWith } from '../../core/http/successStatus.js';
import { requireCookieOrigin } from '../../core/http/cookies.js';
import { validate } from '../../core/middleware/validate.js';
import { appOrigin } from '../auth/auth.context.js';
import { createAdminAuthController } from './admin-auth.controller.js';
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
import type { AdminAuthService } from './admin-auth.service.js';

export const ADMIN_SELF_SERVICE_PATHS = [
  '/auth/me',
  '/auth/reauth',
  '/auth/change-password',
  '/auth/sessions',
  '/auth/sessions/:sessionId',
] as const;

export function createAdminAuthRouters(
  container: AppContainer,
  service: AdminAuthService,
): { adminPublicRouter: Router; adminRouter: Router } {
  const c = createAdminAuthController(container, service);
  const strict = container.rateLimit('auth-strict');
  const refreshLimit = container.rateLimit('auth-refresh');
  const cookieGuard = requireCookieOrigin('admin', appOrigin(container, 'admin'));

  const pub = Router();
  pub.post('/auth/login', strict, validate({ body: AdminLoginBody }), c.login);
  pub.post('/auth/mfa/verify', strict, validate({ body: MfaVerifyBody }), c.verifyMfa);
  // Before router-level admin authentication: the login flow has no session yet. A Bearer token,
  // when present, is verified (optional) for voluntary enrolment by signed-in staff.
  const optionalAdmin = container.auth.optionalAuthenticate('admin');
  pub.post(
    '/auth/mfa/enroll',
    strict,
    optionalAdmin,
    validate({ body: MfaEnrollBody }),
    c.enrollMfa,
  );
  pub.post(
    '/auth/mfa/confirm',
    strict,
    optionalAdmin,
    validate({ body: MfaConfirmBody }),
    c.confirmMfa,
  );
  pub.post('/auth/logout', cookieGuard, refreshLimit, validate({ body: LogoutBody }), c.logout);
  pub.post('/auth/refresh', cookieGuard, refreshLimit, c.refresh);
  pub.post(
    '/auth/forgot-password',
    strict,
    validate({ body: EmailOnlyBody }),
    respondsWith(202),
    c.forgotPassword,
  );
  pub.post('/auth/reset-password', strict, validate({ body: ResetPasswordBody }), c.resetPassword);
  pub.post('/auth/accept-invite', strict, validate({ body: AcceptInviteBody }), c.acceptInvite);

  const admin = Router();
  admin.get('/auth/me', c.me);
  admin.post('/auth/reauth', strict, validate({ body: ReauthBody }), c.reauth);
  admin.post(
    '/auth/change-password',
    strict,
    validate({ body: ChangePasswordBody }),
    c.changePassword,
  );
  admin.get('/auth/sessions', c.listSessions);
  admin.delete(
    '/auth/sessions/:sessionId',
    container.rateLimit('admin-write'),
    validate({ params: SessionIdParams }),
    c.revokeSession,
  );
  return { adminPublicRouter: pub, adminRouter: admin };
}

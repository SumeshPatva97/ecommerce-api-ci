/**
 * Customer profile & session routes (mounted at `/api/v1`) — API_DOCUMENTATION.md §3.2,
 * PROJECT_CONTEXT §15 R-13. Every route authenticates per route (storefront audience) so this
 * router never intercepts other modules' public paths.
 *
 * | GET    /me                     | customer | general limiter            |
 * | PATCH  /me                     | customer | profile-write              |
 * | POST   /me/change-password     | customer | auth-strict (§2.8)         |
 * | GET    /me/sessions            | customer | general limiter            |
 * | DELETE /me/sessions/:sessionId | customer | profile-write              |
 *
 * Addresses, notification preferences and recently viewed live in separate `me.*` files owned
 * by their increments.
 */
import { Router } from 'express';

import type { AppContainer } from '../../container.js';
import { validate } from '../../core/middleware/validate.js';
import type { PasswordService } from '../auth/password.service.js';
import type { SessionService } from '../auth/session.service.js';
import { createMeProfileController } from './me.profile.controller.js';
import { ChangePasswordBody, SessionIdParams, UpdateMeBody } from './me.profile.schemas.js';
import type { MeProfileService } from './me.profile.service.js';
import { createMeSessionsController } from './me.sessions.controller.js';

export function createMeProfileRouter(
  container: AppContainer,
  deps: {
    readonly profile: MeProfileService;
    readonly passwords: PasswordService;
    readonly sessions: SessionService;
  },
): Router {
  const router = Router();
  const auth = container.auth.authenticate('storefront');
  const profileWrite = container.rateLimit('profile-write');
  const c = createMeProfileController(deps.profile, deps.passwords);
  const s = createMeSessionsController(deps.sessions);

  router.get('/me', auth, c.get);
  router.patch('/me', auth, profileWrite, validate({ body: UpdateMeBody }), c.update);
  router.post(
    '/me/change-password',
    auth,
    container.rateLimit('auth-strict'),
    validate({ body: ChangePasswordBody }),
    c.changePassword,
  );
  router.get('/me/sessions', auth, s.list);
  router.delete(
    '/me/sessions/:sessionId',
    auth,
    profileWrite,
    validate({ params: SessionIdParams }),
    s.revoke,
  );
  return router;
}

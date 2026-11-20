/**
 * Notification routes — API_DOCUMENTATION.md §3.2 and §4.16.
 *
 * | GET   /me/notification-preferences                   | customer | general limiter |
 * | PATCH /me/notification-preferences                   | customer | profile-write   |
 * | GET   /admin/notifications/templates                 | notifications.view   | admin-read  |
 * | PATCH /admin/notifications/templates/:templateId     | notifications.update | admin-write |
 * | GET   /admin/notifications/logs                      | notifications.view   | admin-read  |
 * | POST  /admin/notifications/:notificationId/resend    | notifications.update | admin-write |
 */
import { Router, type Request, type Response } from 'express';

import type { AppContainer } from '../../container.js';
import { ok } from '../../core/http/envelope.js';
import { respondsWith } from '../../core/http/successStatus.js';
import { actorFromRequest, requireAuthz } from '../../core/middleware/auth.js';
import { getValidated, validate } from '../../core/middleware/validate.js';
import type { NotificationsAdminService } from './notifications.admin.js';
import type { PreferencesService } from './notifications.preferences.js';
import {
  LogListQuery,
  NotificationIdParams,
  ResendBody,
  TemplateIdParams,
  TemplateListQuery,
  UpdatePreferencesBody,
  UpdateTemplateBody,
} from './notifications.schemas.js';

export function createNotificationsPublicRouter(
  c: AppContainer,
  prefs: PreferencesService,
): Router {
  const router = Router();
  const auth = c.auth.authenticate('storefront');
  router.get(
    '/me/notification-preferences',
    auth,
    async (req: Request, res: Response): Promise<void> => {
      ok(req, res, await prefs.get(requireAuthz(req).userId));
    },
  );
  router.patch(
    '/me/notification-preferences',
    auth,
    c.rateLimit('profile-write'),
    validate({ body: UpdatePreferencesBody }),
    async (req: Request, res: Response): Promise<void> => {
      const body = getValidated(req, 'body', UpdatePreferencesBody);
      ok(req, res, await prefs.update(actorFromRequest(req), requireAuthz(req).userId, body));
    },
  );
  return router;
}

export function createNotificationsAdminRouter(
  c: AppContainer,
  admin: NotificationsAdminService,
): Router {
  const router = Router();
  const write = c.rateLimit('admin-write');
  router.get(
    '/notifications/templates',
    c.auth.requirePermission('notifications.view'),
    validate({ query: TemplateListQuery }),
    async (req: Request, res: Response): Promise<void> => {
      const { items, meta } = await admin.listTemplates(
        getValidated(req, 'query', TemplateListQuery),
      );
      ok(req, res, items, { meta });
    },
  );
  router.patch(
    '/notifications/templates/:templateId',
    c.auth.requirePermission('notifications.update'),
    write,
    validate({ params: TemplateIdParams, body: UpdateTemplateBody }),
    async (req: Request, res: Response): Promise<void> => {
      const { templateId } = getValidated(req, 'params', TemplateIdParams);
      const body = getValidated(req, 'body', UpdateTemplateBody);
      ok(req, res, await admin.updateTemplate(actorFromRequest(req), templateId, body));
    },
  );
  router.get(
    '/notifications/logs',
    c.auth.requirePermission('notifications.view'),
    validate({ query: LogListQuery }),
    async (req: Request, res: Response): Promise<void> => {
      const { items, meta } = await admin.listLogs(getValidated(req, 'query', LogListQuery));
      ok(req, res, items, { meta });
    },
  );
  router.post(
    '/notifications/:notificationId/resend',
    c.auth.requirePermission('notifications.update'),
    write,
    validate({ params: NotificationIdParams, body: ResendBody }),
    respondsWith(200, 201),
    async (req: Request, res: Response): Promise<void> => {
      const { notificationId } = getValidated(req, 'params', NotificationIdParams);
      const body = getValidated(req, 'body', ResendBody);
      const result = await admin.resend(actorFromRequest(req), notificationId, body);
      ok(req, res, result, { status: result.replayed ? 200 : 201 });
    },
  );
  return router;
}

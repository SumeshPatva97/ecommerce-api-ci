/**
 * Settings routes — admin (`/api/v1/admin/settings`) and public (`/api/v1/settings/public`).
 */
import { Router } from 'express';

import type { AppContainer } from '../../container.js';
import { ok } from '../../core/http/envelope.js';
import { actorFromRequest, requireAuthz } from '../../core/middleware/auth.js';
import { getValidated, validate } from '../../core/middleware/validate.js';
import { AdminSettingsQuery, PatchSettingsBody } from './settings.schemas.js';
import type { SettingsService } from './settings.service.js';

export function createSettingsAdminRouter(c: AppContainer, service: SettingsService): Router {
  const r = Router();
  r.get(
    '/settings',
    c.auth.requirePermission('settings.view'),
    validate({ query: AdminSettingsQuery }),
    async (req, res) => {
      const { group } = getValidated(req, 'query', AdminSettingsQuery);
      ok(req, res, await service.listAdmin(group));
    },
  );
  r.patch(
    '/settings',
    c.auth.requirePermission('settings.update'),
    c.auth.requireReauth(),
    c.rateLimit('admin-write'),
    validate({ body: PatchSettingsBody }),
    async (req, res) => {
      const body = getValidated(req, 'body', PatchSettingsBody);
      ok(req, res, await service.patch(requireAuthz(req), actorFromRequest(req), body));
    },
  );
  return r;
}

export function createSettingsPublicRouter(c: AppContainer, service: SettingsService): Router {
  const r = Router();
  r.get('/settings/public', c.rateLimit('public-read'), async (req, res) => {
    ok(req, res, await service.getPublic());
  });
  return r;
}

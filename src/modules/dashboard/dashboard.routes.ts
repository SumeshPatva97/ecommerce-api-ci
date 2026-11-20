/**
 * Dashboard route (relative to `/api/v1/admin`) — API_DOCUMENTATION.md §4.2.
 * `GET /dashboard/summary` — `dashboard.view`; widgets filtered by module permissions.
 */
import { Router } from 'express';

import type { AppContainer } from '../../container.js';
import { ok } from '../../core/http/envelope.js';
import { requireAuthz } from '../../core/middleware/auth.js';
import { getValidated, validate } from '../../core/middleware/validate.js';
import { DashboardQuery } from './dashboard.schemas.js';
import type { DashboardService } from './dashboard.service.js';

export function createDashboardRouter(c: AppContainer, service: DashboardService): Router {
  const r = Router();
  r.get(
    '/dashboard/summary',
    c.auth.requirePermission('dashboard.view'),
    validate({ query: DashboardQuery }),
    async (req, res) => {
      const data = await service.summary(
        requireAuthz(req),
        getValidated(req, 'query', DashboardQuery),
      );
      res.set('Cache-Control', 'no-store');
      ok(req, res, data);
    },
  );
  return r;
}

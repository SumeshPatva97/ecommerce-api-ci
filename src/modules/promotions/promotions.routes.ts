/**
 * Admin promotion routes — API_DOCUMENTATION.md §4.9. Mounted under `/api/v1/admin` after
 * `authenticate('admin')` + `admin-read`; mutations add `admin-write`.
 */
import { Router } from 'express';

import type { AppContainer } from '../../container.js';
import { respondsWith } from '../../core/http/successStatus.js';
import { validate } from '../../core/middleware/validate.js';
import type { PromotionsController } from './promotions.controller.js';
import {
  CreatePromotionBody,
  PromotionIdParams,
  PromotionListQuery,
  UpdatePromotionBody,
} from './promotions.schemas.js';

export function createPromotionsAdminRouter(c: AppContainer, ctl: PromotionsController): Router {
  const perm = (key: string) => c.auth.requirePermission(key);
  const write = c.rateLimit('admin-write');
  const params = validate({ params: PromotionIdParams });
  const router = Router();
  router.get(
    '/promotions',
    perm('promotions.view'),
    validate({ query: PromotionListQuery }),
    ctl.list,
  );
  router.post(
    '/promotions',
    perm('promotions.create'),
    write,
    validate({ body: CreatePromotionBody }),
    respondsWith(201),
    ctl.create,
  );
  router.get('/promotions/:promotionId', perm('promotions.view'), params, ctl.get);
  router.patch(
    '/promotions/:promotionId',
    perm('promotions.update'),
    write,
    validate({ params: PromotionIdParams, body: UpdatePromotionBody }),
    ctl.update,
  );
  router.delete('/promotions/:promotionId', perm('promotions.delete'), write, params, ctl.remove);
  router.post(
    '/promotions/:promotionId/pause',
    perm('promotions.update'),
    write,
    params,
    ctl.pause,
  );
  router.post(
    '/promotions/:promotionId/resume',
    perm('promotions.update'),
    write,
    params,
    ctl.resume,
  );
  return router;
}

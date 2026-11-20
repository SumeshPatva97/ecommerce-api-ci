/**
 * Admin coupon routes — API_DOCUMENTATION.md §4.9. Mounted under `/api/v1/admin` after
 * `authenticate('admin')` + `admin-read`; mutations add `admin-write`.
 */
import { Router } from 'express';

import type { AppContainer } from '../../container.js';
import { respondsWith } from '../../core/http/successStatus.js';
import { validate } from '../../core/middleware/validate.js';
import type { CouponsController } from './coupons.controller.js';
import {
  CouponIdParams,
  CouponListQuery,
  CouponUsageQuery,
  CreateCouponBody,
  UpdateCouponBody,
} from './coupons.schemas.js';

export function createCouponsAdminRouter(c: AppContainer, ctl: CouponsController): Router {
  const perm = (key: string) => c.auth.requirePermission(key);
  const write = c.rateLimit('admin-write');
  const router = Router();
  router.get('/coupons', perm('coupons.view'), validate({ query: CouponListQuery }), ctl.list);
  router.post(
    '/coupons',
    perm('coupons.create'),
    write,
    validate({ body: CreateCouponBody }),
    respondsWith(201),
    ctl.create,
  );
  router.get(
    '/coupons/:couponId',
    perm('coupons.view'),
    validate({ params: CouponIdParams }),
    ctl.get,
  );
  router.patch(
    '/coupons/:couponId',
    perm('coupons.update'),
    write,
    validate({ params: CouponIdParams, body: UpdateCouponBody }),
    ctl.update,
  );
  router.delete(
    '/coupons/:couponId',
    perm('coupons.delete'),
    write,
    validate({ params: CouponIdParams }),
    ctl.remove,
  );
  router.get(
    '/coupons/:couponId/usage',
    perm('coupons.view'),
    validate({ params: CouponIdParams, query: CouponUsageQuery }),
    ctl.usage,
  );
  return router;
}

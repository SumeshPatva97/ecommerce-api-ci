/**
 * Admin coupon HTTP adapter (API_DOCUMENTATION.md §4.9).
 */
import type { Request, Response } from 'express';

import { ok } from '../../core/http/envelope.js';
import { actorFromRequest, requireAuthz } from '../../core/middleware/auth.js';
import { getValidated } from '../../core/middleware/validate.js';
import { hasPermission } from '../rbac/permission.service.js';
import {
  CouponIdParams,
  CouponListQuery,
  CouponUsageQuery,
  CreateCouponBody,
  UpdateCouponBody,
} from './coupons.schemas.js';
import type { CouponsService } from './coupons.service.js';

export function createCouponsController(service: CouponsService) {
  return {
    list: async (req: Request, res: Response): Promise<void> => {
      const { items, meta } = await service.list(getValidated(req, 'query', CouponListQuery));
      ok(req, res, items, { meta });
    },
    get: async (req: Request, res: Response): Promise<void> => {
      const { couponId } = getValidated(req, 'params', CouponIdParams);
      ok(req, res, await service.get(couponId));
    },
    create: async (req: Request, res: Response): Promise<void> => {
      const body = getValidated(req, 'body', CreateCouponBody);
      ok(req, res, await service.create(actorFromRequest(req), body), { status: 201 });
    },
    update: async (req: Request, res: Response): Promise<void> => {
      const { couponId } = getValidated(req, 'params', CouponIdParams);
      const body = getValidated(req, 'body', UpdateCouponBody);
      ok(req, res, await service.update(actorFromRequest(req), couponId, body));
    },
    remove: async (req: Request, res: Response): Promise<void> => {
      const { couponId } = getValidated(req, 'params', CouponIdParams);
      ok(req, res, await service.remove(actorFromRequest(req), couponId));
    },
    usage: async (req: Request, res: Response): Promise<void> => {
      const { couponId } = getValidated(req, 'params', CouponIdParams);
      const query = getValidated(req, 'query', CouponUsageQuery);
      // Unmasked customer e-mail only with customers.view (PII minimisation).
      const canSeePii = hasPermission(requireAuthz(req), 'customers.view');
      const { items, meta } = await service.usage(couponId, query, canSeePii);
      ok(req, res, items, { meta });
    },
  };
}

export type CouponsController = ReturnType<typeof createCouponsController>;

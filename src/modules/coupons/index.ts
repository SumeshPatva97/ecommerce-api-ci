/**
 * Coupons module (B5) — admin CRUD + usage report (API_DOCUMENTATION.md §4.9) and the coupon
 * usage lifecycle used by checkout (`reserveUsage` / `redeem` / `release`, DATABASE_DESIGN §17).
 */
import type { ModuleFactory } from '../types.js';
import { createCouponsController } from './coupons.controller.js';
import { createCouponsAdminRouter } from './coupons.routes.js';
import { createCouponsService } from './coupons.service.js';

export const createCouponsModule: ModuleFactory = (container) => {
  const service = createCouponsService(container);
  return {
    name: 'coupons',
    adminRouter: createCouponsAdminRouter(container, createCouponsController(service)),
  };
};

export {
  createCouponsService,
  type CouponsService,
  type UsageStatus,
  type UsageTransition,
} from './coupons.service.js';
export { couponInvalidError } from './coupons.errors.js';
export type { UsageReleaseReason } from './coupons.rules.js';

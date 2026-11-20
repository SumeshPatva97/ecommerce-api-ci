/**
 * Promotions module (B5) — admin CRUD + pause/resume (API_DOCUMENTATION.md §4.9) and the pricing
 * input loader shared by cart and checkout.
 */
import type { ModuleFactory } from '../types.js';
import { createPromotionsController } from './promotions.controller.js';
import { createPromotionsAdminRouter } from './promotions.routes.js';
import { createPromotionsService } from './promotions.service.js';

export const createPromotionsModule: ModuleFactory = (container) => {
  const service = createPromotionsService(container);
  return {
    name: 'promotions',
    adminRouter: createPromotionsAdminRouter(container, createPromotionsController(service)),
  };
};

export { createPromotionsService, type PromotionsService } from './promotions.service.js';
export {
  createPricingInputLoader,
  type CouponRef,
  type LoadedPricingInput,
  type PricingInputLoader,
  type PricingItemRef,
  type ProductPricingContext,
} from './pricing.loader.js';

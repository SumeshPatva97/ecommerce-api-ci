/**
 * Cart module (B5) — customer cart with server-side re-pricing (API_DOCUMENTATION.md §3.4).
 * `createCartService` is exported for the wishlist (move-to-cart) and checkout modules.
 */
import type { ModuleFactory } from '../types.js';
import { createCartController } from './cart.controller.js';
import { createCartRouter } from './cart.routes.js';
import { createCartService } from './cart.service.js';

export const createCartModule: ModuleFactory = (container) => {
  const service = createCartService(container);
  return { name: 'cart', publicRouter: createCartRouter(container, createCartController(service)) };
};

export {
  createCartService,
  loadAbandonAfterDays,
  loadMaxQtyPerLine,
  type CartService,
} from './cart.service.js';
export { ABANDONED_CART_PURGE_DAYS, DEFAULT_ABANDON_AFTER_DAYS } from './cart.rules.js';
export type { CartDto } from './cart.mapper.js';

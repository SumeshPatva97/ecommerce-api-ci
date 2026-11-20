/**
 * Wishlist module (B5) — API_DOCUMENTATION.md §3.5. Guest wishlists merge via repeated
 * `POST /wishlist/items` after login (no dedicated merge route in canon).
 */
import { createCartService } from '../cart/index.js';
import type { ModuleFactory } from '../types.js';
import { createWishlistRouter } from './wishlist.routes.js';
import { createWishlistService } from './wishlist.service.js';

export const createWishlistModule: ModuleFactory = (container) => {
  const service = createWishlistService(container, createCartService(container));
  return { name: 'wishlist', publicRouter: createWishlistRouter(container, service) };
};

export { createWishlistService, type WishlistService } from './wishlist.service.js';

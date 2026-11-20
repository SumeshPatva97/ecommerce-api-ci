/**
 * Cart routes (mounted at `/api/v1`) — API_DOCUMENTATION.md §3.4. Each route authenticates on its
 * own (storefront audience) so this router never intercepts other modules' public paths.
 *
 * | GET    /cart                 | customer | general limiter |
 * | POST   /cart/items           | customer | customer-write  |
 * | PATCH  /cart/items/:itemId   | customer | customer-write  |
 * | DELETE /cart/items/:itemId   | customer | customer-write  |
 * | POST   /cart/merge           | customer | customer-write  |
 * | POST   /cart/coupon          | customer | coupon-apply    |
 * | DELETE /cart/coupon          | customer | customer-write  |
 */
import { Router } from 'express';

import type { AppContainer } from '../../container.js';
import { respondsWith } from '../../core/http/successStatus.js';
import { validate } from '../../core/middleware/validate.js';
import type { CartController } from './cart.controller.js';
import {
  AddCartItemBody,
  ApplyCouponBody,
  CartItemParams,
  MergeCartBody,
  UpdateCartItemBody,
} from './cart.schemas.js';

export function createCartRouter(container: AppContainer, c: CartController): Router {
  const router = Router();
  const auth = container.auth.authenticate('storefront');
  const write = container.rateLimit('customer-write');

  router.get('/cart', auth, c.get);
  router.post(
    '/cart/items',
    auth,
    write,
    validate({ body: AddCartItemBody }),
    respondsWith(201),
    c.addItem,
  );
  router.patch(
    '/cart/items/:itemId',
    auth,
    write,
    validate({ params: CartItemParams, body: UpdateCartItemBody }),
    c.updateItem,
  );
  router.delete(
    '/cart/items/:itemId',
    auth,
    write,
    validate({ params: CartItemParams }),
    c.removeItem,
  );
  router.post('/cart/merge', auth, write, validate({ body: MergeCartBody }), c.merge);
  router.post(
    '/cart/coupon',
    auth,
    container.rateLimit('coupon-apply'),
    validate({ body: ApplyCouponBody }),
    c.applyCoupon,
  );
  router.delete('/cart/coupon', auth, write, c.removeCoupon);
  return router;
}

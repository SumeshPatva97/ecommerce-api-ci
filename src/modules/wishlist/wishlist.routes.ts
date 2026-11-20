/**
 * Wishlist routes (mounted at `/api/v1`) — API_DOCUMENTATION.md §3.5. Per-route storefront
 * authentication; mutations use the customer-write class.
 *
 * | GET    /wishlist                            | customer | general limiter |
 * | POST   /wishlist/items                      | customer | customer-write  |
 * | DELETE /wishlist/items/:itemId              | customer | customer-write  |
 * | POST   /wishlist/items/:itemId/move-to-cart | customer | customer-write  |
 */
import { Router, type Request, type Response } from 'express';

import type { AppContainer } from '../../container.js';
import { respondsWith } from '../../core/http/successStatus.js';
import { ok } from '../../core/http/envelope.js';
import { requireAuthz } from '../../core/middleware/auth.js';
import { getValidated, validate } from '../../core/middleware/validate.js';
import {
  AddWishlistItemBody,
  MoveToCartBody,
  WishlistItemParams,
  WishlistQuery,
} from './wishlist.schemas.js';
import type { WishlistService } from './wishlist.service.js';

export function createWishlistRouter(container: AppContainer, service: WishlistService): Router {
  const router = Router();
  const auth = container.auth.authenticate('storefront');
  const write = container.rateLimit('customer-write');

  router.get(
    '/wishlist',
    auth,
    validate({ query: WishlistQuery }),
    async (req: Request, res: Response): Promise<void> => {
      const query = getValidated(req, 'query', WishlistQuery);
      const { items, meta } = await service.list(requireAuthz(req).userId, query);
      ok(req, res, items, { meta });
    },
  );
  router.post(
    '/wishlist/items',
    auth,
    write,
    validate({ body: AddWishlistItemBody }),
    respondsWith(201),
    async (req: Request, res: Response): Promise<void> => {
      const body = getValidated(req, 'body', AddWishlistItemBody);
      ok(req, res, await service.add(requireAuthz(req).userId, body), { status: 201 });
    },
  );
  router.delete(
    '/wishlist/items/:itemId',
    auth,
    write,
    validate({ params: WishlistItemParams }),
    async (req: Request, res: Response): Promise<void> => {
      const { itemId } = getValidated(req, 'params', WishlistItemParams);
      ok(req, res, await service.remove(requireAuthz(req).userId, itemId));
    },
  );
  router.post(
    '/wishlist/items/:itemId/move-to-cart',
    auth,
    write,
    validate({ params: WishlistItemParams, body: MoveToCartBody }),
    async (req: Request, res: Response): Promise<void> => {
      const { itemId } = getValidated(req, 'params', WishlistItemParams);
      const body = getValidated(req, 'body', MoveToCartBody);
      ok(req, res, await service.moveToCart(requireAuthz(req).userId, itemId, body));
    },
  );
  return router;
}

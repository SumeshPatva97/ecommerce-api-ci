/**
 * Checkout routes (mounted at `/api/v1`) — API_DOCUMENTATION.md §3.9.
 *
 * | POST /checkout/summary | customer (ACTIVE, email verified) | checkout       | —                        |
 * | POST /checkout/orders  | customer (ACTIVE, email verified) | checkout-order | Idempotency-Key required |
 *
 * Each route authenticates on its own so this router never intercepts other modules' paths.
 */
import { Router, type Request, type Response } from 'express';

import type { AppContainer } from '../../container.js';
import { respondsWith } from '../../core/http/successStatus.js';
import { ok } from '../../core/http/envelope.js';
import { requireAuthz } from '../../core/middleware/auth.js';
import { getValidated, validate } from '../../core/middleware/validate.js';
import { requireVerifiedCustomer } from '../payments/index.js';
import { CheckoutSummaryBody, PlaceOrderBody } from './checkout.schemas.js';
import type { CheckoutService } from './checkout.service.js';

export function createCheckoutRouter(c: AppContainer, service: CheckoutService): Router {
  const router = Router();
  const auth = c.auth.authenticate('storefront');

  router.post(
    '/checkout/summary',
    auth,
    c.rateLimit('checkout'),
    requireVerifiedCustomer,
    validate({ body: CheckoutSummaryBody }),
    async (req: Request, res: Response): Promise<void> => {
      const { userId } = requireAuthz(req);
      ok(req, res, await service.summary(userId, getValidated(req, 'body', CheckoutSummaryBody)));
    },
  );

  router.post(
    '/checkout/orders',
    auth,
    c.rateLimit('checkout-order'),
    requireVerifiedCustomer,
    c.idempotency({ required: true }),
    validate({ body: PlaceOrderBody }),
    respondsWith(201),
    async (req: Request, res: Response): Promise<void> => {
      const { userId } = requireAuthz(req);
      const userAgent = req.get('user-agent');
      const placed = await service.placeOrder(userId, getValidated(req, 'body', PlaceOrderBody), {
        ip: req.ip,
        userAgent,
      });
      ok(req, res, placed, { status: 201 });
    },
  );
  return router;
}

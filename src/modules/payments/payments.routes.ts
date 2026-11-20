/**
 * Payments routes — API_DOCUMENTATION.md §3.9, §4.11, §5.
 *
 * | POST /payments/verify                        | customer (ACTIVE) | checkout | Idempotency-Key required |
 * | POST /me/orders/:orderNumber/retry-payment   | customer (ACTIVE) | checkout | Idempotency-Key required |
 * | GET  /admin/payments                         | payments.view     | admin-read (router level) |
 * | GET  /admin/payments/:paymentId              | payments.view     | admin-read (router level) |
 * | POST /webhooks/payments/:provider            | signature (raw)   | webhook  |
 *
 * Public routes authenticate per route so this router never intercepts other modules' paths.
 */
import { Router, type Request, type Response } from 'express';

import type { AppContainer } from '../../container.js';
import { ok } from '../../core/http/envelope.js';
import { requireAuthz } from '../../core/middleware/auth.js';
import { getValidated, validate } from '../../core/middleware/validate.js';
import { requireVerifiedCustomer } from './payments.guards.js';
import {
  AdminPaymentListQuery,
  OrderNumberParams,
  PaymentIdParams,
  VerifyPaymentBody,
} from './payments.schemas.js';
import type { PaymentsService } from './payments.service.js';

export function createPaymentsPublicRouter(c: AppContainer, service: PaymentsService): Router {
  const router = Router();
  const auth = c.auth.authenticate('storefront');
  const checkout = c.rateLimit('checkout');

  router.post(
    '/payments/verify',
    auth,
    checkout,
    requireVerifiedCustomer,
    c.idempotency({ required: true }),
    validate({ body: VerifyPaymentBody }),
    async (req: Request, res: Response): Promise<void> => {
      const { userId } = requireAuthz(req);
      ok(req, res, await service.verify(userId, getValidated(req, 'body', VerifyPaymentBody)));
    },
  );
  router.post(
    '/me/orders/:orderNumber/retry-payment',
    auth,
    checkout,
    requireVerifiedCustomer,
    c.idempotency({ required: true }),
    validate({ params: OrderNumberParams }),
    async (req: Request, res: Response): Promise<void> => {
      const { userId } = requireAuthz(req);
      const { orderNumber } = getValidated(req, 'params', OrderNumberParams);
      ok(req, res, await service.retryPayment(userId, orderNumber));
    },
  );
  return router;
}

export function createPaymentsAdminRouter(c: AppContainer, service: PaymentsService): Router {
  const router = Router();
  const view = c.auth.requirePermission('payments.view');
  router.get(
    '/payments',
    view,
    validate({ query: AdminPaymentListQuery }),
    async (req: Request, res: Response): Promise<void> => {
      const { items, meta } = await service.list(getValidated(req, 'query', AdminPaymentListQuery));
      ok(req, res, items, { meta });
    },
  );
  router.get(
    '/payments/:paymentId',
    view,
    validate({ params: PaymentIdParams }),
    async (req: Request, res: Response): Promise<void> => {
      ok(req, res, await service.get(getValidated(req, 'params', PaymentIdParams).paymentId));
    },
  );
  return router;
}

/** Mounted at `/api/v1/webhooks` BEFORE JSON parsing: `req.body` is the raw Buffer. */
export function createPaymentsWebhookRouter(c: AppContainer, service: PaymentsService): Router {
  const router = Router();
  router.post(
    '/payments/:provider',
    c.rateLimit('webhook'),
    async (req: Request, res: Response): Promise<void> => {
      const provider = String(req.params.provider ?? '').toLowerCase();
      ok(req, res, await service.handleWebhook(provider, req.body, req.headers, { ip: req.ip }));
    },
  );
  return router;
}

/**
 * Order routes — API_DOCUMENTATION.md §3.10 (customer, mounted at `/api/v1`, per-route storefront
 * authentication) and §4.7 (admin, mounted at `/api/v1/admin` behind admin authentication).
 *
 * | GET  /me/orders                                   | customer                       | —            |
 * | GET  /me/orders/:orderNumber                      | customer (owner, else 404)     | —            |
 * | POST /me/orders/:orderNumber/cancel               | customer (owner)               | checkout     |
 * | GET  /me/orders/:orderNumber/invoice              | customer (owner) · PDF         | —            |
 * | GET  /me/orders/:orderNumber/tracking             | customer (owner)               | —            |
 * | GET  /admin/orders                                | orders.view                    | admin-read   |
 * | GET  /admin/orders/:orderId                       | orders.view                    | admin-read   |
 * | POST /admin/orders/:orderId/status                | orders.update                  | admin-write  |
 * | POST /admin/orders/:orderId/cancel                | orders.update + orders.approve | admin-write  |
 * | POST /admin/orders/:orderId/cancellation/approve  | orders.approve                 | admin-write  |
 * | POST /admin/orders/:orderId/cancellation/reject   | orders.approve                 | admin-write  |
 * | POST /admin/orders/:orderId/notes                 | orders.update                  | admin-write  |
 * | GET  /admin/orders/:orderId/invoice               | orders.view · audit PRINT      | admin-export |
 *
 * Admin cancel requires BOTH `orders.update` and `orders.approve` — owner decision 5 (2026-11-19,
 * D-58), confirming ROLE_PERMISSION_AND_AUDIT_LOGS §5 footnote 1; API_DOCUMENTATION §4.7 updated.
 */
import { Router, type Request, type Response } from 'express';

import type { AppContainer } from '../../container.js';
import { respondsWith } from '../../core/http/successStatus.js';
import { ok } from '../../core/http/envelope.js';
import { actorFromRequest, requireAuthz } from '../../core/middleware/auth.js';
import { getValidated, validate } from '../../core/middleware/validate.js';
import {
  AddNoteBody,
  AdminCancelBody,
  AdminOrdersQuery,
  AdminStatusBody,
  ApproveCancellationBody,
  CustomerCancelBody,
  DocumentQuery,
  MyOrdersQuery,
  OrderIdParams,
  OrderNumberParams,
  RejectCancellationBody,
} from './orders.schemas.js';
import type { OrdersService, PdfDownload } from './orders.service.js';

function sendPdf(res: Response, file: PdfDownload): void {
  res
    .status(200)
    .set('Content-Type', 'application/pdf')
    .set('Content-Disposition', `attachment; filename="${file.filename}"`)
    .set('Cache-Control', 'private, no-store')
    .send(file.pdf);
}

export function createOrdersPublicRouter(c: AppContainer, service: OrdersService): Router {
  const router = Router();
  const auth = c.auth.authenticate('storefront');
  const orderNumber = (req: Request): string =>
    getValidated(req, 'params', OrderNumberParams).orderNumber;

  router.get(
    '/me/orders',
    auth,
    validate({ query: MyOrdersQuery }),
    async (req: Request, res: Response): Promise<void> => {
      const { items, meta } = await service.listMine(
        requireAuthz(req).userId,
        getValidated(req, 'query', MyOrdersQuery),
      );
      ok(req, res, items, { meta });
    },
  );
  router.get(
    '/me/orders/:orderNumber',
    auth,
    validate({ params: OrderNumberParams }),
    async (req: Request, res: Response): Promise<void> => {
      ok(req, res, await service.getMine(requireAuthz(req).userId, orderNumber(req)));
    },
  );
  router.post(
    '/me/orders/:orderNumber/cancel',
    auth,
    c.rateLimit('checkout'),
    validate({ params: OrderNumberParams, body: CustomerCancelBody }),
    async (req: Request, res: Response): Promise<void> => {
      const body = getValidated(req, 'body', CustomerCancelBody);
      ok(
        req,
        res,
        await service.cancelMine(
          actorFromRequest(req),
          requireAuthz(req).userId,
          orderNumber(req),
          body,
        ),
      );
    },
  );
  router.get(
    '/me/orders/:orderNumber/invoice',
    auth,
    validate({ params: OrderNumberParams, query: DocumentQuery }),
    async (req: Request, res: Response): Promise<void> => {
      const file = await service.invoiceMine(
        requireAuthz(req).userId,
        orderNumber(req),
        getValidated(req, 'query', DocumentQuery),
      );
      sendPdf(res, file);
    },
  );
  router.get(
    '/me/orders/:orderNumber/tracking',
    auth,
    validate({ params: OrderNumberParams }),
    async (req: Request, res: Response): Promise<void> => {
      ok(req, res, await service.trackingMine(requireAuthz(req).userId, orderNumber(req)));
    },
  );
  return router;
}

export function createOrdersAdminRouter(c: AppContainer, service: OrdersService): Router {
  const router = Router();
  const perm = (...keys: string[]) => c.auth.requirePermission(...keys);
  const write = c.rateLimit('admin-write');
  const orderId = (req: Request): string => getValidated(req, 'params', OrderIdParams).orderId;

  router.get(
    '/orders',
    perm('orders.view'),
    validate({ query: AdminOrdersQuery }),
    async (req: Request, res: Response): Promise<void> => {
      const { items, meta } = await service.listAdmin(getValidated(req, 'query', AdminOrdersQuery));
      ok(req, res, items, { meta });
    },
  );
  router.get(
    '/orders/:orderId',
    perm('orders.view'),
    validate({ params: OrderIdParams }),
    async (req: Request, res: Response): Promise<void> => {
      ok(req, res, await service.getAdmin(orderId(req)));
    },
  );
  router.post(
    '/orders/:orderId/status',
    perm('orders.update'),
    write,
    validate({ params: OrderIdParams, body: AdminStatusBody }),
    async (req: Request, res: Response): Promise<void> => {
      const body = getValidated(req, 'body', AdminStatusBody);
      ok(req, res, await service.changeStatus(actorFromRequest(req), orderId(req), body));
    },
  );
  router.post(
    '/orders/:orderId/cancel',
    perm('orders.update', 'orders.approve'),
    write,
    validate({ params: OrderIdParams, body: AdminCancelBody }),
    async (req: Request, res: Response): Promise<void> => {
      const body = getValidated(req, 'body', AdminCancelBody);
      ok(req, res, await service.cancelAdmin(actorFromRequest(req), orderId(req), body));
    },
  );
  router.post(
    '/orders/:orderId/cancellation/approve',
    perm('orders.approve'),
    write,
    validate({ params: OrderIdParams, body: ApproveCancellationBody }),
    async (req: Request, res: Response): Promise<void> => {
      const body = getValidated(req, 'body', ApproveCancellationBody);
      ok(req, res, await service.approveCancellation(actorFromRequest(req), orderId(req), body));
    },
  );
  router.post(
    '/orders/:orderId/cancellation/reject',
    perm('orders.approve'),
    write,
    validate({ params: OrderIdParams, body: RejectCancellationBody }),
    async (req: Request, res: Response): Promise<void> => {
      const { reason } = getValidated(req, 'body', RejectCancellationBody);
      ok(req, res, await service.rejectCancellation(actorFromRequest(req), orderId(req), reason));
    },
  );
  router.post(
    '/orders/:orderId/notes',
    perm('orders.update'),
    write,
    validate({ params: OrderIdParams, body: AddNoteBody }),
    respondsWith(201),
    async (req: Request, res: Response): Promise<void> => {
      const { note } = getValidated(req, 'body', AddNoteBody);
      ok(req, res, await service.addNote(actorFromRequest(req), orderId(req), note), {
        status: 201,
      });
    },
  );
  router.get(
    '/orders/:orderId/invoice',
    perm('orders.view'),
    c.rateLimit('admin-export'),
    validate({ params: OrderIdParams, query: DocumentQuery }),
    async (req: Request, res: Response): Promise<void> => {
      const file = await service.invoiceAdmin(
        actorFromRequest(req),
        orderId(req),
        getValidated(req, 'query', DocumentQuery),
      );
      sendPdf(res, file);
    },
  );
  return router;
}

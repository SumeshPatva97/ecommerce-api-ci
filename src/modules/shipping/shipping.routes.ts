/**
 * Shipping routes — API_DOCUMENTATION.md §3.8, §4.12, §5.
 *
 * | GET    /shipping/serviceability?pincode=               | public          | public-read |
 * | GET    /shipping/methods?pincode=&cartValue=           | public          | public-read |
 * | GET    /admin/shipping/methods[/:methodId]             | shipping.view   | admin-read  |
 * | POST   /admin/shipping/methods                         | shipping.create | admin-write |
 * | PATCH  /admin/shipping/methods/:methodId               | shipping.update | admin-write |
 * | DELETE /admin/shipping/methods/:methodId               | shipping.delete | admin-write |
 * | GET    /admin/shipments[/:shipmentId]                  | shipping.view   | admin-read  |
 * | POST   /admin/shipments                                | shipping.create | admin-write |
 * | PATCH  /admin/shipments/:shipmentId                    | shipping.update | admin-write |
 * | POST   /admin/shipments/:shipmentId/tracking-events    | shipping.update | admin-write |
 * | POST   /webhooks/shipping/:provider                    | signature       | webhook     |
 */
import { Router, type Request, type Response } from 'express';

import type { AppContainer } from '../../container.js';
import { respondsWith } from '../../core/http/successStatus.js';
import { ok } from '../../core/http/envelope.js';
import { actorFromRequest } from '../../core/middleware/auth.js';
import { getValidated, validate } from '../../core/middleware/validate.js';
import type { ShippingMethodsService } from './shipping.methods.js';
import {
  CreateMethodBody,
  CreateShipmentBody,
  MethodIdParams,
  MethodListQuery,
  PublicMethodsQuery,
  ServiceabilityQuery,
  ShipmentIdParams,
  ShipmentListQuery,
  TrackingEventBody,
  UpdateMethodBody,
  UpdateShipmentBody,
} from './shipping.schemas.js';
import type { ShipmentsService } from './shipping.shipments.js';

export function createShippingPublicRouter(
  c: AppContainer,
  methods: ShippingMethodsService,
): Router {
  const router = Router();
  const read = c.rateLimit('public-read');
  router.get(
    '/shipping/serviceability',
    read,
    validate({ query: ServiceabilityQuery }),
    async (req: Request, res: Response): Promise<void> => {
      const { pincode } = getValidated(req, 'query', ServiceabilityQuery);
      ok(req, res, await methods.serviceability(pincode));
    },
  );
  router.get(
    '/shipping/methods',
    read,
    validate({ query: PublicMethodsQuery }),
    async (req: Request, res: Response): Promise<void> => {
      const { items, meta } = await methods.publicMethods(
        getValidated(req, 'query', PublicMethodsQuery),
      );
      ok(req, res, items, { meta });
    },
  );
  return router;
}

export function createShippingAdminRouter(
  c: AppContainer,
  methods: ShippingMethodsService,
  shipments: ShipmentsService,
): Router {
  const perm = (key: string) => c.auth.requirePermission(key);
  const write = c.rateLimit('admin-write');
  const router = Router();

  router.get(
    '/shipping/methods',
    perm('shipping.view'),
    validate({ query: MethodListQuery }),
    async (req: Request, res: Response): Promise<void> => {
      const { items, meta } = await methods.list(getValidated(req, 'query', MethodListQuery));
      ok(req, res, items, { meta });
    },
  );
  router.post(
    '/shipping/methods',
    perm('shipping.create'),
    write,
    validate({ body: CreateMethodBody }),
    respondsWith(201),
    async (req: Request, res: Response): Promise<void> => {
      const body = getValidated(req, 'body', CreateMethodBody);
      ok(req, res, await methods.create(actorFromRequest(req), body), { status: 201 });
    },
  );
  router.get(
    '/shipping/methods/:methodId',
    perm('shipping.view'),
    validate({ params: MethodIdParams }),
    async (req: Request, res: Response): Promise<void> => {
      ok(req, res, await methods.get(getValidated(req, 'params', MethodIdParams).methodId));
    },
  );
  router.patch(
    '/shipping/methods/:methodId',
    perm('shipping.update'),
    write,
    validate({ params: MethodIdParams, body: UpdateMethodBody }),
    async (req: Request, res: Response): Promise<void> => {
      const { methodId } = getValidated(req, 'params', MethodIdParams);
      const body = getValidated(req, 'body', UpdateMethodBody);
      ok(req, res, await methods.update(actorFromRequest(req), methodId, body));
    },
  );
  router.delete(
    '/shipping/methods/:methodId',
    perm('shipping.delete'),
    write,
    validate({ params: MethodIdParams }),
    async (req: Request, res: Response): Promise<void> => {
      const { methodId } = getValidated(req, 'params', MethodIdParams);
      ok(req, res, await methods.remove(actorFromRequest(req), methodId));
    },
  );

  router.get(
    '/shipments',
    perm('shipping.view'),
    validate({ query: ShipmentListQuery }),
    async (req: Request, res: Response): Promise<void> => {
      const { items, meta } = await shipments.list(getValidated(req, 'query', ShipmentListQuery));
      ok(req, res, items, { meta });
    },
  );
  router.post(
    '/shipments',
    perm('shipping.create'),
    write,
    validate({ body: CreateShipmentBody }),
    respondsWith(201),
    async (req: Request, res: Response): Promise<void> => {
      const body = getValidated(req, 'body', CreateShipmentBody);
      ok(req, res, await shipments.create(actorFromRequest(req), body), { status: 201 });
    },
  );
  router.get(
    '/shipments/:shipmentId',
    perm('shipping.view'),
    validate({ params: ShipmentIdParams }),
    async (req: Request, res: Response): Promise<void> => {
      ok(req, res, await shipments.get(getValidated(req, 'params', ShipmentIdParams).shipmentId));
    },
  );
  router.patch(
    '/shipments/:shipmentId',
    perm('shipping.update'),
    write,
    validate({ params: ShipmentIdParams, body: UpdateShipmentBody }),
    async (req: Request, res: Response): Promise<void> => {
      const { shipmentId } = getValidated(req, 'params', ShipmentIdParams);
      const body = getValidated(req, 'body', UpdateShipmentBody);
      ok(req, res, await shipments.update(actorFromRequest(req), shipmentId, body));
    },
  );
  router.post(
    '/shipments/:shipmentId/tracking-events',
    perm('shipping.update'),
    write,
    validate({ params: ShipmentIdParams, body: TrackingEventBody }),
    respondsWith(201),
    async (req: Request, res: Response): Promise<void> => {
      const { shipmentId } = getValidated(req, 'params', ShipmentIdParams);
      const body = getValidated(req, 'body', TrackingEventBody);
      ok(req, res, await shipments.addTrackingEvent(actorFromRequest(req), shipmentId, body), {
        status: 201,
      });
    },
  );
  return router;
}

/** Mounted at `/api/v1/webhooks` BEFORE JSON parsing: `req.body` is the raw Buffer. */
export function createShippingWebhookRouter(c: AppContainer, shipments: ShipmentsService): Router {
  const router = Router();
  router.post(
    '/shipping/:provider',
    c.rateLimit('webhook'),
    async (req: Request, res: Response): Promise<void> => {
      const provider = String(req.params.provider ?? '').toLowerCase();
      const result = await shipments.handleWebhook(provider, req.body, req.headers, {
        ip: req.ip,
        requestId: req.requestId,
      });
      ok(req, res, result);
    },
  );
  return router;
}

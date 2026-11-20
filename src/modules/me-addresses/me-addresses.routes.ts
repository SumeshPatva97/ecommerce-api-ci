/**
 * Customer address book + recently viewed (mounted at `/api/v1`) — API_DOCUMENTATION.md §3.2,
 * §3.6. Per-route storefront authentication (never a router-level guard on the shared root).
 *
 * | GET    /me/addresses                       | customer | general limiter |
 * | POST   /me/addresses                       | customer | profile-write   |
 * | PATCH  /me/addresses/:addressId            | customer | profile-write   |
 * | DELETE /me/addresses/:addressId            | customer | profile-write   |
 * | POST   /me/addresses/:addressId/default    | customer | profile-write   |
 * | GET    /me/recently-viewed                 | customer | general limiter |
 * | POST   /me/recently-viewed                 | customer | customer-write  |
 * | POST   /me/recently-viewed/merge           | customer | customer-write  |
 */
import { Router, type Request, type Response } from 'express';

import type { AppContainer } from '../../container.js';
import { respondsWith } from '../../core/http/successStatus.js';
import { ok } from '../../core/http/envelope.js';
import { actorFromRequest, requireAuthz } from '../../core/middleware/auth.js';
import { getValidated, validate } from '../../core/middleware/validate.js';
import type { AddressesService } from './addresses.service.js';
import {
  AddressIdParams,
  CreateAddressBody,
  MergeViewsBody,
  RecentlyViewedQuery,
  RecordViewBody,
  UpdateAddressBody,
} from './me-addresses.schemas.js';
import type { RecentlyViewedService } from './recently-viewed.service.js';

export function createMeAddressesRouter(
  container: AppContainer,
  addresses: AddressesService,
  recent: RecentlyViewedService,
): Router {
  const router = Router();
  const auth = container.auth.authenticate('storefront');
  const profileWrite = container.rateLimit('profile-write');
  const customerWrite = container.rateLimit('customer-write');
  const addressId = (req: Request): string =>
    getValidated(req, 'params', AddressIdParams).addressId;

  router.get('/me/addresses', auth, async (req: Request, res: Response): Promise<void> => {
    ok(req, res, await addresses.list(requireAuthz(req).userId));
  });
  router.post(
    '/me/addresses',
    auth,
    profileWrite,
    validate({ body: CreateAddressBody }),
    respondsWith(201),
    async (req: Request, res: Response): Promise<void> => {
      const body = getValidated(req, 'body', CreateAddressBody);
      const userId = requireAuthz(req).userId;
      ok(req, res, await addresses.create(actorFromRequest(req), userId, body), { status: 201 });
    },
  );
  router.patch(
    '/me/addresses/:addressId',
    auth,
    profileWrite,
    validate({ params: AddressIdParams, body: UpdateAddressBody }),
    async (req: Request, res: Response): Promise<void> => {
      const body = getValidated(req, 'body', UpdateAddressBody);
      const userId = requireAuthz(req).userId;
      ok(req, res, await addresses.update(actorFromRequest(req), userId, addressId(req), body));
    },
  );
  router.delete(
    '/me/addresses/:addressId',
    auth,
    profileWrite,
    validate({ params: AddressIdParams }),
    async (req: Request, res: Response): Promise<void> => {
      const userId = requireAuthz(req).userId;
      ok(req, res, await addresses.remove(actorFromRequest(req), userId, addressId(req)));
    },
  );
  router.post(
    '/me/addresses/:addressId/default',
    auth,
    profileWrite,
    validate({ params: AddressIdParams }),
    async (req: Request, res: Response): Promise<void> => {
      const userId = requireAuthz(req).userId;
      ok(req, res, await addresses.setDefault(actorFromRequest(req), userId, addressId(req)));
    },
  );

  router.get(
    '/me/recently-viewed',
    auth,
    validate({ query: RecentlyViewedQuery }),
    async (req: Request, res: Response): Promise<void> => {
      const { limit } = getValidated(req, 'query', RecentlyViewedQuery);
      const items = await recent.list(requireAuthz(req).userId, limit);
      ok(req, res, items, { meta: { totalItems: items.length, limit } });
    },
  );
  router.post(
    '/me/recently-viewed',
    auth,
    customerWrite,
    validate({ body: RecordViewBody }),
    async (req: Request, res: Response): Promise<void> => {
      const { productId } = getValidated(req, 'body', RecordViewBody);
      ok(req, res, await recent.record(requireAuthz(req).userId, productId));
    },
  );
  router.post(
    '/me/recently-viewed/merge',
    auth,
    customerWrite,
    validate({ body: MergeViewsBody }),
    async (req: Request, res: Response): Promise<void> => {
      const body = getValidated(req, 'body', MergeViewsBody);
      const items = await recent.merge(requireAuthz(req).userId, body);
      ok(req, res, items, { meta: { totalItems: items.length } });
    },
  );
  return router;
}

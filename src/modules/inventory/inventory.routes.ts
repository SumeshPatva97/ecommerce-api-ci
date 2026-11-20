/** `/admin/inventory/*` routes — API_DOCUMENTATION.md §4.5, §7. */
import { Router } from 'express';

import type { AppContainer } from '../../container.js';
import { respondsWith } from '../../core/http/successStatus.js';
import { ok } from '../../core/http/envelope.js';
import { buildPageMeta } from '../../core/http/pagination.js';
import { actorFromRequest } from '../../core/middleware/auth.js';
import { getValidated, validate } from '../../core/middleware/validate.js';
import { hasPermission } from '../rbac/permission.service.js';
import {
  ListInventoryQuery,
  LookupQuery,
  MovementBody,
  ThresholdBody,
  TransactionsQuery,
  VariantIdParams,
} from './inventory.schemas.js';
import type { InventoryAdminService } from './inventory.service.js';

export function createInventoryAdminRouter(
  c: AppContainer,
  service: InventoryAdminService,
): Router {
  const router = Router();
  const requirePermission = (key: string) => c.auth.requirePermission(key);

  router.get(
    '/inventory',
    requirePermission('inventory.view'),
    validate({ query: ListInventoryQuery }),
    async (req, res) => {
      const query = getValidated(req, 'query', ListInventoryQuery);
      // costPrice / stockValue only with reports.view as well (API_DOCUMENTATION §4.5, proposed).
      const includeCost = req.authz !== undefined && hasPermission(req.authz, 'reports.view');
      const page = await service.list(query, { includeCost });
      ok(req, res, page.items, { meta: buildPageMeta(query.page, query.limit, page.total) });
    },
  );

  router.get(
    '/inventory/lookup',
    requirePermission('inventory.view'),
    validate({ query: LookupQuery }),
    async (req, res) => {
      ok(req, res, await service.lookup(getValidated(req, 'query', LookupQuery).sku));
    },
  );

  router.post(
    '/inventory/movements',
    c.rateLimit('admin-write'),
    requirePermission('inventory.create'),
    c.idempotency({ required: true }),
    validate({ body: MovementBody }),
    respondsWith(201),
    async (req, res) => {
      const body = getValidated(req, 'body', MovementBody);
      ok(req, res, await service.recordMovement(actorFromRequest(req), body), { status: 201 });
    },
  );

  router.get(
    '/inventory/:variantId/transactions',
    requirePermission('inventory.view'),
    validate({ params: VariantIdParams, query: TransactionsQuery }),
    async (req, res) => {
      const { variantId } = getValidated(req, 'params', VariantIdParams);
      const query = getValidated(req, 'query', TransactionsQuery);
      const page = await service.transactions(variantId, query);
      ok(req, res, page.items, { meta: buildPageMeta(query.page, query.limit, page.total) });
    },
  );

  router.patch(
    '/inventory/:variantId',
    c.rateLimit('admin-write'),
    requirePermission('inventory.update'),
    validate({ params: VariantIdParams, body: ThresholdBody }),
    async (req, res) => {
      const { variantId } = getValidated(req, 'params', VariantIdParams);
      const body = getValidated(req, 'body', ThresholdBody);
      ok(
        req,
        res,
        await service.updateThreshold(actorFromRequest(req), variantId, body.lowStockThreshold),
      );
    },
  );

  return router;
}

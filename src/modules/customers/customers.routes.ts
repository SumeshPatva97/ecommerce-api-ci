/**
 * Admin customer routes (relative to `/api/v1/admin`) — API_DOCUMENTATION.md §4.8.
 * `customers.update` is not a critical key, so status changes need no re-auth (R-15).
 */
import { Router } from 'express';

import type { AppContainer } from '../../container.js';
import { ok } from '../../core/http/envelope.js';
import { actorFromRequest } from '../../core/middleware/auth.js';
import { getValidated, validate } from '../../core/middleware/validate.js';
import {
  CustomerIdParams,
  ListCustomersQuery,
  SetCustomerStatusBody,
} from './customers.schemas.js';
import type { CustomersService } from './customers.service.js';

export function createCustomersRouter(c: AppContainer, service: CustomersService): Router {
  const r = Router();

  r.get(
    '/customers',
    c.auth.requirePermission('customers.view'),
    validate({ query: ListCustomersQuery }),
    async (req, res) => {
      const result = await service.list(getValidated(req, 'query', ListCustomersQuery));
      ok(req, res, result.data, { meta: result.meta });
    },
  );

  r.get(
    '/customers/:customerId',
    c.auth.requirePermission('customers.view'),
    validate({ params: CustomerIdParams }),
    async (req, res) => {
      const { customerId } = getValidated(req, 'params', CustomerIdParams);
      ok(req, res, await service.get(customerId));
    },
  );

  r.patch(
    '/customers/:customerId/status',
    c.auth.requirePermission('customers.update'),
    c.rateLimit('admin-write'),
    validate({ params: CustomerIdParams, body: SetCustomerStatusBody }),
    async (req, res) => {
      const { customerId } = getValidated(req, 'params', CustomerIdParams);
      const body = getValidated(req, 'body', SetCustomerStatusBody);
      ok(req, res, await service.setStatus(actorFromRequest(req), customerId, body));
    },
  );

  return r;
}

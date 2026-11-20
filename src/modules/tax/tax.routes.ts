/**
 * `/admin/tax/*` routes — API_DOCUMENTATION.md §4.10, §7. Every `tax.create|update|delete` key is
 * critical → `requireReauth()` on all tax mutations (R-15, route-table self-test).
 */
import { Router, type Request, type Response } from 'express';

import type { AppContainer } from '../../container.js';
import { respondsWith } from '../../core/http/successStatus.js';
import { ok } from '../../core/http/envelope.js';
import { buildPageMeta } from '../../core/http/pagination.js';
import { actorFromRequest } from '../../core/middleware/auth.js';
import { getValidated, validate } from '../../core/middleware/validate.js';
import {
  CreateAssignmentBody,
  CreateHsnBody,
  CreateRateBody,
  IdParams,
  ListAssignmentsQuery,
  ListHsnQuery,
  ListRatesQuery,
  PreviewBody,
  UpdateAssignmentBody,
  UpdateHsnBody,
  UpdateRateBody,
  UpdateTaxSettingsBody,
} from './tax.schemas.js';
import type { TaxService } from './tax.service.js';

const idOf = (req: Request): string => getValidated(req, 'params', IdParams).id;

export function createTaxAdminRouter(c: AppContainer, service: TaxService): Router {
  const router = Router();
  const requirePermission = (key: string) => c.auth.requirePermission(key);
  const requireReauth = () => c.auth.requireReauth();
  const write = c.rateLimit('admin-write');
  const created = (req: Request, res: Response, data: unknown): void => {
    ok(req, res, data, { status: 201 });
  };

  // Rates
  router.get(
    '/tax/rates',
    requirePermission('tax.view'),
    validate({ query: ListRatesQuery }),
    async (req, res) => {
      const query = getValidated(req, 'query', ListRatesQuery);
      const page = await service.listRates(query);
      ok(req, res, page.items, { meta: buildPageMeta(query.page, query.limit, page.total) });
    },
  );
  router.post(
    '/tax/rates',
    write,
    requirePermission('tax.create'),
    requireReauth(),
    validate({ body: CreateRateBody }),
    respondsWith(201),
    async (req, res) => {
      const body = getValidated(req, 'body', CreateRateBody);
      created(req, res, await service.createRate(actorFromRequest(req), body));
    },
  );
  router.get(
    '/tax/rates/:id',
    requirePermission('tax.view'),
    validate({ params: IdParams }),
    async (req, res) => {
      ok(req, res, await service.getRate(idOf(req)));
    },
  );
  router.patch(
    '/tax/rates/:id',
    write,
    requirePermission('tax.update'),
    requireReauth(),
    validate({ params: IdParams, body: UpdateRateBody }),
    async (req, res) => {
      const body = getValidated(req, 'body', UpdateRateBody);
      ok(req, res, await service.updateRate(actorFromRequest(req), idOf(req), body));
    },
  );
  router.delete(
    '/tax/rates/:id',
    write,
    requirePermission('tax.delete'),
    requireReauth(),
    validate({ params: IdParams }),
    async (req, res) => {
      ok(req, res, await service.deleteRate(actorFromRequest(req), idOf(req)));
    },
  );

  // HSN codes
  router.get(
    '/tax/hsn-codes',
    requirePermission('tax.view'),
    validate({ query: ListHsnQuery }),
    async (req, res) => {
      const query = getValidated(req, 'query', ListHsnQuery);
      const page = await service.listHsnCodes(query);
      ok(req, res, page.items, { meta: buildPageMeta(query.page, query.limit, page.total) });
    },
  );
  router.post(
    '/tax/hsn-codes',
    write,
    requirePermission('tax.create'),
    requireReauth(),
    validate({ body: CreateHsnBody }),
    respondsWith(201),
    async (req, res) => {
      const body = getValidated(req, 'body', CreateHsnBody);
      created(req, res, await service.createHsnCode(actorFromRequest(req), body));
    },
  );
  router.get(
    '/tax/hsn-codes/:id',
    requirePermission('tax.view'),
    validate({ params: IdParams }),
    async (req, res) => {
      ok(req, res, await service.getHsnCode(idOf(req)));
    },
  );
  router.patch(
    '/tax/hsn-codes/:id',
    write,
    requirePermission('tax.update'),
    requireReauth(),
    validate({ params: IdParams, body: UpdateHsnBody }),
    async (req, res) => {
      const body = getValidated(req, 'body', UpdateHsnBody);
      ok(req, res, await service.updateHsnCode(actorFromRequest(req), idOf(req), body));
    },
  );
  router.delete(
    '/tax/hsn-codes/:id',
    write,
    requirePermission('tax.delete'),
    requireReauth(),
    validate({ params: IdParams }),
    async (req, res) => {
      ok(req, res, await service.deleteHsnCode(actorFromRequest(req), idOf(req)));
    },
  );

  // Assignments
  router.get(
    '/tax/assignments',
    requirePermission('tax.view'),
    validate({ query: ListAssignmentsQuery }),
    async (req, res) => {
      const query = getValidated(req, 'query', ListAssignmentsQuery);
      const page = await service.listAssignments(query);
      ok(req, res, page.items, { meta: buildPageMeta(query.page, query.limit, page.total) });
    },
  );
  router.post(
    '/tax/assignments',
    write,
    requirePermission('tax.create'),
    requireReauth(),
    validate({ body: CreateAssignmentBody }),
    respondsWith(201),
    async (req, res) => {
      const body = getValidated(req, 'body', CreateAssignmentBody);
      created(req, res, await service.createAssignment(actorFromRequest(req), body));
    },
  );
  router.get(
    '/tax/assignments/:id',
    requirePermission('tax.view'),
    validate({ params: IdParams }),
    async (req, res) => {
      ok(req, res, await service.getAssignment(idOf(req)));
    },
  );
  router.patch(
    '/tax/assignments/:id',
    write,
    requirePermission('tax.update'),
    requireReauth(),
    validate({ params: IdParams, body: UpdateAssignmentBody }),
    async (req, res) => {
      const body = getValidated(req, 'body', UpdateAssignmentBody);
      ok(req, res, await service.updateAssignment(actorFromRequest(req), idOf(req), body));
    },
  );
  router.delete(
    '/tax/assignments/:id',
    write,
    requirePermission('tax.delete'),
    requireReauth(),
    validate({ params: IdParams }),
    async (req, res) => {
      ok(req, res, await service.deleteAssignment(actorFromRequest(req), idOf(req)));
    },
  );

  // Settings
  router.get('/tax/settings', requirePermission('tax.view'), async (req, res) => {
    ok(req, res, await service.getSettings());
  });
  router.patch(
    '/tax/settings',
    write,
    requirePermission('tax.update'),
    requireReauth(),
    validate({ body: UpdateTaxSettingsBody }),
    async (req, res) => {
      const body = getValidated(req, 'body', UpdateTaxSettingsBody);
      ok(req, res, await service.updateSettings(actorFromRequest(req), body));
    },
  );

  // Preview (no writes)
  router.post(
    '/tax/preview',
    requirePermission('tax.view'),
    validate({ body: PreviewBody }),
    async (req, res) => {
      ok(req, res, await service.preview(getValidated(req, 'body', PreviewBody)));
    },
  );

  return router;
}

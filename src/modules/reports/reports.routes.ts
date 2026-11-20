/**
 * Reports routes (relative to `/api/v1/admin`) — API_DOCUMENTATION.md §4.17.
 *
 *   GET  /reports/:reportKey              reports.view   (+ domain permission, in the service)
 *   POST /reports/:reportKey/export       reports.export (+ reports.view + domain permission;
 *                                          customer-data reports: customers.export + re-auth)
 *   GET  /report-exports/:exportId        reports.export (own exports; Superadmin any)
 *
 * Order: route guard → domain access (404 unknown key / 403) → re-auth (customer data only) →
 * validation → handler. File responses carry `Cache-Control: no-store`.
 */
import { Router, type RequestHandler } from 'express';

import type { AppContainer } from '../../container.js';
import { respondsWith } from '../../core/http/successStatus.js';
import { ok } from '../../core/http/envelope.js';
import { actorFromRequest, requireAuthz } from '../../core/middleware/auth.js';
import { getValidated, validate } from '../../core/middleware/validate.js';
import { ExportBody, ExportIdParams, ReportKeyParams, ReportQuery } from './reports.params.js';
import { findReport } from './reports.registry.js';
import type { ReportsService } from './reports.service.js';
import type { ReportDefinition } from './reports.types.js';

function reportKeyOf(req: Parameters<RequestHandler>[0]): string {
  const key = req.params.reportKey;
  return typeof key === 'string' ? key : '';
}

export function createReportsRouter(c: AppContainer, service: ReportsService): Router {
  const r = Router();

  const access =
    (action: 'view' | 'export'): RequestHandler =>
    async (req, _res, next) => {
      await service.assertAccess(
        requireAuthz(req),
        actorFromRequest(req),
        reportKeyOf(req),
        action,
      );
      next();
    };

  // R-15: only customer-data exports (customers-new-returning, top-customers) need re-auth.
  const reauth = c.auth.requireReauth();
  const reauthForCustomerData: RequestHandler = (req, res, next) => {
    if (findReport(reportKeyOf(req))?.customerData === true) {
      reauth(req, res, next);
      return;
    }
    next();
  };

  const definition = (req: Parameters<RequestHandler>[0]): ReportDefinition => {
    const def = findReport(reportKeyOf(req));
    if (def === undefined) throw new Error('report access middleware missing');
    return def;
  };

  r.get(
    '/reports/:reportKey',
    c.auth.requirePermission('reports.view'),
    access('view'),
    validate({ params: ReportKeyParams, query: ReportQuery }),
    async (req, res) => {
      const result = await service.view(
        requireAuthz(req),
        definition(req),
        getValidated(req, 'query', ReportQuery),
      );
      res.set('Cache-Control', 'no-store');
      ok(req, res, result.data, { meta: result.meta });
    },
  );

  r.post(
    '/reports/:reportKey/export',
    c.auth.requirePermission('reports.export'),
    c.rateLimit('admin-export'),
    access('export'),
    reauthForCustomerData,
    validate({ params: ReportKeyParams, body: ExportBody }),
    respondsWith(200, 202),
    async (req, res) => {
      const result = await service.exportReport(
        requireAuthz(req),
        actorFromRequest(req),
        definition(req),
        getValidated(req, 'body', ExportBody),
      );
      if (result.kind === 'queued') {
        res.set('Cache-Control', 'no-store');
        ok(req, res, result.data, { status: 202 });
        return;
      }
      res
        .status(200)
        .type(result.file.contentType)
        .set('Content-Disposition', `attachment; filename="${result.filename}"`)
        .set('Cache-Control', 'no-store')
        .set('X-Row-Count', String(result.rowCount))
        .set('X-Request-Id', req.requestId)
        .send(result.file.body);
    },
  );

  r.get(
    '/report-exports/:exportId',
    c.auth.requirePermission('reports.export'),
    validate({ params: ExportIdParams }),
    async (req, res) => {
      const { exportId } = getValidated(req, 'params', ExportIdParams);
      const dto = await service.getExport(requireAuthz(req), exportId);
      res.set('Cache-Control', 'no-store');
      ok(req, res, dto);
    },
  );

  return r;
}

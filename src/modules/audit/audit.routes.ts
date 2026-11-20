/**
 * Audit-log routes (relative to `/api/v1/admin`). Read and export only — there are no update or
 * delete routes for audit logs, for anyone (ROLE_PERMISSION_AND_AUDIT_LOGS.md §12).
 */
import { Router } from 'express';

import type { AppContainer } from '../../container.js';
import { ok } from '../../core/http/envelope.js';
import { actorFromRequest, requireAuthz } from '../../core/middleware/auth.js';
import { getValidated, validate } from '../../core/middleware/validate.js';
import type { AuditLogsService } from './audit-logs.service.js';
import { AuditExportBody, AuditLogsQuery } from './audit.schemas.js';

export function createAuditLogsRouter(c: AppContainer, service: AuditLogsService): Router {
  const r = Router();
  r.get(
    '/audit-logs',
    c.auth.requirePermission('audit_logs.view'),
    validate({ query: AuditLogsQuery }),
    async (req, res) => {
      const result = await service.list(
        requireAuthz(req),
        getValidated(req, 'query', AuditLogsQuery),
      );
      ok(req, res, result.data, { meta: result.meta });
    },
  );
  r.post(
    '/audit-logs/export',
    c.auth.requirePermission('audit_logs.export'),
    c.auth.requireReauth(),
    c.rateLimit('admin-export'),
    validate({ body: AuditExportBody }),
    async (req, res) => {
      const result = await service.exportCsv(
        requireAuthz(req),
        actorFromRequest(req),
        getValidated(req, 'body', AuditExportBody),
      );
      res
        .status(200)
        .type('text/csv; charset=utf-8')
        .set('Content-Disposition', `attachment; filename="${result.filename}"`)
        .set('X-Row-Count', String(result.rowCount))
        .set('X-Request-Id', req.requestId)
        .send(result.csv);
    },
  );
  return r;
}

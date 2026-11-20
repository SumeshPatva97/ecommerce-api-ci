/**
 * Reports use-cases — REPORTING_AND_ANALYTICS.md §3, §8–§10, §12; API_DOCUMENTATION.md §4.17.
 *
 * - Access: route guards require `reports.view` / `reports.export`; the report's domain
 *   permission (R-14 / OQ-68) — and for customer-data exports `customers.export` (R-15) — is
 *   enforced here, before any query runs. Denials are audited `PERMISSION_DENIED`.
 * - Export: ≤ sync limit (10 000 rows, OQ-45; PDF 2 000) → file in the response; above → a
 *   `report_exports` row in QUEUED state + 202 (worker `processReportExport`, not scheduled).
 *   Every export/print is audited (`EXPORT` / `PRINT`), routine exports need no re-auth.
 */
import type { AppContainer } from '../../container.js';
import { AppError } from '../../core/errors/AppError.js';
import { buildPageMeta, PAGE_LIMITS, type PageMeta } from '../../core/http/pagination.js';
import { PDF_MAX_ROWS, renderExport, type RenderedExport } from '../../lib/export/index.js';
import type { AuditActor } from '../audit/audit.service.js';
import type { AuthContext } from '../rbac/permission.service.js';
import {
  EXPORT_MAX_RANGE_DAYS,
  EXPORT_ROW_CAP,
  PDF_SYNC_MAX_ROWS,
  brandName,
  buildExportDocument,
  executeReport,
  exportFilename,
  filterEcho,
  missingPermissions,
  selectColumns,
  syncExportLimit,
} from './reports.engine.js';
import type { ExportBody, ReportParams } from './reports.params.js';
import { findReport } from './reports.registry.js';
import type { ReportDefinition } from './reports.types.js';

export const REPORT_VERSION_FIELD = 'reportVersion';

const FORMAT_ENUM = { csv: 'CSV', xlsx: 'XLSX', pdf: 'PDF' } as const;

export type ExportResult =
  | {
      readonly kind: 'file';
      readonly filename: string;
      readonly file: RenderedExport;
      readonly rowCount: number;
    }
  | { readonly kind: 'queued'; readonly data: Record<string, unknown> };

export interface ReportExportDto {
  exportId: string;
  reportKey: string;
  status: 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'EXPIRED';
  format: string;
  rowCount: number | null;
  fileSizeBytes: number | null;
  downloadUrl: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function createReportsService(c: AppContainer) {
  const { db, audit, clock, logger } = c;

  function displayName(viewer: AuthContext): string {
    return `${viewer.firstName} (${viewer.email})`;
  }

  /** 404 for unknown keys; 403 (audited) when a required permission is missing. */
  async function assertAccess(
    viewer: AuthContext,
    actor: AuditActor,
    reportKey: string,
    action: 'view' | 'export',
  ): Promise<ReportDefinition> {
    const def = findReport(reportKey);
    if (def === undefined) throw new AppError('NOT_FOUND', 'Report not found.');
    const missing = missingPermissions(viewer, def, action);
    if (missing.length > 0) {
      await audit.recordSafe(db, actor, {
        action: 'PERMISSION_DENIED',
        module: 'reports',
        entityType: 'report',
        outcome: 'FAILURE',
        eventKey: 'authz.denied',
        diff: false,
        metadata: { reportKey, action, required: missing, entityLabel: reportKey },
      });
      throw new AppError('PERMISSION_DENIED', undefined, {
        details: [
          {
            code: 'REPORT_ACCESS',
            message: 'This report needs additional permissions.',
            meta: { required: missing },
          },
        ],
      });
    }
    return def;
  }

  return {
    assertAccess,

    async view(
      viewer: AuthContext,
      def: ReportDefinition,
      params: ReportParams,
    ): Promise<{ data: Record<string, unknown>; meta: PageMeta | Record<string, unknown> }> {
      const now = clock();
      const limit = params.limit ?? PAGE_LIMITS.adminList;
      const { range, output } = await executeReport({
        db,
        def,
        params,
        viewer,
        now,
        paging: { skip: (params.page - 1) * limit, take: limit },
      });
      const data = {
        reportKey: def.key,
        [REPORT_VERSION_FIELD]: def.version,
        title: def.title,
        filters: filterEcho(def, params, range),
        columns: output.columns,
        rows: output.rows,
        totals: output.totals,
        notices: output.notices ?? [],
        ...(output.extra ?? {}),
        generatedAt: now.toISOString(),
        dataFreshness: { source: 'live', asOf: now.toISOString() },
      };
      const meta = output.paginated
        ? buildPageMeta(params.page, limit, output.totalItems)
        : { rowCount: output.rows.length, currency: 'INR' };
      return { data, meta };
    },

    async exportReport(
      viewer: AuthContext,
      actor: AuditActor,
      def: ReportDefinition,
      body: ExportBody,
    ): Promise<ExportResult> {
      const now = clock();
      const params: ReportParams = body.filters;
      const syncLimit =
        body.format === 'pdf'
          ? Math.min(PDF_SYNC_MAX_ROWS, await syncExportLimit(db))
          : await syncExportLimit(db);
      const maxRangeDays =
        def.dateMode === 'none' ? 0 : Math.max(def.maxRangeDays, EXPORT_MAX_RANGE_DAYS);
      const { range, output } = await executeReport({
        db,
        def,
        params,
        viewer,
        now,
        paging: { skip: 0, take: syncLimit },
        maxRangeDays,
      });
      // Validate requested columns up-front (also for queued exports).
      selectColumns(output.columns, body.columns);
      const echo = filterEcho(def, params, range);
      const containsPii = def.containsPii(viewer);
      const rowCount = output.totalItems;
      const cap = body.format === 'pdf' ? PDF_MAX_ROWS : EXPORT_ROW_CAP;
      if (rowCount > cap) {
        throw new AppError('VALIDATION_ERROR', 'Too many rows for this export.', {
          details: [
            {
              code: 'EXPORT_TOO_LARGE',
              message:
                body.format === 'pdf'
                  ? `PDF exports are limited to ${String(PDF_MAX_ROWS)} rows; use CSV or XLSX.`
                  : `Narrow the filters to at most ${String(EXPORT_ROW_CAP)} rows.`,
              meta: { rowCount, max: cap },
            },
          ],
        });
      }
      const auditBase = {
        module: 'reports',
        entityType: 'report',
        diff: false as const,
      };

      if (rowCount > syncLimit) {
        const row = await db.reportExport.create({
          data: {
            reportKey: def.key,
            format: FORMAT_ENUM[body.format],
            filters: {
              filters: JSON.parse(JSON.stringify(params)) as Record<string, string>,
              ...(body.columns === undefined ? {} : { columns: body.columns }),
              includeHeader: body.includeHeader,
              purpose: body.purpose,
            },
            status: 'QUEUED',
            requestedById: viewer.userId,
          },
          select: { id: true },
        });
        await audit.recordSafe(db, actor, {
          ...auditBase,
          action: body.purpose === 'print' ? 'PRINT' : 'EXPORT',
          entityId: row.id,
          after: {
            reportKey: def.key,
            format: body.format,
            filters: echo,
            rowCount,
            exportId: row.id,
            mode: 'async',
          },
          eventKey: 'reports.export_requested',
          metadata: { containsPii, rowCount, entityLabel: def.key },
        });
        logger.info({ exportId: row.id, reportKey: def.key, rowCount }, 'report export queued');
        return {
          kind: 'queued',
          data: {
            exportId: row.id,
            status: 'QUEUED',
            reportKey: def.key,
            format: body.format,
            rowCount,
            pollUrl: `/api/v1/admin/report-exports/${row.id}`,
          },
        };
      }

      const doc = buildExportDocument(def, output, range, echo, {
        brandName: await brandName(db),
        generatedAt: now,
        generatedBy: displayName(viewer),
        ...(body.columns === undefined ? {} : { columns: body.columns }),
      });
      const file = await renderExport(body.format, doc, { includeHeader: body.includeHeader });
      await audit.recordSafe(db, actor, {
        ...auditBase,
        action: body.purpose === 'print' ? 'PRINT' : 'EXPORT',
        after: {
          reportKey: def.key,
          format: body.format,
          filters: echo,
          columns: body.columns ?? null,
          rowCount,
          mode: 'sync',
        },
        eventKey: 'reports.export_requested',
        metadata: { containsPii, rowCount, entityLabel: def.key },
      });
      return {
        kind: 'file',
        filename: exportFilename(def.key, range, now, file.extension),
        file,
        rowCount,
      };
    },

    /** Own exports only (Superadmin: any); others → 404 without existence leak (§9). */
    async getExport(viewer: AuthContext, exportId: string): Promise<ReportExportDto> {
      const row = await db.reportExport.findUnique({ where: { id: exportId } });
      if (row === null || (row.requestedById !== viewer.userId && !viewer.isSuperadmin)) {
        throw new AppError('NOT_FOUND', 'Export not found.');
      }
      const def = findReport(row.reportKey);
      // Permission re-check (R11): access may have been revoked since the request.
      if (def !== undefined) {
        const missing = missingPermissions(viewer, def, 'export');
        if (missing.length > 0) {
          throw new AppError('PERMISSION_DENIED', undefined, {
            details: [
              {
                code: 'REPORT_ACCESS',
                message: 'This report needs additional permissions.',
                meta: { required: missing },
              },
            ],
          });
        }
      }
      const now = clock();
      const expired =
        row.status === 'EXPIRED' ||
        (row.status === 'READY' &&
          row.expiresAt !== null &&
          row.expiresAt.getTime() <= now.getTime());
      const status: ReportExportDto['status'] = expired
        ? 'EXPIRED'
        : row.status === 'READY'
          ? 'COMPLETED'
          : row.status;
      return {
        exportId: row.id,
        reportKey: row.reportKey,
        status,
        format: row.format.toLowerCase(),
        rowCount: row.rowCount,
        fileSizeBytes: null,
        // Private object storage + signed download route are not provisioned yet (see job).
        downloadUrl: null,
        expiresAt: row.expiresAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    },
  };
}

export type ReportsService = ReturnType<typeof createReportsService>;

/**
 * Async report export worker — REPORTING_AND_ANALYTICS.md §9 (OQ-45). NOT scheduled: the durable
 * queue (BullMQ `report-exports`, concurrency 2, timeout 10 min, 2 retries) is deferred with
 * Redis (OQ-35 / D-38, see src/jobs/README.md). A runner calls `processReportExport(exportId)`.
 *
 * Steps: claim QUEUED → PROCESSING atomically (idempotent: any other state is skipped) → re-check
 * the requester's permissions (R11; revoked → FAILED + audited PERMISSION_DENIED) → run the
 * report without the sync cap (≤ 1 000 000 rows) → render CSV/XLSX/PDF → store in PRIVATE object
 * storage → READY with storage key, SHA-256, row count and a 7-day expiry.
 *
 * STORAGE GAP: §9 requires private object storage with short-lived signed URLs; no such adapter is
 * provisioned (the media adapter is public Cloudinary and must never hold exports). Without a
 * `storage` dependency the export is marked FAILED (reason logged) — the sync path (≤ 10 000 rows)
 * remains fully functional. `report_exports` has no error-message column, so failure reasons go
 * to the structured log and the audit trail.
 */
import { createHash } from 'node:crypto';

import type { DbClient } from '../core/db/transaction.js';
import type { Logger } from '../core/logger/logger.js';
import { renderExport, type ExportFormatKey } from '../lib/export/index.js';
import { addDays } from '../lib/time.js';
import {
  SYSTEM_ACTOR,
  type AuditActor,
  type AuditService,
} from '../modules/audit/audit.service.js';
import type { PermissionService } from '../modules/rbac/permission.service.js';
import {
  EXPORT_MAX_RANGE_DAYS,
  EXPORT_ROW_CAP,
  REPORT_FILE_RETENTION_DAYS,
  brandName,
  buildExportDocument,
  executeReport,
  filterEcho,
  missingPermissions,
} from '../modules/reports/reports.engine.js';
import { ExportBody } from '../modules/reports/reports.params.js';
import { findReport } from '../modules/reports/reports.registry.js';

/** Private (non-public) object storage for generated export files. */
export interface ReportExportStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
}

export interface ReportExportJobDeps {
  readonly db: DbClient;
  readonly logger: Logger;
  readonly audit: AuditService;
  readonly permissions: Pick<PermissionService, 'effectivePermissions'>;
  readonly clock?: () => Date;
  readonly storage?: ReportExportStorage;
}

export type ReportExportOutcome =
  | { readonly status: 'SKIPPED' }
  | { readonly status: 'READY'; readonly rowCount: number; readonly storageKey: string }
  | { readonly status: 'FAILED'; readonly reason: string };

const FORMAT_KEYS = { CSV: 'csv', XLSX: 'xlsx', PDF: 'pdf' } as const;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function processReportExport(
  exportId: string,
  deps: ReportExportJobDeps,
): Promise<ReportExportOutcome> {
  const { db, logger, audit } = deps;
  const clock = deps.clock ?? (() => new Date());

  const claimed = await db.reportExport.updateMany({
    where: { id: exportId, status: 'QUEUED' },
    data: { status: 'PROCESSING' },
  });
  if (claimed.count === 0) return { status: 'SKIPPED' };

  const fail = async (
    reason: string,
    actor: AuditActor = SYSTEM_ACTOR,
  ): Promise<ReportExportOutcome> => {
    await db.reportExport.update({ where: { id: exportId }, data: { status: 'FAILED' } });
    logger.error({ exportId, reason }, 'report export failed');
    await audit.recordSafe(db, actor, {
      action: 'EXPORT',
      module: 'reports',
      entityType: 'report',
      entityId: exportId,
      outcome: 'FAILURE',
      diff: false,
      eventKey: 'reports.export_failed',
      metadata: { exportId, reason },
    });
    return { status: 'FAILED', reason };
  };

  try {
    const row = await db.reportExport.findUnique({ where: { id: exportId } });
    if (row === null) return { status: 'FAILED', reason: 'NOT_FOUND' };
    const def = findReport(row.reportKey);
    if (def === undefined) return await fail('UNKNOWN_REPORT');

    const user = await db.user.findUnique({
      where: { id: row.requestedById },
      select: { id: true, email: true, firstName: true, isSuperadmin: true, status: true },
    });
    if (user?.status !== 'ACTIVE') return await fail('REQUESTER_INACTIVE');
    const actor: AuditActor = { type: 'STAFF', userId: user.id, loginType: 'STAFF' };
    const permissions = await deps.permissions.effectivePermissions(db, user.id, user.isSuperadmin);
    const viewer = { permissions, isSuperadmin: user.isSuperadmin };
    const missing = missingPermissions(viewer, def, 'export');
    if (missing.length > 0) {
      await audit.recordSafe(db, actor, {
        action: 'PERMISSION_DENIED',
        module: 'reports',
        entityType: 'report',
        entityId: exportId,
        outcome: 'FAILURE',
        diff: false,
        eventKey: 'authz.denied',
        metadata: { reportKey: def.key, required: missing, exportId },
      });
      return await fail('PERMISSION_REVOKED', actor);
    }

    const stored = asRecord(row.filters);
    const parsed = ExportBody.safeParse({
      format: FORMAT_KEYS[row.format],
      filters: asRecord(stored.filters),
      ...(Array.isArray(stored.columns) ? { columns: stored.columns } : {}),
      ...(typeof stored.includeHeader === 'boolean' ? { includeHeader: stored.includeHeader } : {}),
      ...(stored.purpose === 'print' ? { purpose: 'print' } : {}),
    });
    if (!parsed.success) return await fail('INVALID_FILTERS');
    const body = parsed.data;

    if (deps.storage === undefined) return await fail('STORAGE_UNAVAILABLE');

    const now = clock();
    const { range, output } = await executeReport({
      db,
      def,
      params: body.filters,
      viewer,
      now,
      paging: { skip: 0, take: EXPORT_ROW_CAP },
      maxRangeDays: def.dateMode === 'none' ? 0 : Math.max(def.maxRangeDays, EXPORT_MAX_RANGE_DAYS),
    });
    const echo = filterEcho(def, body.filters, range);
    const doc = buildExportDocument(def, output, range, echo, {
      brandName: await brandName(db),
      generatedAt: now,
      generatedBy: `${user.firstName} (${user.email})`,
      exportId,
      ...(body.columns === undefined ? {} : { columns: body.columns }),
    });
    const format: ExportFormatKey = body.format;
    const file = await renderExport(format, doc, { includeHeader: body.includeHeader });
    const storageKey = `report-exports/${exportId}.${file.extension}`;
    await deps.storage.put(storageKey, file.body, file.contentType);
    const rowCount = output.rows.length;
    await db.reportExport.update({
      where: { id: exportId },
      data: {
        status: 'READY',
        fileStorageKey: storageKey,
        fileHash: createHash('sha256').update(file.body).digest('hex'),
        rowCount,
        expiresAt: addDays(now, REPORT_FILE_RETENTION_DAYS),
      },
    });
    await audit.recordSafe(db, actor, {
      action: 'EXPORT',
      module: 'reports',
      entityType: 'report',
      entityId: exportId,
      diff: false,
      after: { reportKey: def.key, format, filters: echo, rowCount, exportId, mode: 'async' },
      eventKey: 'reports.export_generated',
      metadata: { containsPii: def.containsPii(viewer), rowCount, entityLabel: def.key },
    });
    return { status: 'READY', rowCount, storageKey };
  } catch (error) {
    logger.error({ err: error, exportId }, 'report export crashed');
    return fail('ERROR');
  }
}

/**
 * Audit-log viewer & export use-cases — ROLE_PERMISSION_AND_AUDIT_LOGS.md §15,
 * API_DOCUMENTATION.md §4.16. Read-only: no route updates or deletes audit rows (§12).
 *
 * Export: synchronous CSV up to `SYNC_EXPORT_MAX_ROWS` (10 000, REPORTING §9 / settings
 * `reports.sync_export_max_rows`); larger result sets are refused with 422 `EXPORT_TOO_LARGE`
 * (async exports belong to the report-exports pipeline). The export itself is audited (`EXPORT`).
 */
import type { AppContainer } from '../../container.js';
import { AppError } from '../../core/errors/AppError.js';
import { buildPageMeta, toSkipTake, type PageMeta } from '../../core/http/pagination.js';
import { normalizeEmail } from '../../lib/normalize.js';
import type { AuditActor } from './audit.service.js';
import { hasPermission, type AuthContext } from '../rbac/permission.service.js';
import { buildAuditCsv, toAuditLogDto, type AuditLogDto } from './audit.mapper.js';
import {
  actorInfo,
  auditSelect,
  buildAuditWhere,
  resolveRange,
  type AuditRow,
} from './audit.repository.js';
import type { AuditExportBody, AuditFilters, AuditLogsQuery } from './audit.schemas.js';

export const SYNC_EXPORT_MAX_ROWS = 10_000;

export function createAuditLogsService(c: AppContainer) {
  const { db, audit, clock } = c;

  async function whereFor(filters: AuditFilters) {
    const range = resolveRange(filters.from, filters.to, clock());
    let actorIds: string[] | undefined;
    if (filters.actorEmail !== undefined) {
      const user = await db.user.findUnique({
        where: { emailNormalized: normalizeEmail(filters.actorEmail) },
        select: { id: true },
      });
      actorIds = user === null ? [] : [user.id];
    }
    return { where: buildAuditWhere(filters, range, actorIds), range };
  }

  async function toDtos(rows: readonly AuditRow[], viewer: AuthContext): Promise<AuditLogDto[]> {
    const actors = await actorInfo(
      db,
      rows.flatMap((r) => (r.actorUserId === null ? [] : [r.actorUserId])),
    );
    const canSeeCustomers = hasPermission(viewer, 'customers.view');
    return rows.map((r) => toAuditLogDto(r, actors, canSeeCustomers));
  }

  return {
    async list(
      viewer: AuthContext,
      query: AuditLogsQuery,
    ): Promise<{ data: AuditLogDto[]; meta: PageMeta & { from: string; to: string } }> {
      const { where, range } = await whereFor(query);
      const [total, rows] = await Promise.all([
        db.auditLog.count({ where }),
        db.auditLog.findMany({
          where,
          select: auditSelect,
          orderBy: [
            { createdAt: query.sort === 'createdAt' ? 'asc' : 'desc' },
            { id: query.sort === 'createdAt' ? 'asc' : 'desc' },
          ],
          ...toSkipTake(query.page, query.limit),
        }),
      ]);
      return {
        data: await toDtos(rows, viewer),
        meta: {
          ...buildPageMeta(query.page, query.limit, total),
          from: range.start.toISOString(),
          to: new Date(range.end.getTime() - 1).toISOString(),
        },
      };
    },

    async exportCsv(
      viewer: AuthContext,
      actor: AuditActor,
      body: AuditExportBody,
    ): Promise<{ filename: string; csv: string; rowCount: number }> {
      const { format, ...filters } = body;
      const { where, range } = await whereFor(filters);
      const total = await db.auditLog.count({ where });
      const filterEcho = {
        ...filters,
        from: range.start.toISOString(),
        to: new Date(range.end.getTime() - 1).toISOString(),
      };
      if (total > SYNC_EXPORT_MAX_ROWS) {
        throw new AppError('VALIDATION_ERROR', 'Too many rows for a direct export.', {
          details: [
            {
              code: 'EXPORT_TOO_LARGE',
              message: `Narrow the filters to at most ${SYNC_EXPORT_MAX_ROWS} rows.`,
              meta: { rowCount: total, max: SYNC_EXPORT_MAX_ROWS },
            },
          ],
        });
      }
      const rows = await db.auditLog.findMany({
        where,
        select: auditSelect,
        orderBy: [
          { createdAt: body.sort === 'createdAt' ? 'asc' : 'desc' },
          { id: body.sort === 'createdAt' ? 'asc' : 'desc' },
        ],
        take: SYNC_EXPORT_MAX_ROWS,
      });
      const now = clock();
      const csv = buildAuditCsv(await toDtos(rows, viewer), {
        generatedAt: now,
        generatedBy: `${viewer.email} (${viewer.userId})`,
        filters: filterEcho,
      });
      await audit.recordSafe(db, actor, {
        action: 'EXPORT',
        module: 'audit_logs',
        entityType: 'AuditLog',
        diff: false,
        after: { format, filters: filterEcho, rowCount: rows.length },
        eventKey: 'audit_logs.exported',
        metadata: { containsPii: true, rowCount: rows.length },
      });
      const stamp = now.toISOString().replace(/[-:]/g, '').slice(0, 15);
      return { filename: `audit-logs-${stamp}.csv`, csv, rowCount: rows.length };
    },
  };
}

export type AuditLogsService = ReturnType<typeof createAuditLogsService>;

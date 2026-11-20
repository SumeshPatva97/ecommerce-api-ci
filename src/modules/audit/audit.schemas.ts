/**
 * Audit-log viewer & export filters — API_DOCUMENTATION.md §4.16, ROLE_PERMISSION_AND_AUDIT_LOGS.md
 * §15. Both documents' parameter names are accepted (`actorId` / `actorUserId`, `ip` / `ipAddress`).
 */
import { z } from 'zod';

import { PAGE_LIMITS, paginationQuery } from '../../core/http/pagination.js';
import { AuditAction, AuditOutcome } from '../../generated/prisma/enums.js';

const ACTIONS = Object.values(AuditAction) as [AuditAction, ...AuditAction[]];
const OUTCOMES = Object.values(AuditOutcome) as [AuditOutcome, ...AuditOutcome[]];

/** `a,b` or `['a','b']` → trimmed non-empty strings. */
const commaList = z
  .union([z.string(), z.array(z.string())])
  .transform((value) =>
    (Array.isArray(value) ? value : value.split(',')).map((v) => v.trim()).filter((v) => v !== ''),
  );

/** `YYYY-MM-DD` (IST business day) or an ISO-8601 instant. */
const dateOrInstant = z.union([
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  z.iso.datetime({ offset: true }),
]);

const filterShape = {
  from: dateOrInstant.optional(),
  to: dateOrInstant.optional(),
  actorId: z.uuid().optional(),
  actorUserId: z.uuid().optional(),
  actorEmail: z.email().max(254).optional(),
  action: commaList.pipe(z.array(z.enum(ACTIONS)).min(1).max(30)).optional(),
  module: commaList
    .pipe(
      z
        .array(z.string().regex(/^[a-z_]{1,50}$/))
        .min(1)
        .max(30),
    )
    .optional(),
  eventKey: z
    .string()
    .regex(/^[a-z_]+\.[a-z_.]+$/)
    .max(80)
    .optional(),
  entityType: z.string().trim().min(1).max(50).optional(),
  entityId: z.string().trim().min(1).max(64).optional(),
  outcome: z.enum(OUTCOMES).optional(),
  requestId: z.string().trim().min(1).max(100).optional(),
  ip: z.string().trim().min(1).max(46).optional(),
  ipAddress: z.string().trim().min(1).max(46).optional(),
  client: z.enum(['storefront', 'admin', 'system', 'webhook']).optional(),
};

export const AuditLogsQuery = paginationQuery(PAGE_LIMITS.adminList).extend({
  ...filterShape,
  sort: z.enum(['-createdAt', 'createdAt']).default('-createdAt'),
});
export type AuditLogsQuery = z.output<typeof AuditLogsQuery>;

export const AuditExportBody = z.strictObject({
  ...filterShape,
  sort: z.enum(['-createdAt', 'createdAt']).default('-createdAt'),
  // XLSX and async (> 10k rows) exports need the report-exports pipeline — not in this module.
  format: z.literal('csv').default('csv'),
});
export type AuditExportBody = z.output<typeof AuditExportBody>;

export type AuditFilters = Omit<AuditLogsQuery, 'page' | 'limit'>;

/**
 * Audit-log queries (read-only — there is no update/delete path for audit rows, §12).
 *
 * `event_key`, `changed_fields` and `metadata` live inside `new_values._event` (see
 * audit.service.ts); the event-key filter therefore uses a JSON path predicate.
 */
import { AppError } from '../../core/errors/AppError.js';
import type { Queryable } from '../../core/db/transaction.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { ActorType } from '../../generated/prisma/enums.js';
import { addDays, istDayRange } from '../../lib/time.js';
import type { AuditFilters } from './audit.schemas.js';

export const DEFAULT_RANGE_DAYS = 7;
export const MAX_RANGE_DAYS = 366;

const CLIENT_ACTOR: Readonly<Record<NonNullable<AuditFilters['client']>, ActorType>> = {
  admin: 'STAFF',
  storefront: 'CUSTOMER',
  system: 'SYSTEM',
  webhook: 'WEBHOOK',
};

function bound(value: string, edge: 'start' | 'end'): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const range = istDayRange(value);
    return edge === 'start' ? range.start : range.end;
  }
  const instant = new Date(value);
  // Instants are inclusive on both ends; the query uses `lt end`.
  return edge === 'start' ? instant : new Date(instant.getTime() + 1);
}

/** Resolves `from`/`to` to `[start, end)` (UTC). Default: last 7 days; max 366 days. */
export function resolveRange(
  from: string | undefined,
  to: string | undefined,
  now: Date,
): { start: Date; end: Date } {
  const end = to === undefined ? new Date(now.getTime() + 1) : bound(to, 'end');
  const start = from === undefined ? addDays(end, -DEFAULT_RANGE_DAYS) : bound(from, 'start');
  if (start.getTime() >= end.getTime()) {
    throw new AppError('VALIDATION_ERROR', undefined, {
      details: [{ field: 'from', message: '`from` must be before `to`.' }],
    });
  }
  if (end.getTime() - start.getTime() > MAX_RANGE_DAYS * 24 * 60 * 60 * 1000 + 1) {
    throw new AppError('VALIDATION_ERROR', undefined, {
      details: [{ field: 'to', message: `The range may span at most ${MAX_RANGE_DAYS} days.` }],
    });
  }
  return { start, end };
}

/** Builds the Prisma filter. `actorEmail` must already be resolved to `actorUserIds`. */
export function buildAuditWhere(
  filters: AuditFilters,
  range: { start: Date; end: Date },
  actorUserIds?: readonly string[],
): Prisma.AuditLogWhereInput {
  const and: Prisma.AuditLogWhereInput[] = [{ createdAt: { gte: range.start, lt: range.end } }];
  const actorId = filters.actorId ?? filters.actorUserId;
  if (actorId !== undefined) and.push({ actorUserId: actorId });
  if (actorUserIds !== undefined) and.push({ actorUserId: { in: [...actorUserIds] } });
  if (filters.action !== undefined) and.push({ action: { in: filters.action } });
  if (filters.module !== undefined) and.push({ module: { in: filters.module } });
  if (filters.entityType !== undefined) and.push({ entityType: filters.entityType });
  if (filters.entityId !== undefined) and.push({ entityId: filters.entityId });
  if (filters.outcome !== undefined) and.push({ outcome: filters.outcome });
  if (filters.requestId !== undefined) and.push({ requestId: filters.requestId });
  const ip = filters.ip ?? filters.ipAddress;
  if (ip !== undefined) {
    // `203.0.113.*` → prefix match; otherwise exact.
    and.push(ip.endsWith('*') ? { ipAddress: { startsWith: ip.slice(0, -1) } } : { ipAddress: ip });
  }
  if (filters.client !== undefined) and.push({ actorType: CLIENT_ACTOR[filters.client] });
  if (filters.eventKey !== undefined) {
    and.push({ newValues: { path: '$._event.eventKey', equals: filters.eventKey } });
  }
  return { AND: and };
}

export const auditSelect = {
  id: true,
  createdAt: true,
  actorType: true,
  actorUserId: true,
  actorRole: true,
  loginType: true,
  action: true,
  module: true,
  entityType: true,
  entityId: true,
  outcome: true,
  oldValues: true,
  newValues: true,
  ipAddress: true,
  requestId: true,
  userAgent: true,
  reason: true,
} as const satisfies Prisma.AuditLogSelect;

export type AuditRow = Prisma.AuditLogGetPayload<{ select: typeof auditSelect }>;

export interface ActorInfo {
  name: string;
  accountType: string;
  email: string;
}

export async function actorInfo(
  db: Queryable,
  ids: readonly string[],
): Promise<Map<string, ActorInfo>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const users = await db.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, firstName: true, lastName: true, accountType: true, email: true },
  });
  return new Map(
    users.map((u) => [
      u.id,
      {
        name: u.lastName === null ? u.firstName : `${u.firstName} ${u.lastName}`,
        accountType: u.accountType,
        email: u.email,
      },
    ]),
  );
}

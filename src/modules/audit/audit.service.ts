/**
 * Audit service — BACKEND_STRUCTURE.md §12, ROLE_PERMISSION_AND_AUDIT_LOGS.md §9–§12.
 *
 * - `record(db, actor, entry)` writes one `audit_logs` row. Pass the transaction client so the row
 *   exists iff the change committed.
 * - `recordSafe(...)` is for non-transactional events (LOGIN_FAILED, PERMISSION_DENIED, EXPORT):
 *   a DB failure is written to the structured log with `audit_fallback=true` and never fails the
 *   request (§10.1).
 *
 * Schema note: the approved `audit_logs` table (Phase 3) has no `event_key`/`metadata`/`changed_fields`
 * columns. They are carried inside `new_values` under `_event` so no schema change is needed; the
 * viewer exposes them as `eventKey`/`metadata`.
 */
import { randomUUID } from 'node:crypto';

import type { Prisma } from '../../generated/prisma/client.js';
import type { AuditAction, AuditOutcome, ActorType } from '../../generated/prisma/enums.js';
import type { Queryable } from '../../core/db/transaction.js';
import type { Logger } from '../../core/logger/logger.js';
import { computeDiff, redact } from '../../lib/redact.js';

export interface AuditActor {
  readonly type: ActorType;
  readonly userId?: string | undefined;
  /** Role code snapshot, e.g. `MANAGER` (first role) or `SUPERADMIN`. */
  readonly role?: string | undefined;
  readonly loginType?: 'STAFF' | 'CUSTOMER' | 'SYSTEM' | 'WEBHOOK' | undefined;
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
  readonly requestId?: string | undefined;
}

export const SYSTEM_ACTOR: AuditActor = Object.freeze({ type: 'SYSTEM', loginType: 'SYSTEM' });

export interface AuditEntry {
  readonly action: AuditAction;
  readonly module: string;
  readonly entityType: string;
  /** UUID only (`entity_id` is CHAR(36)); business keys go in `metadata.entityLabel`. */
  readonly entityId?: string | null | undefined;
  readonly outcome?: AuditOutcome;
  readonly before?: Record<string, unknown> | null | undefined;
  readonly after?: Record<string, unknown> | null | undefined;
  /** When true (default), before/after are reduced to changed fields. */
  readonly diff?: boolean;
  readonly reason?: string | undefined;
  readonly eventKey?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function truncate(value: string | undefined, max: number): string | null {
  if (value === undefined) return null;
  return value.length > max ? value.slice(0, max) : value;
}

export interface AuditService {
  record(db: Queryable, actor: AuditActor, entry: AuditEntry): Promise<void>;
  recordSafe(db: Queryable, actor: AuditActor, entry: AuditEntry): Promise<void>;
}

export function buildAuditRow(
  actor: AuditActor,
  entry: AuditEntry,
  now: Date,
): Prisma.AuditLogUncheckedCreateInput {
  const useDiff = entry.diff ?? true;
  const diff = useDiff
    ? computeDiff(entry.before ?? null, entry.after ?? null)
    : {
        before:
          entry.before === undefined || entry.before === null
            ? null
            : (redact(entry.before) as Record<string, unknown>),
        after:
          entry.after === undefined || entry.after === null
            ? null
            : (redact(entry.after) as Record<string, unknown>),
        changedFields: [] as string[],
      };
  const eventBlock: Record<string, unknown> = {};
  if (entry.eventKey !== undefined) eventBlock.eventKey = entry.eventKey;
  if (diff.changedFields.length > 0) eventBlock.changedFields = diff.changedFields;
  if (entry.metadata !== undefined) eventBlock.metadata = redact(entry.metadata);
  const newValues =
    diff.after === null && Object.keys(eventBlock).length === 0
      ? undefined
      : {
          ...(diff.after ?? {}),
          ...(Object.keys(eventBlock).length > 0 ? { _event: eventBlock } : {}),
        };

  const entityId =
    entry.entityId !== undefined && entry.entityId !== null && UUID.test(entry.entityId)
      ? entry.entityId
      : null;

  return {
    id: randomUUID(),
    createdAt: now,
    actorType: actor.type,
    actorUserId: actor.userId ?? null,
    actorRole: truncate(actor.role, 50),
    loginType: truncate(actor.loginType, 30),
    action: entry.action,
    module: entry.module.slice(0, 50),
    entityType: entry.entityType.slice(0, 50),
    entityId,
    outcome: entry.outcome ?? 'SUCCESS',
    ...(diff.before === null ? {} : { oldValues: diff.before as Prisma.InputJsonValue }),
    ...(newValues === undefined ? {} : { newValues: newValues as Prisma.InputJsonValue }),
    ipAddress: truncate(actor.ip, 45),
    requestId: truncate(actor.requestId, 100),
    userAgent: truncate(actor.userAgent, 255),
    reason: truncate(entry.reason, 500),
  };
}

export function createAuditService(
  logger: Logger,
  clock: () => Date = () => new Date(),
): AuditService {
  return {
    async record(db, actor, entry) {
      await db.auditLog.create({ data: buildAuditRow(actor, entry, clock()) });
    },
    async recordSafe(db, actor, entry) {
      const row = buildAuditRow(actor, entry, clock());
      try {
        await db.auditLog.create({ data: row });
      } catch (error) {
        logger.error(
          {
            err: error,
            audit_fallback: true,
            audit: { ...row, oldValues: undefined, newValues: undefined },
          },
          'audit write failed; recorded in log stream',
        );
      }
    },
  };
}

/**
 * Audit row → viewer DTO (API_DOCUMENTATION.md §4.16 example) and CSV export rendering.
 * `eventKey`, `changedFields` and `metadata` are unpacked from `new_values._event`.
 */
import type { AuditRow, ActorInfo } from './audit.repository.js';

export const DISPLAY_TIMEZONE = 'Asia/Kolkata';
/** Lets spreadsheet tools detect UTF-8. */
const UTF8_BOM = String.fromCharCode(0xfeff);

type Json = unknown;

function asRecord(value: Json): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export interface UnpackedValues {
  newValues: Record<string, unknown> | null;
  eventKey: string | null;
  changedFields: string[];
  metadata: Record<string, unknown> | null;
}

export function unpackNewValues(raw: Json): UnpackedValues {
  const record = asRecord(raw);
  if (record === null)
    return { newValues: null, eventKey: null, changedFields: [], metadata: null };
  const { _event: event, ...rest } = record;
  const block = asRecord(event);
  const eventKey = typeof block?.eventKey === 'string' ? block.eventKey : null;
  const changedFields = Array.isArray(block?.changedFields)
    ? block.changedFields.filter((f): f is string => typeof f === 'string')
    : [];
  return {
    newValues: Object.keys(rest).length > 0 ? rest : null,
    eventKey,
    changedFields,
    metadata: asRecord(block?.metadata),
  };
}

export interface AuditLogDto {
  id: string;
  createdAt: string;
  timezone: string;
  actor: {
    type: string;
    id: string | null;
    name: string | null;
    accountType: string | null;
    roles: string[];
    isSuperadmin: boolean;
  };
  action: string;
  eventKey: string | null;
  module: string;
  entityType: string;
  entityId: string | null;
  entityLabel: string | null;
  outcome: string;
  changes: { old: Record<string, unknown> | null; new: Record<string, unknown> | null } | null;
  changedFields: string[];
  metadata: Record<string, unknown> | null;
  reason: string | null;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

/**
 * @param canSeeCustomers  viewer holds `customers.view`; otherwise customer actor names are hidden
 *                          (ROLE_PERMISSION §11 — customer identity masked for such viewers).
 */
export function toAuditLogDto(
  row: AuditRow,
  actors: ReadonlyMap<string, ActorInfo>,
  canSeeCustomers: boolean,
): AuditLogDto {
  const unpacked = unpackNewValues(row.newValues);
  const old = asRecord(row.oldValues);
  const info = row.actorUserId === null ? undefined : actors.get(row.actorUserId);
  const hideName = row.actorType === 'CUSTOMER' && !canSeeCustomers;
  const label = unpacked.metadata?.entityLabel;
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    timezone: DISPLAY_TIMEZONE,
    actor: {
      type: row.actorType,
      id: row.actorUserId,
      name: hideName ? null : (info?.name ?? null),
      accountType: info?.accountType ?? row.loginType,
      roles: row.actorRole === null ? [] : [row.actorRole],
      isSuperadmin: row.actorRole === 'SUPERADMIN',
    },
    action: row.action,
    eventKey: unpacked.eventKey,
    module: row.module,
    entityType: row.entityType,
    entityId: row.entityId,
    entityLabel: typeof label === 'string' ? label : null,
    outcome: row.outcome,
    changes: old === null && unpacked.newValues === null ? null : { old, new: unpacked.newValues },
    changedFields: unpacked.changedFields,
    metadata: unpacked.metadata,
    reason: row.reason,
    ip: row.ipAddress,
    userAgent: row.userAgent,
    requestId: row.requestId,
  };
}

// CSV ------------------------------------------------------------------------------------------

/** CSV-injection guard (OWASP): cells starting with = + - @ (or tab/CR) are prefixed with `'`. */
export function csvCell(value: unknown): string {
  let text =
    value === null || value === undefined
      ? ''
      : typeof value === 'string'
        ? value
        : typeof value === 'number' || typeof value === 'boolean'
          ? String(value)
          : JSON.stringify(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvLine(cells: readonly unknown[]): string {
  return cells.map(csvCell).join(',');
}

/** `2026-11-19T06:30:00.000Z` → `2026-11-19 12:00:00` (IST, no DST). */
export function formatIst(date: Date): string {
  const shifted = new Date(date.getTime() + 330 * 60_000);
  return shifted.toISOString().replace('T', ' ').slice(0, 19);
}

export const CSV_COLUMNS = [
  'id',
  'createdAtUtc',
  'createdAtIst',
  'actorType',
  'actorId',
  'actorName',
  'actorRole',
  'action',
  'eventKey',
  'module',
  'entityType',
  'entityId',
  'entityLabel',
  'outcome',
  'reason',
  'changedFields',
  'oldValues',
  'newValues',
  'metadata',
  'ipAddress',
  'requestId',
] as const;

export function buildAuditCsv(
  dtos: readonly AuditLogDto[],
  header: { generatedAt: Date; generatedBy: string; filters: Record<string, unknown> },
): string {
  const lines = [
    csvLine(['Audit log export']),
    csvLine(['Generated at (UTC)', header.generatedAt.toISOString()]),
    csvLine(['Generated at (IST)', formatIst(header.generatedAt)]),
    csvLine(['Generated by', header.generatedBy]),
    csvLine(['Filters', header.filters]),
    csvLine(['Rows', dtos.length]),
    '',
    csvLine(CSV_COLUMNS),
    ...dtos.map((d) =>
      csvLine([
        d.id,
        d.createdAt,
        formatIst(new Date(d.createdAt)),
        d.actor.type,
        d.actor.id,
        d.actor.name,
        d.actor.roles.join('|'),
        d.action,
        d.eventKey,
        d.module,
        d.entityType,
        d.entityId,
        d.entityLabel,
        d.outcome,
        d.reason,
        d.changedFields.join('|'),
        d.changes?.old ?? null,
        d.changes?.new ?? null,
        d.metadata,
        d.ip,
        d.requestId,
      ]),
    ),
  ];
  return `${UTF8_BOM}${lines.join('\r\n')}\r\n`;
}

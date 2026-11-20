/**
 * System settings use-cases — API_DOCUMENTATION.md §3.11 / §4.16, DATABASE_DESIGN.md §13.11.
 *
 * - Keys are created by the seed only; PATCH updates existing keys (unknown key → 422).
 * - Each value is validated against `value_type` (+ known-key rules); `tax.*` keys additionally
 *   require `tax.update` (§13.11).
 * - Optimistic concurrency: `UPDATE … WHERE setting_key = ? AND version = ?` (0 rows → 409).
 * - One `SETTINGS_CHANGE` audit row per key, in the same transaction; secret-looking keys are
 *   redacted by the audit service.
 * - `GET /settings/public` returns `is_public` rows only, cached ≤ 60 s and invalidated on write.
 */
import type { AppContainer } from '../../container.js';
import { AppError, type ErrorDetail } from '../../core/errors/AppError.js';
import { withTransaction } from '../../core/db/transaction.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { ValueType } from '../../generated/prisma/enums.js';
import type { AuditActor } from '../audit/audit.service.js';
import { hasPermission, type AuthContext } from '../rbac/permission.service.js';
import type { PatchSettingsBody } from './settings.schemas.js';
import { presentValue, publicFieldName, validateSettingValue } from './settings.values.js';

export const PUBLIC_SETTINGS_CACHE_KEY = 'settings:public';
const PUBLIC_CACHE_TTL_SECONDS = 60;

export interface SettingDto {
  key: string;
  value: unknown;
  valueType: ValueType;
  isPublic: boolean;
  description: string | null;
  version: number;
  updatedAt: string;
}

export interface SettingGroupDto {
  group: string;
  settings: SettingDto[];
}

interface SettingRow {
  settingKey: string;
  groupKey: string;
  value: Prisma.JsonValue;
  valueType: ValueType;
  isPublic: boolean;
  description: string | null;
  version: number;
  updatedAt: Date;
}

function toDto(row: SettingRow): SettingDto {
  return {
    key: row.settingKey,
    value: presentValue(row.settingKey, row.value),
    valueType: row.valueType,
    isPublic: row.isPublic,
    description: row.description,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function groupSettings(rows: readonly SettingRow[]): SettingGroupDto[] {
  const groups = new Map<string, SettingDto[]>();
  for (const row of [...rows].sort((a, b) => a.settingKey.localeCompare(b.settingKey))) {
    const list = groups.get(row.groupKey) ?? [];
    list.push(toDto(row));
    groups.set(row.groupKey, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, settings]) => ({ group, settings }));
}

/** Canonical seller GSTIN key (D-57); owned by the tax module. */
export const SELLER_GSTIN_KEY = 'tax.seller_gstin';

/**
 * Storefront footer shows the GSTIN (DESIGN_SYSTEM.md "Legal name / GSTIN in footer"). It is read from
 * the canonical tax key and published as `store.gstin` only when configured — a GSTIN is a public
 * business identifier, not a secret.
 */
export function withPublicGstin(
  payload: Record<string, Record<string, unknown>>,
  value: unknown,
): Record<string, Record<string, unknown>> {
  if (typeof value !== 'string' || value.trim() === '') return payload;
  return { ...payload, store: { ...payload.store, gstin: value.trim() } };
}

/** Public payload: `{ store: { name, supportEmail }, checkout: { maxQtyPerLine }, … }`. */
export function buildPublicSettings(
  rows: readonly Pick<SettingRow, 'settingKey' | 'groupKey' | 'value' | 'isPublic'>[],
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const row of rows) {
    if (!row.isPublic) continue;
    const group = (out[row.groupKey] ??= {});
    group[publicFieldName(row.settingKey, row.groupKey)] = presentValue(row.settingKey, row.value);
  }
  return out;
}

const rowSelect = {
  settingKey: true,
  groupKey: true,
  value: true,
  valueType: true,
  isPublic: true,
  description: true,
  version: true,
  updatedAt: true,
} as const satisfies Prisma.SettingSelect;

export function createSettingsService(c: AppContainer) {
  const { db, audit, store } = c;

  return {
    async listAdmin(group?: string): Promise<SettingGroupDto[]> {
      const rows = await db.setting.findMany({
        where: group === undefined ? {} : { groupKey: group },
        select: rowSelect,
      });
      return groupSettings(rows);
    },

    async getPublic(): Promise<Record<string, Record<string, unknown>>> {
      const cached = store.get(PUBLIC_SETTINGS_CACHE_KEY);
      if (cached !== undefined) return cached as Record<string, Record<string, unknown>>;
      const [rows, gstin] = await Promise.all([
        db.setting.findMany({
          where: { isPublic: true },
          select: { settingKey: true, groupKey: true, value: true, isPublic: true },
        }),
        db.setting.findUnique({
          where: { settingKey: SELLER_GSTIN_KEY },
          select: { value: true },
        }),
      ]);
      const payload = withPublicGstin(buildPublicSettings(rows), gstin?.value);
      store.set(PUBLIC_SETTINGS_CACHE_KEY, payload, PUBLIC_CACHE_TTL_SECONDS);
      return payload;
    },

    async patch(
      authz: AuthContext,
      actor: AuditActor,
      body: PatchSettingsBody,
    ): Promise<{ updated: SettingDto[] }> {
      const keys = body.changes.map((ch) => ch.key);
      const rows = await db.setting.findMany({
        where: { settingKey: { in: keys } },
        select: rowSelect,
      });
      const byKey = new Map(rows.map((r) => [r.settingKey, r]));

      const details: ErrorDetail[] = [];
      body.changes.forEach((ch, i) => {
        const row = byKey.get(ch.key);
        if (row === undefined) {
          details.push({ field: `changes[${i}].key`, message: 'Unknown setting.' });
          return;
        }
        const problem = validateSettingValue(ch.key, row.valueType, ch.value);
        if (problem !== undefined) details.push({ field: `changes[${i}].value`, message: problem });
      });
      if (details.length > 0) throw new AppError('VALIDATION_ERROR', undefined, { details });

      const taxKeys = keys.filter((k) => k.startsWith('tax.'));
      if (taxKeys.length > 0 && !hasPermission(authz, 'tax.update')) {
        await audit.recordSafe(db, actor, {
          action: 'PERMISSION_DENIED',
          module: 'settings',
          entityType: 'Setting',
          outcome: 'FAILURE',
          reason: 'MISSING_PERMISSION',
          eventKey: 'authz.denied',
          diff: false,
          metadata: { required: ['tax.update'], settingKeys: taxKeys },
        });
        throw new AppError('PERMISSION_DENIED', undefined, {
          details: [{ code: 'PERMISSION_DENIED', message: 'Tax settings need tax.update.' }],
        });
      }

      const conflicts = body.changes.flatMap((ch, i) => {
        const row = byKey.get(ch.key);
        return row !== undefined && row.version !== ch.version
          ? [{ i, key: ch.key, current: row.version }]
          : [];
      });
      if (conflicts.length > 0) {
        throw new AppError('CONFLICT', 'Settings were changed by someone else. Reload and retry.', {
          details: conflicts.map((x) => ({
            field: `changes[${x.i}].version`,
            code: 'VERSION_MISMATCH',
            message: 'Stale version.',
            meta: { key: x.key, currentVersion: x.current },
          })),
        });
      }

      const updated = await withTransaction(db, async ({ tx, ...ctx }) => {
        const out: SettingDto[] = [];
        for (const ch of body.changes) {
          const row = byKey.get(ch.key);
          if (row === undefined) continue;
          const result = await tx.setting.updateMany({
            where: { settingKey: ch.key, version: ch.version },
            data: {
              value: ch.value as Prisma.InputJsonValue,
              version: { increment: 1 },
              updatedById: actor.userId ?? null,
            },
          });
          if (result.count === 0) {
            throw new AppError(
              'CONFLICT',
              'Settings were changed by someone else. Reload and retry.',
              {
                details: [{ field: 'changes', code: 'VERSION_MISMATCH', message: ch.key }],
              },
            );
          }
          await audit.record(tx, actor, {
            action: 'SETTINGS_CHANGE',
            module: 'settings',
            entityType: 'Setting',
            before: { [ch.key]: row.value },
            after: { [ch.key]: ch.value },
            reason: body.reason,
            eventKey: 'settings.updated',
            metadata: {
              entityLabel: ch.key,
              group: row.groupKey,
              version: ch.version + 1,
              isPublic: row.isPublic,
            },
          });
          out.push(
            toDto({
              ...row,
              value: ch.value,
              version: ch.version + 1,
              updatedAt: c.clock(),
            }),
          );
        }
        ctx.afterCommit(() => {
          store.delete(PUBLIC_SETTINGS_CACHE_KEY);
        });
        return out;
      });
      return { updated };
    },
  };
}

export type SettingsService = ReturnType<typeof createSettingsService>;

/**
 * Permission catalogue seed — 88 keys from `src/lib/permissions.ts` (ROLE_PERMISSION_AND_AUDIT_LOGS
 * §3, DATABASE_DESIGN §25.3). `permissions.code` = key. Rows are created only by seed/migration,
 * never by an API (rule R10). Idempotent: upsert by `code`; keys no longer in the catalogue are
 * flagged `is_deprecated` (never deleted — role mappings and overrides reference them).
 */
import type { Queryable } from '../../src/core/db/transaction.js';
import { PERMISSIONS, type PermissionDefinition } from '../../src/lib/permissions.js';

export interface PermissionSeedRow {
  readonly code: string;
  readonly module: string;
  readonly action: string;
  readonly description: string;
  readonly isCritical: boolean;
  readonly sortOrder: number;
}

/** Pure: the rows the seed upserts (`is_reserved` has no column; reserved keys say so in text). */
export function buildPermissionRows(
  definitions: readonly PermissionDefinition[] = PERMISSIONS,
): PermissionSeedRow[] {
  return definitions.map((p) => ({
    code: p.key,
    module: p.module,
    action: p.action,
    description: p.description.slice(0, 255),
    isCritical: p.isCritical,
    sortOrder: p.sortOrder,
  }));
}

export async function seedPermissions(
  db: Queryable,
): Promise<{ upserted: number; deprecated: number }> {
  const rows = buildPermissionRows();
  for (const row of rows) {
    await db.permission.upsert({
      where: { code: row.code },
      create: { ...row, isDeprecated: false },
      update: {
        module: row.module,
        action: row.action,
        description: row.description,
        isCritical: row.isCritical,
        sortOrder: row.sortOrder,
        isDeprecated: false,
      },
    });
  }
  const deprecated = await db.permission.updateMany({
    where: { code: { notIn: rows.map((r) => r.code) }, isDeprecated: false },
    data: { isDeprecated: true },
  });
  return { upserted: rows.length, deprecated: deprecated.count };
}

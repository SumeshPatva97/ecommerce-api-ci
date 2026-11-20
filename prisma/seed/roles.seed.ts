/**
 * System roles and role templates — ROLE_PERMISSION_AND_AUDIT_LOGS §2, §5; DATABASE_DESIGN §25.2.
 *
 * | Role        | Rows                          | On re-run                                            |
 * | SUPERADMIN  | none (bypass via is_superadmin) | any stray rows removed                             |
 * | ADMIN       | every key incl. reserved      | missing keys added (OQ-27 auto-grant of new keys)    |
 * | MANAGER/EMPLOYEE/STAFF | `templatePermissions()` | granted only when the role is first created — the client edits them afterwards |
 *
 * Idempotent: roles are looked up by `code`; nothing the client changed is overwritten.
 */
import type { Queryable } from '../../src/core/db/transaction.js';
import { normalizeText } from '../../src/lib/normalize.js';
import {
  PERMISSIONS,
  SYSTEM_ROLES,
  TEMPLATE_ROLES,
  templatePermissions,
} from '../../src/lib/permissions.js';

export type PermissionSync = 'none' | 'all' | 'on-create';

export interface RoleSeedDefinition {
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly isSystem: boolean;
  readonly permissionKeys: readonly string[];
  readonly sync: PermissionSync;
}

const NAMES: Readonly<Record<string, readonly [string, string]>> = {
  SUPERADMIN: ['Superadmin', 'Full access; bypasses permission checks (still audited).'],
  ADMIN: ['Admin', 'All permissions; individual Admins can be restricted with DENY overrides.'],
  MANAGER: ['Manager', 'Store/operations manager template (editable).'],
  EMPLOYEE: ['Employee', 'Catalogue & order-processing template (editable).'],
  STAFF: ['Staff', 'Warehouse / packing template (editable).'],
};

/** Pure: the role definitions the seed applies. */
export function buildRoleDefinitions(): RoleSeedDefinition[] {
  const meta = (code: string): readonly [string, string] => NAMES[code] ?? [code, ''];
  const system: RoleSeedDefinition[] = SYSTEM_ROLES.map((code) => ({
    code,
    name: meta(code)[0],
    description: meta(code)[1],
    isSystem: true,
    permissionKeys: code === 'ADMIN' ? PERMISSIONS.map((p) => p.key) : [],
    sync: code === 'ADMIN' ? 'all' : 'none',
  }));
  const templates: RoleSeedDefinition[] = TEMPLATE_ROLES.map((code) => ({
    code,
    name: meta(code)[0],
    description: meta(code)[1],
    isSystem: false,
    permissionKeys: templatePermissions(code),
    sync: 'on-create',
  }));
  return [...system, ...templates];
}

export async function seedRoles(
  db: Queryable,
  definitions: readonly RoleSeedDefinition[] = buildRoleDefinitions(),
): Promise<{ created: string[]; grants: number }> {
  const permissionRows = await db.permission.findMany({ select: { id: true, code: true } });
  const idOf = new Map(permissionRows.map((p) => [p.code, p.id]));
  const created: string[] = [];
  let grants = 0;

  for (const def of definitions) {
    const existing = await db.role.findUnique({ where: { code: def.code }, select: { id: true } });
    let roleId: string;
    if (existing === null) {
      const role = await db.role.create({
        data: {
          code: def.code,
          name: def.name,
          nameNormalized: normalizeText(def.name),
          description: def.description,
          isSystem: def.isSystem,
          isActive: true,
        },
        select: { id: true },
      });
      roleId = role.id;
      created.push(def.code);
    } else {
      roleId = existing.id;
      if (def.isSystem) {
        await db.role.update({ where: { id: roleId }, data: { isSystem: true, isActive: true } });
      }
    }

    if (def.sync === 'none') {
      await db.rolePermission.deleteMany({ where: { roleId } });
      continue;
    }
    if (def.sync === 'on-create' && existing !== null) continue;
    const missing = def.permissionKeys.filter((k) => !idOf.has(k));
    if (missing.length > 0) {
      throw new Error(`Permission rows missing (seed permissions first): ${missing.join(', ')}`);
    }
    const result = await db.rolePermission.createMany({
      data: def.permissionKeys.map((key) => ({ roleId, permissionId: idOf.get(key) ?? '' })),
      skipDuplicates: true,
    });
    grants += result.count;
  }
  return { created, grants };
}

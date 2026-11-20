/**
 * Row factories for staff/RBAC HTTP tests (MOCKED DB — shapes mirror the repository selects).
 */
import { randomUUID } from 'node:crypto';

import { PERMISSIONS, templatePermissions } from '../../../../src/lib/permissions.js';
import { buildModuleTestApp, type ModuleTestApp } from '../../../helpers/container.js';
import { createStaffModule } from '../../../../src/modules/staff/index.js';

export const NOW = new Date('2026-11-19T06:30:00.000Z');
export const ALL_KEYS = PERMISSIONS.map((p) => p.key);
export const MANAGER_KEYS = templatePermissions('MANAGER');
export const IDEM = { 'Content-Type': 'application/json' };

export interface RoleRef {
  id?: string;
  code: string;
  name?: string;
  isSystem?: boolean;
  isActive?: boolean;
}

export function staffRow(
  overrides: {
    id?: string;
    status?: string;
    isSuperadmin?: boolean;
    roles?: RoleRef[];
    firstName?: string;
    phone?: string | null;
  } = {},
) {
  return {
    id: overrides.id ?? randomUUID(),
    accountType: 'STAFF',
    email: 'staff@example.com',
    phone: overrides.phone ?? null,
    firstName: overrides.firstName ?? 'Ravi',
    lastName: 'Kulkarni',
    status: overrides.status ?? 'ACTIVE',
    isSuperadmin: overrides.isSuperadmin ?? false,
    mfaEnabled: false,
    emailVerifiedAt: NOW,
    lastLoginAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    userRoles: (overrides.roles ?? []).map((r) => ({
      assignedAt: NOW,
      role: {
        id: r.id ?? randomUUID(),
        code: r.code,
        name: r.name ?? r.code,
        isSystem: r.isSystem ?? (r.code === 'ADMIN' || r.code === 'SUPERADMIN'),
        isActive: r.isActive ?? true,
      },
    })),
  };
}

/** `findRolesWithKeys` row shape (role.findMany). */
export function roleWithKeys(code: string, keys: readonly string[], id: string = randomUUID()) {
  return {
    id,
    code,
    name: code,
    isActive: true,
    rolePermissions: keys.map((k) => ({ permission: { code: k } })),
  };
}

/** `findRole` row shape (role.findUnique with roleDetailSelect). */
export function roleDetail(
  overrides: {
    id?: string;
    code?: string;
    isSystem?: boolean;
    isActive?: boolean;
    keys?: readonly string[];
    userCount?: number;
  } = {},
) {
  const code = overrides.code ?? 'EMPLOYEE';
  return {
    id: overrides.id ?? randomUUID(),
    code,
    name: code.charAt(0) + code.slice(1).toLowerCase(),
    isSystem: overrides.isSystem ?? false,
    isActive: overrides.isActive ?? true,
    description: null,
    createdAt: NOW,
    updatedAt: NOW,
    rolePermissions: (overrides.keys ?? []).map((k) => ({ permission: { code: k } })),
    _count: { userRoles: overrides.userCount ?? 0 },
  };
}

/** Staff module app with the write-path defaults every mutation needs. */
export function staffApp(): ModuleTestApp {
  const t = buildModuleTestApp([createStaffModule], {
    now: NOW,
    env: { REFRESH_TOKEN_PEPPER: 'test-pepper-for-invite-hash' },
  });
  t.m.refreshToken.updateMany.mockResolvedValue({ count: 2 });
  t.m.verificationToken.updateMany.mockResolvedValue({ count: 0 });
  t.m.auditLog.create.mockResolvedValue({});
  t.m.userRole.findMany.mockResolvedValue([]);
  t.m.userPermissionOverride.findMany.mockResolvedValue([]);
  return t;
}

/** Audit rows written so far (`auditLog.create` data). */
export function auditRows(t: ModuleTestApp): Record<string, unknown>[] {
  return t.m.auditLog.create.mock.calls.map(
    (call) => (call[0] as { data: Record<string, unknown> }).data,
  );
}

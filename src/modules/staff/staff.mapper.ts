/**
 * Row → DTO mapping for staff, roles and the permission catalogue. Never exposes password hashes,
 * MFA secrets or token material.
 */
import { PERMISSIONS, type PermissionDefinition } from '../../lib/permissions.js';
import type { RoleRow, StaffRow } from './staff.repository.js';

export interface RoleSummaryDto {
  id: string;
  code: string;
  name: string;
  isSystem: boolean;
  isActive: boolean;
}

export interface StaffDto {
  id: string;
  email: string;
  firstName: string;
  lastName: string | null;
  phone: string | null;
  status: string;
  isSuperadmin: boolean;
  mfaEnabled: boolean;
  emailVerified: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
  roles: RoleSummaryDto[];
}

export function toStaffDto(row: StaffRow): StaffDto {
  return {
    id: row.id,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    phone: row.phone,
    status: row.status,
    isSuperadmin: row.isSuperadmin,
    mfaEnabled: row.mfaEnabled,
    emailVerified: row.emailVerifiedAt !== null,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    roles: row.userRoles.map((ur) => ({ ...ur.role })),
  };
}

export interface RoleDto extends RoleSummaryDto {
  description: string | null;
  permissionKeys: string[];
  userCount: number;
  createdAt: string;
  updatedAt: string;
}

export function toRoleDto(row: RoleRow): RoleDto {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    isSystem: row.isSystem,
    isActive: row.isActive,
    permissionKeys: row.rolePermissions.map((rp) => rp.permission.code).sort(),
    userCount: row._count.userRoles,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const ACTION_LABELS: Readonly<Record<string, string>> = {
  view: 'View',
  create: 'Create',
  update: 'Update',
  delete: 'Delete',
  export: 'Export',
  approve: 'Approve',
};

export function moduleLabel(module: string): string {
  return module
    .split('_')
    .map((part) => (part === '' ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ');
}

export interface PermissionGroupDto {
  module: string;
  label: string;
  actions: {
    key: string;
    action: string;
    label: string;
    description: string;
    isCritical: boolean;
    isReserved: boolean;
  }[];
}

/** `GET /admin/permissions` — catalogue grouped by module, in catalogue order. */
export function permissionCatalogue(
  definitions: readonly PermissionDefinition[] = PERMISSIONS,
): PermissionGroupDto[] {
  const groups = new Map<string, PermissionGroupDto>();
  for (const p of definitions) {
    let group = groups.get(p.module);
    if (group === undefined) {
      group = { module: p.module, label: moduleLabel(p.module), actions: [] };
      groups.set(p.module, group);
    }
    group.actions.push({
      key: p.key,
      action: p.action,
      label: ACTION_LABELS[p.action] ?? p.action,
      description: p.description,
      isCritical: p.isCritical,
      isReserved: p.isReserved,
    });
  }
  return [...groups.values()];
}

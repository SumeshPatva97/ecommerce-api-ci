/**
 * Staff / RBAC persistence — Prisma queries only (BACKEND_STRUCTURE.md §4).
 */
import type { Prisma } from '../../generated/prisma/client.js';
import type { Queryable } from '../../core/db/transaction.js';

export const roleSummarySelect = {
  id: true,
  code: true,
  name: true,
  isSystem: true,
  isActive: true,
} as const satisfies Prisma.RoleSelect;

export const staffSelect = {
  id: true,
  accountType: true,
  email: true,
  phone: true,
  firstName: true,
  lastName: true,
  status: true,
  isSuperadmin: true,
  mfaEnabled: true,
  emailVerifiedAt: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  userRoles: {
    select: { assignedAt: true, role: { select: roleSummarySelect } },
    orderBy: { assignedAt: 'asc' },
  },
} as const satisfies Prisma.UserSelect;

export type StaffRow = Prisma.UserGetPayload<{ select: typeof staffSelect }>;

export const roleDetailSelect = {
  ...roleSummarySelect,
  description: true,
  createdAt: true,
  updatedAt: true,
  rolePermissions: { select: { permission: { select: { code: true } } } },
  _count: { select: { userRoles: true } },
} as const satisfies Prisma.RoleSelect;

export type RoleRow = Prisma.RoleGetPayload<{ select: typeof roleDetailSelect }>;

export function findStaff(db: Queryable, userId: string): Promise<StaffRow | null> {
  return db.user.findFirst({
    where: { id: userId, accountType: 'STAFF', deletedAt: null },
    select: staffSelect,
  });
}

export function staffWhere(filters: {
  q?: string | undefined;
  status?: Prisma.UserWhereInput['status'];
  roleId?: string | undefined;
}): Prisma.UserWhereInput {
  const where: Prisma.UserWhereInput = { accountType: 'STAFF', deletedAt: null };
  if (filters.status !== undefined) where.status = filters.status;
  if (filters.roleId !== undefined) where.userRoles = { some: { roleId: filters.roleId } };
  if (filters.q !== undefined) {
    where.OR = [
      { firstName: { contains: filters.q } },
      { lastName: { contains: filters.q } },
      { emailNormalized: { contains: filters.q.toLowerCase() } },
    ];
  }
  return where;
}

/** Superadmins that can currently sign in (R5 / §21.4 invariant). */
export function countActiveSuperadmins(db: Queryable): Promise<number> {
  return db.user.count({
    where: { isSuperadmin: true, status: 'ACTIVE', accountType: 'STAFF', deletedAt: null },
  });
}

/** Superadmins counted against `SUPERADMIN_MAX` (active or invited). */
export function countLiveSuperadmins(db: Queryable): Promise<number> {
  return db.user.count({
    where: {
      isSuperadmin: true,
      accountType: 'STAFF',
      deletedAt: null,
      status: { in: ['ACTIVE', 'PENDING_VERIFICATION'] },
    },
  });
}

export async function findRolesWithKeys(
  db: Queryable,
  roleIds: readonly string[],
): Promise<
  { id: string; code: string; name: string; isActive: boolean; permissionKeys: string[] }[]
> {
  if (roleIds.length === 0) return [];
  const rows = await db.role.findMany({
    where: { id: { in: [...roleIds] } },
    select: {
      id: true,
      code: true,
      name: true,
      isActive: true,
      rolePermissions: { select: { permission: { select: { code: true } } } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    isActive: r.isActive,
    permissionKeys: r.rolePermissions.map((rp) => rp.permission.code).sort(),
  }));
}

export function findRole(db: Queryable, roleId: string): Promise<RoleRow | null> {
  return db.role.findUnique({ where: { id: roleId }, select: roleDetailSelect });
}

export function findRoleByCode(db: Queryable, code: string): Promise<{ id: string } | null> {
  return db.role.findUnique({ where: { code }, select: { id: true } });
}

export async function permissionIdsByKey(
  db: Queryable,
  keys: readonly string[],
): Promise<Map<string, string>> {
  if (keys.length === 0) return new Map();
  const rows = await db.permission.findMany({
    where: { code: { in: [...keys] } },
    select: { id: true, code: true },
  });
  return new Map(rows.map((r) => [r.code, r.id]));
}

export async function findDenyOverrides(
  db: Queryable,
  userId: string,
): Promise<{ permissionKey: string; reason: string | null; createdAt: Date }[]> {
  const rows = await db.userPermissionOverride.findMany({
    where: { userId, effect: 'DENY' },
    select: { reason: true, createdAt: true, permission: { select: { code: true } } },
  });
  return rows
    .map((r) => ({ permissionKey: r.permission.code, reason: r.reason, createdAt: r.createdAt }))
    .sort((a, b) => a.permissionKey.localeCompare(b.permissionKey));
}

/** Pending invite tokens become unusable when the account is disabled or deleted. */
export function invalidateInvites(db: Queryable, userId: string, now: Date): Promise<unknown> {
  return db.verificationToken.updateMany({
    where: { userId, purpose: 'STAFF_INVITE', consumedAt: null, invalidatedAt: null },
    data: { invalidatedAt: now },
  });
}

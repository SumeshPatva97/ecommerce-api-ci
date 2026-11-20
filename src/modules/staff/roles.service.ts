/**
 * Roles & role-permission mapping — API_DOCUMENTATION.md §4.15, ROLE_PERMISSION_AND_AUDIT_LOGS.md
 * §4–§6. System roles (`SUPERADMIN`, `ADMIN`) cannot be renamed, deactivated or deleted; only a
 * Superadmin edits them (R3). A non-Superadmin cannot edit a role they hold (R8) or grant keys they
 * lack (R1). Permission-mapping changes revoke every member's sessions (R6) and bump the RBAC
 * cache version (§18.3).
 */
import type { AppContainer } from '../../container.js';
import { AppError } from '../../core/errors/AppError.js';
import { buildPageMeta, toSkipTake, type PageMeta } from '../../core/http/pagination.js';
import { withTransaction } from '../../core/db/transaction.js';
import { normalizeText } from '../../lib/normalize.js';
import { revokeUserSessions } from '../auth/sessions.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { toRoleDto, type RoleDto } from './staff.mapper.js';
import {
  checkPermissionGrant,
  checkRoleEditable,
  diffSets,
  toAppError,
  violation,
  type PolicyViolation,
} from './staff.policy.js';
import {
  findRole,
  permissionIdsByKey,
  roleDetailSelect,
  type RoleRow,
} from './staff.repository.js';
import type {
  CreateRoleBody,
  ListRolesQuery,
  SetRolePermissionsBody,
  UpdateRoleBody,
} from './staff.schemas.js';
import type { ActorRef } from './staff.service.js';

const MODULE = 'roles';
const SYSTEM_CODES: ReadonlySet<string> = new Set(['SUPERADMIN', 'ADMIN']);

export interface RoleListItem extends Omit<RoleDto, 'permissionKeys'> {
  permissionCount: number;
}

export function createRolesService(c: AppContainer) {
  const { db, audit, permissions, clock } = c;

  async function reject(
    actor: ActorRef,
    entityId: string | undefined,
    v: PolicyViolation,
    extra: readonly PolicyViolation[] = [],
  ): Promise<AppError> {
    // Plain validation problems (reserved keys) are not access attempts: no audit row.
    if (v.error === 'VALIDATION_ERROR') return toAppError(v, extra);
    await audit.recordSafe(db, actor.audit, {
      action: 'PERMISSION_DENIED',
      module: MODULE,
      entityType: 'Role',
      entityId,
      outcome: 'FAILURE',
      reason: v.code,
      eventKey: 'authz.policy_denied',
      diff: false,
      metadata: {
        codes: [v, ...extra].map((x) => x.code),
        ...(v.meta === undefined ? {} : { meta: v.meta }),
      },
    });
    return toAppError(v, extra);
  }

  async function loadRole(roleId: string): Promise<RoleRow> {
    const role = await findRole(db, roleId);
    if (role === null) throw new AppError('NOT_FOUND', 'Role not found.');
    return role;
  }

  async function ensurePermissionRows(keys: readonly string[]): Promise<Map<string, string>> {
    const ids = await permissionIdsByKey(db, keys);
    const missing = keys.filter((k) => !ids.has(k));
    if (missing.length > 0) {
      throw new AppError('CONFLICT', 'Permission catalogue is not seeded.', {
        details: [
          { field: 'permissionKeys', message: 'Run the permission seed.', meta: { missing } },
        ],
      });
    }
    return ids;
  }

  async function ensureNameFree(name: string, exceptId?: string): Promise<string> {
    const nameNormalized = normalizeText(name);
    const clash = await db.role.findUnique({ where: { nameNormalized }, select: { id: true } });
    if (clash !== null && clash.id !== exceptId) {
      throw new AppError('DUPLICATE_RESOURCE', 'A role with this name already exists.', {
        details: [{ field: 'name', message: 'Must be unique.' }],
      });
    }
    return nameNormalized;
  }

  /** Revokes every member's sessions inside the transaction; returns affected user ids + count. */
  async function revokeMembers(
    tx: Prisma.TransactionClient,
    roleId: string,
    now: Date,
  ): Promise<{ userIds: string[]; sessionsRevoked: number }> {
    const members = await tx.userRole.findMany({ where: { roleId }, select: { userId: true } });
    let sessionsRevoked = 0;
    for (const m of members) {
      sessionsRevoked += await revokeUserSessions(tx, m.userId, 'PERMISSION_CHANGED', now);
    }
    return { userIds: members.map((m) => m.userId), sessionsRevoked };
  }

  return {
    async list(query: ListRolesQuery): Promise<{ data: RoleListItem[]; meta: PageMeta }> {
      const where: Prisma.RoleWhereInput = {};
      if (query.isActive !== undefined) where.isActive = query.isActive === 'true';
      if (query.q !== undefined) {
        where.OR = [
          { nameNormalized: { contains: normalizeText(query.q) } },
          { code: { contains: query.q.toUpperCase() } },
        ];
      }
      const [total, rows] = await Promise.all([
        db.role.count({ where }),
        db.role.findMany({
          where,
          select: roleDetailSelect,
          orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
          ...toSkipTake(query.page, query.limit),
        }),
      ]);
      return {
        data: rows.map((row) => {
          const { permissionKeys, ...rest } = toRoleDto(row);
          return { ...rest, permissionCount: permissionKeys.length };
        }),
        meta: buildPageMeta(query.page, query.limit, total),
      };
    },

    async get(roleId: string): Promise<RoleDto> {
      return toRoleDto(await loadRole(roleId));
    },

    async create(actor: ActorRef, body: CreateRoleBody): Promise<RoleDto> {
      if (SYSTEM_CODES.has(body.code)) {
        throw toAppError(
          violation('SYSTEM_ROLE', 'System role codes are reserved.', { field: 'code' }),
        );
      }
      const grant = checkPermissionGrant(actor.authz, body.code, body.permissionKeys);
      if (grant !== undefined) throw await reject(actor, undefined, grant);
      const existing = await db.role.findUnique({
        where: { code: body.code },
        select: { id: true },
      });
      if (existing !== null) {
        throw new AppError('DUPLICATE_RESOURCE', 'A role with this code already exists.', {
          details: [{ field: 'code', message: 'Must be unique.' }],
        });
      }
      const nameNormalized = await ensureNameFree(body.name);
      const ids = await ensurePermissionRows(body.permissionKeys);
      const now = clock();
      const created = await withTransaction(db, async ({ tx }) => {
        const role = await tx.role.create({
          data: {
            code: body.code,
            name: body.name,
            nameNormalized,
            description: body.description ?? null,
            isSystem: false,
            isActive: true,
            createdById: actor.authz.userId,
            updatedById: actor.authz.userId,
          },
          select: { id: true },
        });
        if (body.permissionKeys.length > 0) {
          await tx.rolePermission.createMany({
            data: body.permissionKeys.map((key) => ({
              roleId: role.id,
              permissionId: ids.get(key) ?? '',
              grantedById: actor.authz.userId,
              grantedAt: now,
            })),
          });
        }
        await audit.record(tx, actor.audit, {
          action: 'CREATE',
          module: MODULE,
          entityType: 'Role',
          entityId: role.id,
          after: {
            id: role.id,
            code: body.code,
            name: body.name,
            permissions: [...body.permissionKeys].sort(),
          },
          eventKey: 'roles.created',
          metadata: { entityLabel: body.code },
        });
        return findRole(tx, role.id);
      });
      if (created === null) throw new AppError('INTERNAL_ERROR');
      return toRoleDto(created);
    },

    async update(actor: ActorRef, roleId: string, body: UpdateRoleBody): Promise<RoleDto> {
      const role = await loadRole(roleId);
      const editable = checkRoleEditable(actor.authz, role);
      if (editable !== undefined) throw await reject(actor, roleId, editable);
      const renaming = body.name !== undefined && body.name !== role.name;
      const togglingActive = body.isActive !== undefined && body.isActive !== role.isActive;
      if (role.isSystem && (renaming || togglingActive)) {
        throw toAppError(
          violation('SYSTEM_ROLE', 'System roles cannot be renamed or deactivated.'),
        );
      }
      // Re-activating a role grants its permissions to every member again (R1).
      if (togglingActive && body.isActive === true) {
        const grant = checkPermissionGrant(
          actor.authz,
          role.code,
          role.rolePermissions.map((rp) => rp.permission.code),
        );
        if (grant !== undefined) throw await reject(actor, roleId, grant);
      }
      const nameNormalized =
        renaming && body.name !== undefined ? await ensureNameFree(body.name, roleId) : undefined;
      const now = clock();
      const updated = await withTransaction(db, async ({ tx, ...ctx }) => {
        await tx.role.update({
          where: { id: roleId },
          data: {
            ...(body.name === undefined ? {} : { name: body.name }),
            ...(nameNormalized === undefined ? {} : { nameNormalized }),
            ...(body.description === undefined ? {} : { description: body.description }),
            ...(body.isActive === undefined ? {} : { isActive: body.isActive }),
            updatedById: actor.authz.userId,
          },
        });
        let affected: { userIds: string[]; sessionsRevoked: number } = {
          userIds: [],
          sessionsRevoked: 0,
        };
        if (togglingActive) affected = await revokeMembers(tx, roleId, now);
        await audit.record(tx, actor.audit, {
          action: togglingActive ? 'STATUS_CHANGE' : 'UPDATE',
          module: MODULE,
          entityType: 'Role',
          entityId: roleId,
          before: {
            id: roleId,
            name: role.name,
            description: role.description,
            isActive: role.isActive,
          },
          after: {
            id: roleId,
            name: body.name ?? role.name,
            description: body.description === undefined ? role.description : body.description,
            isActive: body.isActive ?? role.isActive,
          },
          eventKey: 'roles.updated',
          metadata: {
            entityLabel: role.code,
            usersAffected: affected.userIds.length,
            sessionsRevoked: affected.sessionsRevoked,
          },
        });
        if (togglingActive) {
          ctx.afterCommit(() => {
            permissions.bumpVersion();
            for (const id of affected.userIds) permissions.invalidateUser(id);
          });
        }
        return findRole(tx, roleId);
      });
      if (updated === null) throw new AppError('NOT_FOUND', 'Role not found.');
      return toRoleDto(updated);
    },

    async remove(actor: ActorRef, roleId: string): Promise<{ id: string; deleted: true }> {
      const role = await loadRole(roleId);
      const editable = checkRoleEditable(actor.authz, role);
      if (editable !== undefined) throw await reject(actor, roleId, editable);
      if (role.isSystem) {
        throw toAppError(violation('SYSTEM_ROLE', 'System roles cannot be deleted.'));
      }
      await withTransaction(db, async ({ tx }) => {
        const assigned = await tx.userRole.count({ where: { roleId } });
        if (assigned > 0) {
          throw toAppError(
            violation('IN_USE', 'The role is assigned to users; reassign them first.', {
              meta: { userCount: assigned },
            }),
          );
        }
        await tx.rolePermission.deleteMany({ where: { roleId } });
        await tx.role.delete({ where: { id: roleId } });
        await audit.record(tx, actor.audit, {
          action: 'DELETE',
          module: MODULE,
          entityType: 'Role',
          entityId: roleId,
          before: {
            id: roleId,
            code: role.code,
            name: role.name,
            permissions: role.rolePermissions.map((rp) => rp.permission.code).sort(),
          },
          after: null,
          eventKey: 'roles.deleted',
          metadata: { entityLabel: role.code },
        });
      });
      return { id: roleId, deleted: true };
    },

    /** `PUT /admin/roles/:roleId/permissions` — full replacement set (rich example §4.15). */
    async setPermissions(
      actor: ActorRef,
      roleId: string,
      body: SetRolePermissionsBody,
    ): Promise<{
      roleId: string;
      code: string;
      permissionKeys: string[];
      diff: { added: string[]; removed: string[] };
      affectedUsers: number;
      sessionsRevoked: number;
    }> {
      const role = await loadRole(roleId);
      const before = role.rolePermissions.map((rp) => rp.permission.code).sort();
      const { added, removed } = diffSets(before, body.permissionKeys);

      const editable = checkRoleEditable(actor.authz, role);
      const grant = checkPermissionGrant(actor.authz, role.code, added);
      if (editable !== undefined) {
        // X6: own role → SELF_MODIFICATION (and PRIVILEGE_ESCALATION when keys are not held).
        throw await reject(actor, roleId, editable, grant === undefined ? [] : [grant]);
      }
      if (grant !== undefined) throw await reject(actor, roleId, grant);
      if (role.code === 'SUPERADMIN') {
        throw toAppError(
          violation('SYSTEM_ROLE', 'The Superadmin role has no permission rows (bypass).'),
        );
      }
      const ids = await ensurePermissionRows(added);
      const now = clock();
      const after = [...body.permissionKeys].sort();
      const result = await withTransaction(db, async ({ tx, ...ctx }) => {
        if (removed.length > 0) {
          await tx.rolePermission.deleteMany({
            where: { roleId, permission: { code: { in: removed } } },
          });
        }
        if (added.length > 0) {
          await tx.rolePermission.createMany({
            data: added.map((key) => ({
              roleId,
              permissionId: ids.get(key) ?? '',
              grantedById: actor.authz.userId,
              grantedAt: now,
            })),
            skipDuplicates: true,
          });
        }
        const changed = added.length + removed.length > 0;
        const affected = changed
          ? await revokeMembers(tx, roleId, now)
          : { userIds: [] as string[], sessionsRevoked: 0 };
        await audit.record(tx, actor.audit, {
          action: 'PERMISSION_CHANGE',
          module: MODULE,
          entityType: 'Role',
          entityId: roleId,
          before: { permissions: before },
          after: { permissions: after },
          reason: body.comment,
          eventKey: 'roles.permissions_updated',
          metadata: {
            entityLabel: role.code,
            added,
            removed,
            usersAffected: affected.userIds.length,
            sessionsRevoked: affected.sessionsRevoked,
          },
        });
        if (changed) {
          ctx.afterCommit(() => {
            permissions.bumpVersion();
            for (const id of affected.userIds) permissions.invalidateUser(id);
          });
        }
        return affected;
      });
      return {
        roleId,
        code: role.code,
        permissionKeys: after,
        diff: { added, removed },
        affectedUsers: result.userIds.length,
        sessionsRevoked: result.sessionsRevoked,
      };
    },
  };
}

export type RolesService = ReturnType<typeof createRolesService>;

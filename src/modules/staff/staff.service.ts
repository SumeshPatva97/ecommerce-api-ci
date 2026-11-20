/**
 * Staff accounts use-cases — API_DOCUMENTATION.md §4.15, ROLE_PERMISSION_AND_AUDIT_LOGS.md §6,
 * AUTHENTICATION_AUTHORIZATION.md §3, §14, §21.4.
 *
 * Every rule violation is audited (`PERMISSION_DENIED`, outcome FAILURE, reason = sub-code) via
 * `recordSafe` before the error is thrown. Successful changes write their audit rows inside the same
 * transaction; cache invalidation and emails run after commit (R6, §18.3).
 */
import type { AppContainer } from '../../container.js';
import { AppError } from '../../core/errors/AppError.js';
import { buildPageMeta, toSkipTake, type PageMeta } from '../../core/http/pagination.js';
import { withTransaction } from '../../core/db/transaction.js';
import { generateOpaqueToken, hashToken } from '../../core/security/tokens.js';
import { normalizeEmail } from '../../lib/normalize.js';
import { addHours } from '../../lib/time.js';
import type { AuditActor } from '../audit/audit.service.js';
import { revokeUserSessions } from '../auth/sessions.js';
import type { AuthContext } from '../rbac/permission.service.js';
import { toStaffDto, type StaffDto } from './staff.mapper.js';
import {
  checkAdminTarget,
  checkLastSuperadmin,
  checkNotSelf,
  checkRoleGrant,
  checkSuperadminTarget,
  checkTargetNotMorePowerful,
  diffSets,
  notHeld,
  toAppError,
  violation,
  type PolicyViolation,
  type TargetUser,
} from './staff.policy.js';
import {
  countActiveSuperadmins,
  countLiveSuperadmins,
  findDenyOverrides,
  findRoleByCode,
  findRolesWithKeys,
  findStaff,
  invalidateInvites,
  permissionIdsByKey,
  staffSelect,
  staffWhere,
  type StaffRow,
} from './staff.repository.js';
import type {
  CreateUserBody,
  ListUsersQuery,
  SetOverridesBody,
  SetStatusBody,
  UpdateUserBody,
} from './staff.schemas.js';

export interface ActorRef {
  readonly authz: AuthContext;
  readonly audit: AuditActor;
}

export interface StaffDetailDto extends StaffDto {
  permissions: 'ALL' | string[];
  deniedOverrides: { permissionKey: string; reason: string | null; createdAt: string }[];
}

const MODULE = 'admin_users';

export function createStaffService(c: AppContainer) {
  const { db, audit, permissions, clock } = c;

  /** Audits a rejected attempt and returns the error to throw. */
  async function reject(
    actor: ActorRef,
    entityId: string | undefined,
    v: PolicyViolation,
    extra: readonly PolicyViolation[] = [],
  ): Promise<AppError> {
    await audit.recordSafe(db, actor.audit, {
      action: 'PERMISSION_DENIED',
      module: MODULE,
      entityType: 'User',
      entityId,
      outcome: 'FAILURE',
      reason: v.code,
      eventKey: 'authz.policy_denied',
      diff: false,
      metadata: { code: v.code, ...(v.meta === undefined ? {} : { meta: v.meta }) },
    });
    return toAppError(v, extra);
  }

  async function guard(
    actor: ActorRef,
    entityId: string | undefined,
    ...checks: (PolicyViolation | undefined)[]
  ): Promise<void> {
    const first = checks.find((v) => v !== undefined);
    if (first !== undefined) throw await reject(actor, entityId, first);
  }

  async function loadTarget(userId: string): Promise<StaffRow> {
    const row = await findStaff(db, userId);
    if (row === null) throw new AppError('NOT_FOUND', 'Staff user not found.');
    return row;
  }

  function targetOf(row: StaffRow): TargetUser {
    return {
      id: row.id,
      isSuperadmin: row.isSuperadmin,
      roleCodes: row.userRoles.map((ur) => ur.role.code),
    };
  }

  /** R9 — skipped for Superadmin actors (they cover everyone). */
  async function checkPower(actor: ActorRef, row: StaffRow): Promise<PolicyViolation | undefined> {
    if (actor.authz.isSuperadmin) return undefined;
    const effective = await permissions.effectivePermissions(db, row.id, row.isSuperadmin);
    return checkTargetNotMorePowerful(actor.authz, effective);
  }

  function afterAccessChange(userId: string): void {
    permissions.invalidateUser(userId);
  }

  return {
    async list(query: ListUsersQuery): Promise<{ data: StaffDto[]; meta: PageMeta }> {
      const where = staffWhere(query);
      const desc = query.sort.startsWith('-');
      const field = desc ? query.sort.slice(1) : query.sort;
      const [total, rows] = await Promise.all([
        db.user.count({ where }),
        db.user.findMany({
          where,
          select: staffSelect,
          orderBy: [{ [field]: desc ? 'desc' : 'asc' }, { id: 'asc' }],
          ...toSkipTake(query.page, query.limit),
        }),
      ]);
      return { data: rows.map(toStaffDto), meta: buildPageMeta(query.page, query.limit, total) };
    },

    async get(userId: string): Promise<StaffDetailDto> {
      const row = await loadTarget(userId);
      const [effective, overrides] = await Promise.all([
        permissions.effectivePermissions(db, row.id, row.isSuperadmin),
        findDenyOverrides(db, row.id),
      ]);
      return {
        ...toStaffDto(row),
        permissions: effective,
        deniedOverrides: overrides.map((o) => ({
          permissionKey: o.permissionKey,
          reason: o.reason,
          createdAt: o.createdAt.toISOString(),
        })),
      };
    },

    /** Invite flow (§14): PENDING_VERIFICATION user + STAFF_INVITE token (72 h) + email after commit. */
    async create(actor: ActorRef, body: CreateUserBody): Promise<StaffDto> {
      // R11 / §21.4: `isSuperadmin` from a non-Superadmin → 403 PERMISSION_DENIED (audited).
      if (body.isSuperadmin !== undefined && !actor.authz.isSuperadmin) {
        throw await reject(
          actor,
          undefined,
          violation('SUPERADMIN_ONLY', 'Only a Superadmin can create a Superadmin.', {
            error: 'PERMISSION_DENIED',
            field: 'isSuperadmin',
          }),
        );
      }
      const makeSuperadmin = body.isSuperadmin === true;
      if (!makeSuperadmin && body.roleIds.length === 0) {
        throw new AppError('VALIDATION_ERROR', undefined, {
          details: [{ field: 'roleIds', message: 'Assign at least one role.' }],
        });
      }
      const roles = await findRolesWithKeys(db, body.roleIds);
      if (roles.length !== new Set(body.roleIds).size) {
        throw new AppError('VALIDATION_ERROR', undefined, {
          details: [{ field: 'roleIds', message: 'One or more roles do not exist.' }],
        });
      }
      await guard(actor, undefined, checkRoleGrant(actor.authz, roles));

      if (makeSuperadmin) {
        const live = await countLiveSuperadmins(db);
        if (live >= c.config.auth.superadminMax) {
          throw toAppError(
            violation(
              'SUPERADMIN_LIMIT',
              `At most ${c.config.auth.superadminMax} Superadmins are allowed.`,
              { meta: { max: c.config.auth.superadminMax } },
            ),
          );
        }
      }

      const emailNormalized = normalizeEmail(body.email);
      const existing = await db.user.findUnique({
        where: { emailNormalized },
        select: { id: true },
      });
      if (existing !== null) {
        throw new AppError('DUPLICATE_RESOURCE', 'An account with this email already exists.', {
          details: [{ field: 'email', message: 'Must be unique.' }],
        });
      }
      if (body.phone !== undefined) {
        const phoneTaken = await db.user.findUnique({
          where: { phone: body.phone },
          select: { id: true },
        });
        if (phoneTaken !== null) {
          throw new AppError('DUPLICATE_RESOURCE', 'This phone number is already in use.', {
            details: [{ field: 'phone', message: 'Must be unique.' }],
          });
        }
      }

      const now = clock();
      const token = generateOpaqueToken();
      const expiresAt = addHours(now, c.config.auth.staffInviteTtlHours);
      const inviteUrl = `${c.config.adminUrl.replace(/\/+$/, '')}/accept-invite?token=${encodeURIComponent(token)}`;

      const created = await withTransaction(
        db,
        async ({ tx, ...ctx }) => {
          const superRole = makeSuperadmin ? await findRoleByCode(tx, 'SUPERADMIN') : null;
          if (makeSuperadmin && superRole === null) {
            throw new AppError('CONFLICT', 'System role SUPERADMIN is missing; run the seed.');
          }
          const user = await tx.user.create({
            data: {
              accountType: 'STAFF',
              email: body.email.trim(),
              emailNormalized,
              phone: body.phone ?? null,
              firstName: body.firstName,
              lastName: body.lastName ?? null,
              status: 'PENDING_VERIFICATION',
              isSuperadmin: makeSuperadmin,
              createdById: actor.authz.userId,
            },
            select: { id: true },
          });
          const roleIds = [...(superRole === null ? [] : [superRole.id]), ...body.roleIds];
          if (roleIds.length > 0) {
            await tx.userRole.createMany({
              data: roleIds.map((roleId) => ({
                userId: user.id,
                roleId,
                assignedById: actor.authz.userId,
                assignedAt: now,
              })),
            });
          }
          await tx.verificationToken.create({
            data: {
              userId: user.id,
              purpose: 'STAFF_INVITE',
              channel: 'EMAIL',
              target: emailNormalized,
              tokenHash: hashToken(token, c.config.auth.refresh.pepper),
              maxAttempts: 5,
              expiresAt,
              ipAddress: actor.audit.ip ?? null,
            },
          });
          await audit.record(tx, actor.audit, {
            action: 'CREATE',
            module: MODULE,
            entityType: 'User',
            entityId: user.id,
            after: {
              id: user.id,
              email: emailNormalized,
              firstName: body.firstName,
              lastName: body.lastName ?? null,
              status: 'PENDING_VERIFICATION',
              isSuperadmin: makeSuperadmin,
            },
            eventKey: 'auth.invite_sent',
            metadata: { inviteExpiresAt: expiresAt.toISOString() },
          });
          const assignedCodes = [
            ...(makeSuperadmin ? ['SUPERADMIN'] : []),
            ...roles.map((r) => r.code),
          ].sort();
          if (assignedCodes.length > 0) {
            await audit.record(tx, actor.audit, {
              action: 'ROLE_ASSIGN',
              module: MODULE,
              entityType: 'User',
              entityId: user.id,
              before: { roles: [] },
              after: { roles: assignedCodes },
              eventKey: 'admin_users.roles_assigned',
            });
          }
          ctx.afterCommit(async () => {
            await c.providers.email.send({
              to: emailNormalized,
              subject: 'You have been invited to the admin panel',
              text: `Hello ${body.firstName},\n\nYou have been invited to the store admin panel. Accept the invitation within ${c.config.auth.staffInviteTtlHours} hours:\n${inviteUrl}\n`,
              templateKey: 'STAFF_INVITED',
              variables: {
                firstName: body.firstName,
                inviteUrl,
                expiresAt: expiresAt.toISOString(),
              },
            });
          });
          return findStaff(tx, user.id);
        },
        {
          onAfterCommitError: (error) => {
            c.logger.error({ err: error }, 'staff invite email failed');
          },
        },
      );
      if (created === null) throw new AppError('INTERNAL_ERROR');
      return toStaffDto(created);
    },

    async update(actor: ActorRef, userId: string, body: UpdateUserBody): Promise<StaffDto> {
      const row = await loadTarget(userId);
      const self = actor.authz.userId === userId;
      await guard(
        actor,
        userId,
        checkSuperadminTarget(actor.authz, targetOf(row)),
        self ? undefined : await checkPower(actor, row),
      );
      if (body.phone !== undefined && body.phone !== null && body.phone !== row.phone) {
        const taken = await db.user.findUnique({
          where: { phone: body.phone },
          select: { id: true },
        });
        if (taken !== null && taken.id !== userId) {
          throw new AppError('DUPLICATE_RESOURCE', 'This phone number is already in use.', {
            details: [{ field: 'phone', message: 'Must be unique.' }],
          });
        }
      }
      const data = {
        ...(body.firstName === undefined ? {} : { firstName: body.firstName }),
        ...(body.lastName === undefined ? {} : { lastName: body.lastName }),
        ...(body.phone === undefined ? {} : { phone: body.phone }),
      };
      const updated = await withTransaction(db, async ({ tx }) => {
        await tx.user.update({
          where: { id: userId },
          data: { ...data, updatedById: actor.authz.userId },
        });
        await audit.record(tx, actor.audit, {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'User',
          entityId: userId,
          before: {
            id: userId,
            firstName: row.firstName,
            lastName: row.lastName,
            phone: row.phone,
          },
          after: {
            id: userId,
            firstName: data.firstName ?? row.firstName,
            lastName: 'lastName' in data ? data.lastName : row.lastName,
            phone: 'phone' in data ? data.phone : row.phone,
          },
          eventKey: 'admin_users.profile_updated',
        });
        return findStaff(tx, userId);
      });
      if (updated === null) throw new AppError('NOT_FOUND', 'Staff user not found.');
      return toStaffDto(updated);
    },

    /** Soft delete = DISABLED + `deleted_at`; sessions revoked; pending invites invalidated. */
    async remove(actor: ActorRef, userId: string): Promise<{ id: string; deleted: true }> {
      const row = await loadTarget(userId);
      await guard(
        actor,
        userId,
        checkNotSelf(actor.authz, userId),
        checkSuperadminTarget(actor.authz, targetOf(row)),
        await checkPower(actor, row),
      );
      const now = clock();
      await withTransaction(db, async ({ tx, ...ctx }) => {
        if (row.isSuperadmin) {
          const last = checkLastSuperadmin(row, await countActiveSuperadmins(tx));
          if (last !== undefined) throw toAppError(last);
        }
        await tx.user.update({
          where: { id: userId },
          data: {
            status: 'DISABLED',
            deletedAt: now,
            deletedById: actor.authz.userId,
            updatedById: actor.authz.userId,
          },
        });
        const sessionsRevoked = await revokeUserSessions(tx, userId, 'STATUS_CHANGED', now);
        await invalidateInvites(tx, userId, now);
        await audit.record(tx, actor.audit, {
          action: 'DELETE',
          module: MODULE,
          entityType: 'User',
          entityId: userId,
          before: { id: userId, status: row.status, deletedAt: null },
          after: { id: userId, status: 'DISABLED', deletedAt: now },
          eventKey: 'admin_users.deleted',
          metadata: { sessionsRevoked },
        });
        ctx.afterCommit(() => {
          afterAccessChange(userId);
        });
      });
      return { id: userId, deleted: true };
    },

    /** §6.1 algorithm (binding). SUPERADMIN membership is kept (it follows `is_superadmin`). */
    async setRoles(
      actor: ActorRef,
      userId: string,
      roleIds: readonly string[],
    ): Promise<StaffDto & { sessionsRevoked: number }> {
      await guard(actor, userId, checkNotSelf(actor.authz, userId));
      const row = await loadTarget(userId);
      const target = targetOf(row);
      await guard(
        actor,
        userId,
        checkSuperadminTarget(actor.authz, target),
        checkAdminTarget(actor.authz, target),
      );
      const roles = await findRolesWithKeys(db, roleIds);
      if (roles.length !== roleIds.length) {
        throw new AppError('VALIDATION_ERROR', undefined, {
          details: [{ field: 'roleIds', message: 'One or more roles do not exist.' }],
        });
      }
      await guard(actor, userId, checkRoleGrant(actor.authz, roles), await checkPower(actor, row));

      const current = row.userRoles.filter((ur) => ur.role.code !== 'SUPERADMIN');
      const { added, removed } = diffSets(
        current.map((ur) => ur.role.id),
        roleIds,
      );
      const codeOf = new Map<string, string>([
        ...row.userRoles.map((ur) => [ur.role.id, ur.role.code] as const),
        ...roles.map((r) => [r.id, r.code] as const),
      ]);
      const now = clock();
      const result = await withTransaction(db, async ({ tx, ...ctx }) => {
        if (removed.length > 0) {
          await tx.userRole.deleteMany({ where: { userId, roleId: { in: removed } } });
        }
        if (added.length > 0) {
          await tx.userRole.createMany({
            data: added.map((roleId) => ({
              userId,
              roleId,
              assignedById: actor.authz.userId,
              assignedAt: now,
            })),
            skipDuplicates: true,
          });
        }
        const changed = added.length + removed.length > 0;
        const sessionsRevoked = changed
          ? await revokeUserSessions(tx, userId, 'PERMISSION_CHANGED', now)
          : 0;
        for (const roleId of added) {
          await audit.record(tx, actor.audit, {
            action: 'ROLE_ASSIGN',
            module: MODULE,
            entityType: 'User',
            entityId: userId,
            diff: false,
            after: { roleId, roleCode: codeOf.get(roleId) ?? null },
            eventKey: 'admin_users.role_assigned',
            metadata: { sessionsRevoked },
          });
        }
        for (const roleId of removed) {
          await audit.record(tx, actor.audit, {
            action: 'ROLE_REVOKE',
            module: MODULE,
            entityType: 'User',
            entityId: userId,
            diff: false,
            before: { roleId, roleCode: codeOf.get(roleId) ?? null },
            eventKey: 'admin_users.role_revoked',
            metadata: { sessionsRevoked },
          });
        }
        if (changed) {
          ctx.afterCommit(() => {
            afterAccessChange(userId);
          });
        }
        return { user: await findStaff(tx, userId), sessionsRevoked };
      });
      if (result.user === null) throw new AppError('NOT_FOUND', 'Staff user not found.');
      return { ...toStaffDto(result.user), sessionsRevoked: result.sessionsRevoked };
    },

    /** DENY overrides only (D-42). Removing a DENY re-grants the key, so it must be ⊆ own (R1). */
    async setOverrides(
      actor: ActorRef,
      userId: string,
      body: SetOverridesBody,
    ): Promise<{
      userId: string;
      overrides: { permissionKey: string; effect: 'DENY'; reason: string | null }[];
      diff: { added: string[]; removed: string[] };
      sessionsRevoked: number;
    }> {
      await guard(actor, userId, checkNotSelf(actor.authz, userId));
      const row = await loadTarget(userId);
      const target = targetOf(row);
      await guard(
        actor,
        userId,
        checkSuperadminTarget(actor.authz, target),
        checkAdminTarget(actor.authz, target),
        await checkPower(actor, row),
      );
      const before = await findDenyOverrides(db, userId);
      const requested = body.overrides.map((o) => o.permissionKey);
      const { added, removed } = diffSets(
        before.map((o) => o.permissionKey),
        requested,
      );
      // Lifting a DENY grants that permission back: the actor must hold it (R1).
      const lifted = notHeld(actor.authz, removed);
      await guard(
        actor,
        userId,
        lifted.length === 0
          ? undefined
          : violation(
              'PRIVILEGE_ESCALATION',
              'You can only lift restrictions on permissions that you hold yourself.',
              { field: 'overrides', meta: { notHeld: lifted } },
            ),
      );

      const ids = await permissionIdsByKey(db, requested);
      const missing = requested.filter((k) => !ids.has(k));
      if (missing.length > 0) {
        throw new AppError('CONFLICT', 'Permission catalogue is not seeded.', {
          details: [{ field: 'overrides', message: 'Run the permission seed.', meta: { missing } }],
        });
      }
      const now = clock();
      const reasonOf = new Map(body.overrides.map((o) => [o.permissionKey, o.reason ?? null]));
      const sessionsRevoked = await withTransaction(db, async ({ tx, ...ctx }) => {
        if (removed.length > 0) {
          await tx.userPermissionOverride.deleteMany({
            where: { userId, permission: { code: { in: removed } } },
          });
        }
        for (const key of requested) {
          const permissionId = ids.get(key) ?? '';
          await tx.userPermissionOverride.upsert({
            where: { userId_permissionId: { userId, permissionId } },
            create: {
              userId,
              permissionId,
              effect: 'DENY',
              reason: reasonOf.get(key) ?? null,
              createdById: actor.authz.userId,
              updatedById: actor.authz.userId,
            },
            update: {
              effect: 'DENY',
              reason: reasonOf.get(key) ?? null,
              updatedById: actor.authz.userId,
            },
          });
        }
        const changed = added.length + removed.length > 0;
        const revoked = changed
          ? await revokeUserSessions(tx, userId, 'PERMISSION_CHANGED', now)
          : 0;
        await audit.record(tx, actor.audit, {
          action: 'PERMISSION_CHANGE',
          module: MODULE,
          entityType: 'User',
          entityId: userId,
          before: { deniedPermissions: before.map((o) => o.permissionKey) },
          after: { deniedPermissions: [...requested].sort() },
          eventKey: 'admin_users.overrides_updated',
          metadata: { added, removed, sessionsRevoked: revoked },
        });
        if (changed) {
          ctx.afterCommit(() => {
            afterAccessChange(userId);
          });
        }
        return revoked;
      });
      return {
        userId,
        overrides: [...requested].sort().map((permissionKey) => ({
          permissionKey,
          effect: 'DENY' as const,
          reason: reasonOf.get(permissionKey) ?? null,
        })),
        diff: { added, removed },
        sessionsRevoked,
      };
    },

    async setStatus(
      actor: ActorRef,
      userId: string,
      body: SetStatusBody,
    ): Promise<StaffDto & { sessionsRevoked: number }> {
      await guard(actor, userId, checkNotSelf(actor.authz, userId));
      const row = await loadTarget(userId);
      await guard(
        actor,
        userId,
        checkSuperadminTarget(actor.authz, targetOf(row)),
        await checkPower(actor, row),
      );
      if (row.status === body.status) {
        throw new AppError('INVALID_STATE_TRANSITION', `The account is already ${body.status}.`);
      }
      if (row.status === 'PENDING_VERIFICATION' && body.status !== 'DISABLED') {
        throw new AppError(
          'INVALID_STATE_TRANSITION',
          'An invited user becomes active by accepting the invitation.',
        );
      }
      const now = clock();
      const result = await withTransaction(db, async ({ tx, ...ctx }) => {
        if (row.isSuperadmin && body.status !== 'ACTIVE') {
          const last = checkLastSuperadmin(row, await countActiveSuperadmins(tx));
          if (last !== undefined) throw toAppError(last);
        }
        await tx.user.update({
          where: { id: userId },
          data: { status: body.status, updatedById: actor.authz.userId },
        });
        const sessionsRevoked = await revokeUserSessions(tx, userId, 'STATUS_CHANGED', now);
        if (body.status === 'DISABLED') await invalidateInvites(tx, userId, now);
        await audit.record(tx, actor.audit, {
          action: 'STATUS_CHANGE',
          module: MODULE,
          entityType: 'User',
          entityId: userId,
          before: { id: userId, status: row.status },
          after: { id: userId, status: body.status },
          reason: body.reason,
          eventKey: 'admin_users.status_changed',
          metadata: { sessionsRevoked },
        });
        ctx.afterCommit(() => {
          afterAccessChange(userId);
        });
        return { user: await findStaff(tx, userId), sessionsRevoked };
      });
      if (result.user === null) throw new AppError('NOT_FOUND', 'Staff user not found.');
      return { ...toStaffDto(result.user), sessionsRevoked: result.sessionsRevoked };
    },

    /** Force logout (R-15: re-auth). */
    async revokeSessions(
      actor: ActorRef,
      userId: string,
    ): Promise<{ userId: string; sessionsRevoked: number }> {
      const row = await loadTarget(userId);
      await guard(
        actor,
        userId,
        checkSuperadminTarget(actor.authz, targetOf(row)),
        actor.authz.userId === userId ? undefined : await checkPower(actor, row),
      );
      const now = clock();
      const sessionsRevoked = await withTransaction(db, async ({ tx, ...ctx }) => {
        const count = await revokeUserSessions(tx, userId, 'ADMIN_REVOKED', now);
        await audit.record(tx, actor.audit, {
          action: 'LOGOUT',
          module: MODULE,
          entityType: 'User',
          entityId: userId,
          diff: false,
          eventKey: 'admin_users.sessions_revoked',
          metadata: { sessionsRevoked: count },
        });
        ctx.afterCommit(() => {
          afterAccessChange(userId);
        });
        return count;
      });
      return { userId, sessionsRevoked };
    },
  };
}

export type StaffService = ReturnType<typeof createStaffService>;

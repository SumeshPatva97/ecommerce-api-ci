/**
 * Anti-privilege-escalation policy — ROLE_PERMISSION_AND_AUDIT_LOGS.md §6 (rules R1–R12, binding),
 * PROJECT_CONTEXT.md §7.2, decision log P4-DEC-02 (OQ-27 DENY only, OQ-28 Admins cannot create
 * Admins). Pure functions: no I/O, no Express.
 *
 * Violations are expressed as `PolicyViolation` values so the service can audit them
 * (`PERMISSION_DENIED`, outcome FAILURE, reason = sub-code) before throwing. Sub-codes travel in
 * `error.details[].code` (PROJECT_CONTEXT §15 R-05).
 */
import { AppError, type ErrorDetail } from '../../core/errors/AppError.js';
import type { ErrorCode } from '../../core/errors/errorCodes.js';
import { PERMISSIONS } from '../../lib/permissions.js';
import type { AuthContext } from '../rbac/permission.service.js';

export type PolicyCode =
  | 'PRIVILEGE_ESCALATION'
  | 'SELF_MODIFICATION'
  | 'SUPERADMIN_ONLY'
  | 'LAST_SUPERADMIN'
  | 'SYSTEM_ROLE'
  | 'IN_USE'
  | 'SUPERADMIN_LIMIT'
  | 'RESERVED_PERMISSION';

export interface PolicyViolation {
  /** Canonical error code (403 FORBIDDEN / PERMISSION_DENIED, 409 CONFLICT). */
  readonly error: ErrorCode;
  readonly code: PolicyCode;
  readonly message: string;
  readonly field?: string;
  readonly meta?: Record<string, unknown>;
}

export type Actor = Pick<AuthContext, 'userId' | 'isSuperadmin' | 'permissions'>;

/** Reserved permission keys (no routes; granted only through ADMIN's all-permission grant). */
export const RESERVED_KEYS: ReadonlySet<string> = new Set(
  PERMISSIONS.filter((p) => p.isReserved).map((p) => p.key),
);

export function violation(
  code: PolicyCode,
  message: string,
  extra: { error?: ErrorCode; field?: string; meta?: Record<string, unknown> } = {},
): PolicyViolation {
  const error =
    extra.error ??
    (code === 'LAST_SUPERADMIN' ||
    code === 'SYSTEM_ROLE' ||
    code === 'IN_USE' ||
    code === 'SUPERADMIN_LIMIT'
      ? 'CONFLICT'
      : 'FORBIDDEN');
  return {
    error,
    code,
    message,
    ...(extra.field === undefined ? {} : { field: extra.field }),
    ...(extra.meta === undefined ? {} : { meta: extra.meta }),
  };
}

export function toAppError(v: PolicyViolation, extra: readonly PolicyViolation[] = []): AppError {
  const details: ErrorDetail[] = [v, ...extra].map((item) => ({
    code: item.code,
    message: item.message,
    ...(item.field === undefined ? {} : { field: item.field }),
    ...(item.meta === undefined ? {} : { meta: item.meta }),
  }));
  return new AppError(v.error, v.message, { details });
}

/** Permission keys in `requested` that the actor does not effectively hold (R1). */
export function notHeld(actor: Actor, requested: Iterable<string>): string[] {
  if (actor.isSuperadmin || actor.permissions === 'ALL') return [];
  const own = new Set(actor.permissions);
  return [...new Set(requested)].filter((key) => !own.has(key)).sort();
}

/** True when every permission of `target` is also held by the actor (R9). */
export function actorCovers(actor: Actor, target: 'ALL' | readonly string[]): boolean {
  if (actor.isSuperadmin || actor.permissions === 'ALL') return true;
  if (target === 'ALL') return false;
  return notHeld(actor, target).length === 0;
}

/** R2: nobody modifies their own roles, overrides or status. */
export function checkNotSelf(actor: Actor, targetUserId: string): PolicyViolation | undefined {
  return actor.userId === targetUserId
    ? violation('SELF_MODIFICATION', 'You cannot change your own access or status.')
    : undefined;
}

export interface TargetUser {
  readonly id: string;
  readonly isSuperadmin: boolean;
  /** Active or not, the codes of roles the target holds. */
  readonly roleCodes: readonly string[];
}

/** R3: only a Superadmin acts on a Superadmin account. */
export function checkSuperadminTarget(
  actor: Actor,
  target: TargetUser,
): PolicyViolation | undefined {
  return target.isSuperadmin && !actor.isSuperadmin
    ? violation('SUPERADMIN_ONLY', 'Only a Superadmin can manage a Superadmin account.')
    : undefined;
}

/** R3 (overrides of an Admin) and ADMIN membership changes: Superadmin only. */
export function checkAdminTarget(actor: Actor, target: TargetUser): PolicyViolation | undefined {
  return target.roleCodes.includes('ADMIN') && !actor.isSuperadmin
    ? violation('SUPERADMIN_ONLY', 'Only a Superadmin can manage an Admin account’s access.')
    : undefined;
}

/** R9: a non-Superadmin cannot act on a user who holds permissions the actor lacks. */
export function checkTargetNotMorePowerful(
  actor: Actor,
  targetEffective: 'ALL' | readonly string[],
): PolicyViolation | undefined {
  return actorCovers(actor, targetEffective)
    ? undefined
    : violation(
        'PRIVILEGE_ESCALATION',
        'You cannot manage a user who holds permissions you do not have.',
      );
}

export interface RoleForAssignment {
  readonly id: string;
  readonly code: string;
  readonly permissionKeys: readonly string[];
}

/**
 * §6.1 role-assignment checks (excluding R2/R3 on the target, which the caller runs first):
 * SUPERADMIN only through `is_superadmin`; ADMIN only by a Superadmin (OQ-28); grant ⊆ own (R1).
 */
export function checkRoleGrant(
  actor: Actor,
  roles: readonly RoleForAssignment[],
): PolicyViolation | undefined {
  if (roles.some((r) => r.code === 'SUPERADMIN')) {
    return violation(
      'SUPERADMIN_ONLY',
      'The Superadmin role cannot be assigned; Superadmins are created by a Superadmin.',
      { field: 'roleIds' },
    );
  }
  if (roles.some((r) => r.code === 'ADMIN') && !actor.isSuperadmin) {
    return violation('SUPERADMIN_ONLY', 'Only a Superadmin can assign the Admin role.', {
      field: 'roleIds',
    });
  }
  const excess = notHeld(
    actor,
    roles.flatMap((r) => r.permissionKeys),
  );
  if (excess.length > 0) {
    return violation(
      'PRIVILEGE_ESCALATION',
      'You can only grant permissions that you hold yourself.',
      { field: 'roleIds', meta: { notHeld: excess } },
    );
  }
  return undefined;
}

export interface RoleForEdit {
  readonly id: string;
  readonly code: string;
  readonly isSystem: boolean;
}

/**
 * Edits of a role (rename, activate, permission mapping, delete):
 * system roles → Superadmin only (R3); the actor's own role → SELF_MODIFICATION (R8).
 */
export function checkRoleEditable(
  actor: Actor & { readonly roles: readonly string[] },
  role: RoleForEdit,
): PolicyViolation | undefined {
  if (role.isSystem && !actor.isSuperadmin) {
    return violation('SUPERADMIN_ONLY', 'Only a Superadmin can change a system role.');
  }
  if (!actor.isSuperadmin && actor.roles.includes(role.code)) {
    return violation('SELF_MODIFICATION', 'You cannot change a role that you hold yourself.');
  }
  return undefined;
}

/** R1 for role permission sets: added keys ⊆ own; reserved keys only on ADMIN. */
export function checkPermissionGrant(
  actor: Actor,
  roleCode: string,
  added: readonly string[],
): PolicyViolation | undefined {
  const excess = notHeld(actor, added);
  if (excess.length > 0) {
    return violation(
      'PRIVILEGE_ESCALATION',
      'You can only grant permissions that you hold yourself.',
      { field: 'permissionKeys', meta: { notHeld: excess } },
    );
  }
  if (roleCode !== 'ADMIN') {
    const reserved = added.filter((k) => RESERVED_KEYS.has(k));
    if (reserved.length > 0) {
      return violation('RESERVED_PERMISSION', 'Reserved permissions cannot be granted.', {
        error: 'VALIDATION_ERROR',
        field: 'permissionKeys',
        meta: { reserved },
      });
    }
  }
  return undefined;
}

/** R5: the last active Superadmin cannot be disabled, suspended, deleted or demoted. */
export function checkLastSuperadmin(
  target: Pick<TargetUser, 'isSuperadmin'> & { readonly status: string },
  activeSuperadmins: number,
): PolicyViolation | undefined {
  if (target.isSuperadmin && target.status === 'ACTIVE' && activeSuperadmins <= 1) {
    return violation('LAST_SUPERADMIN', 'The last active Superadmin cannot be removed.');
  }
  return undefined;
}

/** Set difference helpers (sorted for stable audit rows). */
export function diffSets(
  before: Iterable<string>,
  after: Iterable<string>,
): { added: string[]; removed: string[] } {
  const b = new Set(before);
  const a = new Set(after);
  return {
    added: [...a].filter((x) => !b.has(x)).sort(),
    removed: [...b].filter((x) => !a.has(x)).sort(),
  };
}

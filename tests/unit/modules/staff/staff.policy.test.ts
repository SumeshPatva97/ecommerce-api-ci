/**
 * Anti-escalation policy (ROLE_PERMISSION_AND_AUDIT_LOGS §6) — pure unit tests, no DB.
 */
import { describe, expect, it } from 'vitest';

import { PERMISSIONS, templatePermissions } from '../../../../src/lib/permissions.js';
import {
  actorCovers,
  checkAdminTarget,
  checkLastSuperadmin,
  checkNotSelf,
  checkPermissionGrant,
  checkRoleEditable,
  checkRoleGrant,
  checkSuperadminTarget,
  checkTargetNotMorePowerful,
  diffSets,
  notHeld,
  toAppError,
  violation,
} from '../../../../src/modules/staff/staff.policy.js';

const ALL = PERMISSIONS.map((p) => p.key);
const manager = {
  userId: 'm1',
  isSuperadmin: false,
  permissions: templatePermissions('MANAGER'),
  roles: ['MANAGER'],
};
const superadmin = { userId: 's1', isSuperadmin: true, permissions: 'ALL' as const, roles: [] };
const admin = { userId: 'a1', isSuperadmin: false, permissions: ALL, roles: ['ADMIN'] };

describe('staff.policy', () => {
  it('notHeld / actorCovers implement grant ⊆ own (R1) and the R9 subset check', () => {
    expect(notHeld(manager, ['orders.view', 'refunds.approve', 'refunds.approve'])).toEqual([
      'refunds.approve',
    ]);
    expect(notHeld(superadmin, ['anything'])).toEqual([]);
    expect(actorCovers(manager, ['orders.view'])).toBe(true);
    expect(actorCovers(manager, 'ALL')).toBe(false);
    expect(actorCovers(superadmin, 'ALL')).toBe(true);
    expect(checkTargetNotMorePowerful(manager, ['tax.update'])?.code).toBe('PRIVILEGE_ESCALATION');
  });

  it('R2 self-modification and R3 Superadmin/Admin targets', () => {
    expect(checkNotSelf(manager, 'm1')?.code).toBe('SELF_MODIFICATION');
    expect(checkNotSelf(manager, 'x')).toBeUndefined();
    const saTarget = { id: 't', isSuperadmin: true, roleCodes: ['SUPERADMIN'] };
    const adminTarget = { id: 't', isSuperadmin: false, roleCodes: ['ADMIN'] };
    expect(checkSuperadminTarget(admin, saTarget)?.code).toBe('SUPERADMIN_ONLY');
    expect(checkSuperadminTarget(superadmin, saTarget)).toBeUndefined();
    expect(checkAdminTarget(admin, adminTarget)?.code).toBe('SUPERADMIN_ONLY');
    expect(checkAdminTarget(superadmin, adminTarget)).toBeUndefined();
  });

  it('role assignment: SUPERADMIN never, ADMIN Superadmin-only, excess keys rejected', () => {
    const role = (code: string, keys: string[]) => ({ id: code, code, permissionKeys: keys });
    expect(checkRoleGrant(superadmin, [role('SUPERADMIN', [])])?.code).toBe('SUPERADMIN_ONLY');
    expect(checkRoleGrant(admin, [role('ADMIN', ALL)])?.code).toBe('SUPERADMIN_ONLY');
    expect(checkRoleGrant(superadmin, [role('ADMIN', ALL)])).toBeUndefined();
    const excess = checkRoleGrant(manager, [role('X', ['orders.view', 'settings.update'])]);
    expect(excess).toMatchObject({
      error: 'FORBIDDEN',
      code: 'PRIVILEGE_ESCALATION',
      meta: { notHeld: ['settings.update'] },
    });
  });

  it('role edits: system roles Superadmin-only (R3), own role blocked (R8)', () => {
    const sys = { id: 'r', code: 'ADMIN', isSystem: true };
    const own = { id: 'r', code: 'MANAGER', isSystem: false };
    expect(checkRoleEditable(admin, sys)?.code).toBe('SUPERADMIN_ONLY');
    expect(checkRoleEditable(manager, own)?.code).toBe('SELF_MODIFICATION');
    expect(checkRoleEditable(superadmin, sys)).toBeUndefined();
  });

  it('permission grants: reserved keys only on ADMIN', () => {
    expect(checkPermissionGrant(superadmin, 'STAFF', ['orders.delete'])).toMatchObject({
      error: 'VALIDATION_ERROR',
      code: 'RESERVED_PERMISSION',
    });
    expect(checkPermissionGrant(superadmin, 'ADMIN', ['orders.delete'])).toBeUndefined();
  });

  it('R5 last active Superadmin and error mapping', () => {
    const v = checkLastSuperadmin({ isSuperadmin: true, status: 'ACTIVE' }, 1);
    expect(v?.code).toBe('LAST_SUPERADMIN');
    expect(checkLastSuperadmin({ isSuperadmin: true, status: 'ACTIVE' }, 2)).toBeUndefined();
    expect(checkLastSuperadmin({ isSuperadmin: true, status: 'SUSPENDED' }, 1)).toBeUndefined();
    const err = toAppError(v ?? violation('IN_USE', 'x'));
    expect(err.httpStatus).toBe(409);
    expect(err.code).toBe('CONFLICT');
    expect(err.details?.[0]?.code).toBe('LAST_SUPERADMIN');
    expect(toAppError(violation('SELF_MODIFICATION', 'x')).httpStatus).toBe(403);
  });

  it('diffSets returns sorted additions and removals', () => {
    expect(diffSets(['b', 'a', 'c'], ['c', 'd', 'a'])).toEqual({ added: ['d'], removed: ['b'] });
  });
});

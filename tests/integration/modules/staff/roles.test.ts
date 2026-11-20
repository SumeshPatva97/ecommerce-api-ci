/**
 * Roles, role-permission mapping and the permission catalogue — MOCKED DB (no MySQL).
 * Covers ROLE_PERMISSION_AND_AUDIT_LOGS §6.2 X3, X6, X10, X11, X12 and §4 rules (system roles
 * cannot be renamed/deleted, assigned roles cannot be deleted).
 */
import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { PERMISSIONS } from '../../../../src/lib/permissions.js';
import { ALL_KEYS, MANAGER_KEYS, auditRows, roleDetail, staffApp } from './fixtures.js';

describe('GET /admin/permissions', () => {
  it('returns the 88-key catalogue grouped by module with critical/reserved flags', async () => {
    const t = staffApp();
    const viewer = t.staff({ permissions: ['roles.view'] });
    const res = await request(t.app).get('/api/v1/admin/permissions').set(viewer.headers);
    expect(res.status).toBe(200);
    const groups = res.body.data as {
      module: string;
      label: string;
      actions: { key: string; isCritical: boolean; isReserved: boolean }[];
    }[];
    expect(groups).toHaveLength(25);
    expect(groups.flatMap((g) => g.actions)).toHaveLength(PERMISSIONS.length);
    expect(PERMISSIONS).toHaveLength(88);
    const adminUsers = groups.find((g) => g.module === 'admin_users');
    expect(adminUsers?.label).toBe('Admin Users');
    expect(adminUsers?.actions.find((a) => a.key === 'admin_users.create')?.isCritical).toBe(true);
    const orders = groups.find((g) => g.module === 'orders');
    expect(orders?.actions.find((a) => a.key === 'orders.delete')?.isReserved).toBe(true);
  });
});

describe('roles CRUD', () => {
  it('lists roles with pagination meta and permission counts', async () => {
    const t = staffApp();
    const viewer = t.staff({ permissions: ['roles.view'] });
    t.m.role.count.mockResolvedValue(5);
    t.m.role.findMany.mockResolvedValue([
      roleDetail({ code: 'ADMIN', isSystem: true, keys: ALL_KEYS, userCount: 1 }),
    ]);
    const res = await request(t.app).get('/api/v1/admin/roles?limit=2').set(viewer.headers);
    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ page: 1, limit: 2, totalItems: 5, totalPages: 3 });
    expect(res.body.data[0]).toMatchObject({ code: 'ADMIN', permissionCount: 88, userCount: 1 });
    expect(res.body.data[0]).not.toHaveProperty('permissionKeys');
  });

  it('creates a custom role within the actor’s own permissions (audited CREATE)', async () => {
    const t = staffApp();
    const sa = t.staff({ isSuperadmin: true, reauthenticated: true });
    const roleId = randomUUID();
    t.m.role.findUnique
      .mockResolvedValueOnce(null) // code
      .mockResolvedValueOnce(null) // name
      .mockResolvedValueOnce(roleDetail({ id: roleId, code: 'PACKER', keys: ['orders.view'] }));
    t.m.permission.findMany.mockResolvedValue([{ id: randomUUID(), code: 'orders.view' }]);
    t.m.role.create.mockResolvedValue({ id: roleId });
    const res = await request(t.app)
      .post('/api/v1/admin/roles')
      .set(sa.headers)
      .send({ code: 'PACKER', name: 'Packer', permissionKeys: ['orders.view'] });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      id: roleId,
      code: 'PACKER',
      permissionKeys: ['orders.view'],
    });
    expect(t.m.role.create.mock.calls[0]?.[0].data).toMatchObject({
      nameNormalized: 'packer',
      isSystem: false,
    });
    expect(auditRows(t)[0]).toMatchObject({ action: 'CREATE', module: 'roles', entityId: roleId });
  });

  it('X3: an Admin with DENY tax.update cannot create a role containing tax.update', async () => {
    const t = staffApp();
    const admin = t.staff({
      permissions: ALL_KEYS.filter((k) => k !== 'tax.update'),
      roles: ['ADMIN'],
      reauthenticated: true,
    });
    const res = await request(t.app)
      .post('/api/v1/admin/roles')
      .set(admin.headers)
      .send({ code: 'TAX_CLERK', name: 'Tax clerk', permissionKeys: ['tax.view', 'tax.update'] });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.details[0]).toMatchObject({
      code: 'PRIVILEGE_ESCALATION',
      meta: { notHeld: ['tax.update'] },
    });
    expect(auditRows(t)[0]).toMatchObject({
      action: 'PERMISSION_DENIED',
      outcome: 'FAILURE',
      reason: 'PRIVILEGE_ESCALATION',
      module: 'roles',
    });
    expect(t.m.role.create).not.toHaveBeenCalled();
  });

  it('rejects reserved keys on custom roles, system codes and bad codes', async () => {
    const t = staffApp();
    const sa = t.staff({ isSuperadmin: true, reauthenticated: true });
    const reserved = await request(t.app)
      .post('/api/v1/admin/roles')
      .set(sa.headers)
      .send({ code: 'X_ROLE', name: 'X role', permissionKeys: ['orders.delete'] });
    expect(reserved.status).toBe(422);
    expect(reserved.body.error.details[0].code).toBe('RESERVED_PERMISSION');
    const system = await request(t.app)
      .post('/api/v1/admin/roles')
      .set(sa.headers)
      .send({ code: 'ADMIN', name: 'Admin two' });
    expect(system.status).toBe(409);
    const badCode = await request(t.app)
      .post('/api/v1/admin/roles')
      .set(sa.headers)
      .send({ code: 'lower', name: 'Lower' });
    expect(badCode.status).toBe(422);
  });

  it('system roles cannot be renamed or deleted (409 for a Superadmin, 403 SUPERADMIN_ONLY otherwise)', async () => {
    const t = staffApp();
    const sa = t.staff({ isSuperadmin: true, reauthenticated: true });
    const admin = t.staff({ permissions: ALL_KEYS, roles: ['ADMIN'], reauthenticated: true });
    const adminRole = roleDetail({ code: 'ADMIN', isSystem: true, keys: ALL_KEYS, userCount: 2 });
    t.m.role.findUnique.mockResolvedValue(adminRole);

    const rename = await request(t.app)
      .patch(`/api/v1/admin/roles/${adminRole.id}`)
      .set(sa.headers)
      .send({ name: 'Boss' });
    expect(rename.status).toBe(409);
    expect(rename.body.error.details[0].code).toBe('SYSTEM_ROLE');

    const del = await request(t.app).delete(`/api/v1/admin/roles/${adminRole.id}`).set(sa.headers);
    expect(del.status).toBe(409);

    const byAdmin = await request(t.app)
      .delete(`/api/v1/admin/roles/${adminRole.id}`)
      .set(admin.headers);
    expect(byAdmin.status).toBe(403);
    expect(byAdmin.body.error.details[0].code).toBe('SUPERADMIN_ONLY');
  });

  it('deleting an assigned role → 409 IN_USE; an unassigned custom role is deleted and audited', async () => {
    const t = staffApp();
    const sa = t.staff({ isSuperadmin: true, reauthenticated: true });
    const role = roleDetail({ code: 'PACKER', keys: ['orders.view'] });
    t.m.role.findUnique.mockResolvedValue(role);
    t.m.userRole.count.mockResolvedValueOnce(3);
    const inUse = await request(t.app).delete(`/api/v1/admin/roles/${role.id}`).set(sa.headers);
    expect(inUse.status).toBe(409);
    expect(inUse.body.error.details[0]).toMatchObject({ code: 'IN_USE', meta: { userCount: 3 } });

    t.m.userRole.count.mockResolvedValueOnce(0);
    const ok = await request(t.app).delete(`/api/v1/admin/roles/${role.id}`).set(sa.headers);
    expect(ok.status).toBe(200);
    expect(t.m.role.delete).toHaveBeenCalledWith({ where: { id: role.id } });
    expect(auditRows(t).at(-1)).toMatchObject({ action: 'DELETE', entityId: role.id });
  });

  it('deactivating a role revokes members’ sessions and bumps the RBAC version', async () => {
    const t = staffApp();
    const sa = t.staff({ isSuperadmin: true, reauthenticated: true });
    const role = roleDetail({ code: 'PACKER', keys: ['orders.view'] });
    const member = randomUUID();
    t.m.role.findUnique.mockResolvedValue(role);
    t.m.userRole.findMany.mockResolvedValue([{ userId: member }]);
    const res = await request(t.app)
      .patch(`/api/v1/admin/roles/${role.id}`)
      .set(sa.headers)
      .send({ isActive: false });
    expect(res.status).toBe(200);
    expect(t.m.refreshToken.updateMany.mock.calls[0]?.[0].where.userId).toBe(member);
    expect(t.permissions.bumps).toBe(1);
    expect(t.permissions.invalidated).toContain(member);
    expect(auditRows(t)[0]).toMatchObject({ action: 'STATUS_CHANGE', module: 'roles' });
  });
});

describe('PUT /admin/roles/:roleId/permissions', () => {
  it('X12-style: no recent re-auth → 403 REAUTH_REQUIRED', async () => {
    const t = staffApp();
    const sa = t.staff({ isSuperadmin: true });
    const res = await request(t.app)
      .put(`/api/v1/admin/roles/${randomUUID()}/permissions`)
      .set(sa.headers)
      .send({ permissionKeys: [] });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('REAUTH_REQUIRED');
  });

  it('X6: a Manager editing their own role → SELF_MODIFICATION (and PRIVILEGE_ESCALATION)', async () => {
    const t = staffApp();
    const manager = t.staff({
      permissions: [...MANAGER_KEYS, 'roles.update'],
      roles: ['MANAGER'],
      reauthenticated: true,
    });
    const role = roleDetail({ code: 'MANAGER', keys: MANAGER_KEYS });
    t.m.role.findUnique.mockResolvedValue(role);
    const res = await request(t.app)
      .put(`/api/v1/admin/roles/${role.id}/permissions`)
      .set(manager.headers)
      .send({ permissionKeys: [...MANAGER_KEYS, 'refunds.approve'] });
    expect(res.status).toBe(403);
    expect((res.body.error.details as { code: string }[]).map((d) => d.code)).toEqual([
      'SELF_MODIFICATION',
      'PRIVILEGE_ESCALATION',
    ]);
    expect(t.m.rolePermission.createMany).not.toHaveBeenCalled();
  });

  it('X10: an Admin cannot edit the ADMIN role’s permissions', async () => {
    const t = staffApp();
    const admin = t.staff({ permissions: ALL_KEYS, roles: ['ADMIN'], reauthenticated: true });
    const role = roleDetail({ code: 'ADMIN', isSystem: true, keys: ALL_KEYS });
    t.m.role.findUnique.mockResolvedValue(role);
    const res = await request(t.app)
      .put(`/api/v1/admin/roles/${role.id}/permissions`)
      .set(admin.headers)
      .send({ permissionKeys: ['dashboard.view'] });
    expect(res.status).toBe(403);
    expect(res.body.error.details[0].code).toBe('SUPERADMIN_ONLY');
  });

  it('API example: a Manager granting refunds.approve to STAFF → PRIVILEGE_ESCALATION notHeld', async () => {
    const t = staffApp();
    const manager = t.staff({
      permissions: [...MANAGER_KEYS, 'roles.update'],
      roles: ['MANAGER'],
      reauthenticated: true,
    });
    const role = roleDetail({ code: 'STAFF', keys: ['orders.view'] });
    t.m.role.findUnique.mockResolvedValue(role);
    const res = await request(t.app)
      .put(`/api/v1/admin/roles/${role.id}/permissions`)
      .set(manager.headers)
      .send({ permissionKeys: ['orders.view', 'products.view', 'refunds.approve'] });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({
      code: 'FORBIDDEN',
      message: 'You can only grant permissions that you hold yourself.',
      details: [
        {
          field: 'permissionKeys',
          code: 'PRIVILEGE_ESCALATION',
          meta: { notHeld: ['refunds.approve'] },
        },
      ],
    });
  });

  it('X11: Admin A edits a role held by Admin B within A’s permissions → members’ sessions revoked', async () => {
    const t = staffApp();
    const adminA = t.staff({
      permissions: ALL_KEYS.filter((k) => k !== 'tax.update'),
      roles: ['ADMIN'],
      reauthenticated: true,
    });
    const role = roleDetail({ code: 'REPORTING', keys: ['reports.view'] });
    const memberB = randomUUID();
    t.m.role.findUnique.mockResolvedValue(role);
    t.m.userRole.findMany.mockResolvedValue([{ userId: memberB }]);
    t.m.permission.findMany.mockResolvedValue([{ id: randomUUID(), code: 'reports.export' }]);
    const res = await request(t.app)
      .put(`/api/v1/admin/roles/${role.id}/permissions`)
      .set(adminA.headers)
      .send({ permissionKeys: ['reports.view', 'reports.export'], comment: 'Month-end' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      roleId: role.id,
      code: 'REPORTING',
      permissionKeys: ['reports.export', 'reports.view'],
      diff: { added: ['reports.export'], removed: [] },
      affectedUsers: 1,
      sessionsRevoked: 2,
    });
    expect(t.m.refreshToken.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { userId: memberB },
      data: { revokedReason: 'PERMISSION_CHANGED' },
    });
    expect(t.permissions.bumps).toBe(1);
    expect(t.permissions.invalidated).toContain(memberB);
    const row = auditRows(t)[0];
    expect(row).toMatchObject({
      action: 'PERMISSION_CHANGE',
      module: 'roles',
      reason: 'Month-end',
      oldValues: { permissions: ['reports.view'] },
    });
    expect((row?.newValues as { _event: { metadata: unknown } })._event.metadata).toMatchObject({
      added: ['reports.export'],
      removed: [],
      usersAffected: 1,
      sessionsRevoked: 2,
    });

    // …but not beyond A's own permissions (R1).
    const escalate = await request(t.app)
      .put(`/api/v1/admin/roles/${role.id}/permissions`)
      .set(adminA.headers)
      .send({ permissionKeys: ['reports.view', 'tax.update'] });
    expect(escalate.status).toBe(403);
    expect(escalate.body.error.details[0].meta.notHeld).toEqual(['tax.update']);
  });

  it('a Superadmin may edit the ADMIN role; the SUPERADMIN role has no rows (409)', async () => {
    const t = staffApp();
    const sa = t.staff({ isSuperadmin: true, reauthenticated: true });
    t.m.role.findUnique.mockResolvedValue(roleDetail({ code: 'SUPERADMIN', isSystem: true }));
    const res = await request(t.app)
      .put(`/api/v1/admin/roles/${randomUUID()}/permissions`)
      .set(sa.headers)
      .send({ permissionKeys: ['dashboard.view'] });
    expect(res.status).toBe(409);
    expect(res.body.error.details[0].code).toBe('SYSTEM_ROLE');
  });

  it('unknown or duplicate keys → 422', async () => {
    const t = staffApp();
    const sa = t.staff({ isSuperadmin: true, reauthenticated: true });
    const url = `/api/v1/admin/roles/${randomUUID()}/permissions`;
    expect(
      (
        await request(t.app)
          .put(url)
          .set(sa.headers)
          .send({ permissionKeys: ['nope.view'] })
      ).status,
    ).toBe(422);
    expect(
      (
        await request(t.app)
          .put(url)
          .set(sa.headers)
          .send({ permissionKeys: ['orders.view', 'orders.view'] })
      ).status,
    ).toBe(422);
  });
});

describe('Phase 4 catalogue gaps — Superadmin bypass', () => {
  it('TC-008: a Superadmin bypasses the permission guard and the action is audited as SUPERADMIN', async () => {
    const t = staffApp();
    // No role, no permission keys: only the isSuperadmin flag lets this through.
    const sa = t.staff({ isSuperadmin: true, roles: [], reauthenticated: true });
    expect(sa.ctx.permissions).toBe('ALL');
    const roleId = randomUUID();
    t.m.role.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(roleDetail({ id: roleId, code: 'AUDITOR', keys: ['orders.view'] }));
    t.m.permission.findMany.mockResolvedValue([{ id: randomUUID(), code: 'orders.view' }]);
    t.m.role.create.mockResolvedValue({ id: roleId });
    const res = await request(t.app)
      .post('/api/v1/admin/roles')
      .set(sa.headers)
      .send({ code: 'AUDITOR', name: 'Auditor', permissionKeys: ['orders.view'] });
    expect(res.status).toBe(201);
    const rows = auditRows(t);
    expect(rows.map((r) => r.action)).not.toContain('PERMISSION_DENIED');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'CREATE',
      module: 'roles',
      entityId: roleId,
      outcome: 'SUCCESS',
      actorType: 'STAFF',
      actorUserId: sa.ctx.userId,
      actorRole: 'SUPERADMIN',
    });
  });
});

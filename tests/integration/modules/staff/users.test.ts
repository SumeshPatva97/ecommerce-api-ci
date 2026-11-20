/**
 * Staff users API through the real Express pipeline — MOCKED DB (Prisma stand-in, no MySQL).
 * Covers ROLE_PERMISSION_AND_AUDIT_LOGS §6.2 examples X1, X2, X4, X5, X7, X8, X9, X12 and R1, R5,
 * R6, R9, R11; the invite flow (AUTH §14); pagination meta; audit rows.
 */
import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { hashToken } from '../../../../src/core/security/tokens.js';
import { createStaffModule } from '../../../../src/modules/staff/index.js';
import { expectAdminRoutesGuarded } from '../../../helpers/routeTable.js';
import {
  ALL_KEYS,
  MANAGER_KEYS,
  NOW,
  auditRows,
  roleWithKeys,
  staffApp,
  staffRow,
} from './fixtures.js';

const ADMIN_PERMS = ALL_KEYS;

describe('staff users — route table', () => {
  it('guards every admin route and pairs critical keys with re-auth', () => {
    const t = staffApp();
    const routes = expectAdminRoutesGuarded(createStaffModule(t.container));
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /users',
      'POST /users',
      'GET /users/:userId',
      'PATCH /users/:userId',
      'DELETE /users/:userId',
      'PUT /users/:userId/roles',
      'PUT /users/:userId/permission-overrides',
      'PATCH /users/:userId/status',
      'DELETE /users/:userId/sessions',
      'GET /roles',
      'POST /roles',
      'GET /roles/:roleId',
      'PATCH /roles/:roleId',
      'DELETE /roles/:roleId',
      'PUT /roles/:roleId/permissions',
      'GET /permissions',
    ]);
    const find = (m: string, p: string) => routes.find((r) => r.method === m && r.path === p);
    expect(find('POST', '/users')?.permissions).toEqual(['admin_users.create']);
    expect(find('PUT', '/users/:userId/roles')?.reauth).toBe(true);
    expect(find('DELETE', '/users/:userId/sessions')?.reauth).toBe(true);
    expect(find('GET', '/permissions')?.permissions).toEqual(['roles.view']);
  });
});

describe('GET /admin/users', () => {
  it('lists staff with pagination meta (default 25)', async () => {
    const t = staffApp();
    const actor = t.staff({ permissions: ['admin_users.view'] });
    t.m.user.count.mockResolvedValue(30);
    t.m.user.findMany.mockResolvedValue([staffRow({ roles: [{ code: 'MANAGER' }] })]);
    const res = await request(t.app).get('/api/v1/admin/users?status=ACTIVE').set(actor.headers);
    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({
      page: 1,
      limit: 25,
      totalItems: 30,
      totalPages: 2,
      hasNextPage: true,
      hasPrevPage: false,
    });
    expect(res.body.data[0].roles[0].code).toBe('MANAGER');
    expect(res.body.data[0]).not.toHaveProperty('passwordHash');
    const args = t.m.user.findMany.mock.calls[0]?.[0];
    expect(args.where).toMatchObject({ accountType: 'STAFF', deletedAt: null, status: 'ACTIVE' });
    expect(args.take).toBe(25);
  });

  it('rejects limit > 100 with 422 and a missing permission with 403 (X1-style)', async () => {
    const t = staffApp();
    const viewer = t.staff({ permissions: ['admin_users.view'] });
    expect(
      (await request(t.app).get('/api/v1/admin/users?limit=101').set(viewer.headers)).status,
    ).toBe(422);
    const other = t.staff({ permissions: ['orders.view'] });
    const res = await request(t.app).get('/api/v1/admin/users').set(other.headers);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PERMISSION_DENIED');
  });

  it('returns 404 for an unknown or non-staff user', async () => {
    const t = staffApp();
    const viewer = t.staff({ permissions: ['admin_users.view'] });
    t.m.user.findFirst.mockResolvedValue(null);
    const res = await request(t.app).get(`/api/v1/admin/users/${randomUUID()}`).set(viewer.headers);
    expect(res.status).toBe(404);
  });

  it('returns detail with effective permissions and DENY overrides', async () => {
    const t = staffApp();
    const viewer = t.staff({ permissions: ['admin_users.view'] });
    const target = staffRow({ roles: [{ code: 'STAFF' }] });
    t.m.user.findFirst.mockResolvedValue(target);
    t.m.userPermissionOverride.findMany.mockResolvedValue([
      { reason: 'audit', createdAt: NOW, permission: { code: 'orders.update' } },
    ]);
    const res = await request(t.app).get(`/api/v1/admin/users/${target.id}`).set(viewer.headers);
    expect(res.status).toBe(200);
    expect(res.body.data.deniedOverrides).toEqual([
      { permissionKey: 'orders.update', reason: 'audit', createdAt: NOW.toISOString() },
    ]);
    expect(res.body.data.permissions).toEqual([]);
  });
});

describe('POST /admin/users (invite)', () => {
  const body = (roleIds: string[], extra: Record<string, unknown> = {}) => ({
    email: '  New.Staff@Example.com ',
    firstName: 'Neha',
    roleIds,
    ...extra,
  });

  it('creates a PENDING staff user, a 72 h STAFF_INVITE token, audit rows and an invite email', async () => {
    const t = staffApp();
    const actor = t.staff({
      permissions: ['admin_users.create', ...MANAGER_KEYS],
      reauthenticated: true,
    });
    const roleId = randomUUID();
    const newId = randomUUID();
    t.m.role.findMany.mockResolvedValue([roleWithKeys('STAFF', ['orders.view'], roleId)]);
    t.m.user.findUnique.mockResolvedValue(null);
    t.m.user.create.mockResolvedValue({ id: newId });
    t.m.user.findFirst.mockResolvedValue(
      staffRow({
        id: newId,
        status: 'PENDING_VERIFICATION',
        roles: [{ id: roleId, code: 'STAFF' }],
      }),
    );

    const res = await request(t.app)
      .post('/api/v1/admin/users')
      .set(actor.headers)
      .send(body([roleId]));
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ id: newId, status: 'PENDING_VERIFICATION' });

    const created = t.m.user.create.mock.calls[0]?.[0].data;
    expect(created).toMatchObject({
      accountType: 'STAFF',
      emailNormalized: 'new.staff@example.com',
      status: 'PENDING_VERIFICATION',
      isSuperadmin: false,
      createdById: actor.ctx.userId,
    });
    expect(created).not.toHaveProperty('passwordHash');

    const mail = t.email.outbox[0];
    expect(mail?.to).toBe('new.staff@example.com');
    const match = /http:\/\/localhost:5174\/accept-invite\?token=([A-Za-z0-9_-]+)/.exec(
      mail?.text ?? '',
    );
    expect(match).not.toBeNull();
    const tokenData = t.m.verificationToken.create.mock.calls[0]?.[0].data;
    expect(tokenData).toMatchObject({ purpose: 'STAFF_INVITE', channel: 'EMAIL', userId: newId });
    expect(tokenData.tokenHash).toBe(hashToken(match?.[1] ?? '', 'test-pepper-for-invite-hash'));
    expect(tokenData.expiresAt).toEqual(new Date(NOW.getTime() + 72 * 3600 * 1000));

    const rows = auditRows(t);
    expect(rows.map((r) => r.action)).toEqual(['CREATE', 'ROLE_ASSIGN']);
    expect(JSON.stringify(rows)).not.toContain(match?.[1] ?? 'x');
  });

  it('requires re-auth (critical key admin_users.create)', async () => {
    const t = staffApp();
    const actor = t.staff({ permissions: ['admin_users.create'] });
    const res = await request(t.app).post('/api/v1/admin/users').set(actor.headers).send(body([]));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('REAUTH_REQUIRED');
  });

  it('X9: an Employee posting isSuperadmin is denied by the permission guard', async () => {
    const t = staffApp();
    const employee = t.staff({ permissions: ['products.view'], roles: ['EMPLOYEE'] });
    const res = await request(t.app)
      .post('/api/v1/admin/users')
      .set(employee.headers)
      .send(body([], { isSuperadmin: true }));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PERMISSION_DENIED');
  });

  it('R11: isSuperadmin from a non-Superadmin creator → 403 PERMISSION_DENIED, audited', async () => {
    const t = staffApp();
    const admin = t.staff({ permissions: ADMIN_PERMS, roles: ['ADMIN'], reauthenticated: true });
    const res = await request(t.app)
      .post('/api/v1/admin/users')
      .set(admin.headers)
      .send(body([randomUUID()], { isSuperadmin: true }));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PERMISSION_DENIED');
    expect(res.body.error.details[0]).toMatchObject({
      code: 'SUPERADMIN_ONLY',
      field: 'isSuperadmin',
    });
    expect(auditRows(t)[0]).toMatchObject({
      action: 'PERMISSION_DENIED',
      outcome: 'FAILURE',
      reason: 'SUPERADMIN_ONLY',
    });
    expect(t.m.user.create).not.toHaveBeenCalled();
  });

  it('rejects unknown body keys (strict schema)', async () => {
    const t = staffApp();
    const sa = t.staff({ isSuperadmin: true, reauthenticated: true });
    const res = await request(t.app)
      .post('/api/v1/admin/users')
      .set(sa.headers)
      .send(body([randomUUID()], { accountType: 'STAFF' }));
    expect(res.status).toBe(422);
  });

  it('X2: an Admin cannot assign the ADMIN role (OQ-28)', async () => {
    const t = staffApp();
    const admin = t.staff({ permissions: ADMIN_PERMS, roles: ['ADMIN'], reauthenticated: true });
    const adminRoleId = randomUUID();
    t.m.role.findMany.mockResolvedValue([roleWithKeys('ADMIN', ALL_KEYS, adminRoleId)]);
    const res = await request(t.app)
      .post('/api/v1/admin/users')
      .set(admin.headers)
      .send(body([adminRoleId]));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.details[0].code).toBe('SUPERADMIN_ONLY');
  });

  it('R1: roles granting keys the actor lacks → PRIVILEGE_ESCALATION with notHeld', async () => {
    const t = staffApp();
    const manager = t.staff({
      permissions: ['admin_users.create', ...MANAGER_KEYS],
      roles: ['MANAGER'],
      reauthenticated: true,
    });
    const roleId = randomUUID();
    t.m.role.findMany.mockResolvedValue([
      roleWithKeys('CUSTOM', ['orders.view', 'refunds.approve'], roleId),
    ]);
    const res = await request(t.app)
      .post('/api/v1/admin/users')
      .set(manager.headers)
      .send(body([roleId]));
    expect(res.status).toBe(403);
    expect(res.body.error.details[0]).toMatchObject({
      code: 'PRIVILEGE_ESCALATION',
      meta: { notHeld: ['refunds.approve'] },
    });
  });

  it('lets a Superadmin create a Superadmin below SUPERADMIN_MAX and refuses at the limit', async () => {
    const t = staffApp();
    const sa = t.staff({ isSuperadmin: true, reauthenticated: true });
    const newId = randomUUID();
    t.m.user.count.mockResolvedValueOnce(1);
    t.m.user.findUnique.mockResolvedValue(null);
    t.m.role.findUnique.mockResolvedValue({ id: randomUUID() });
    t.m.user.create.mockResolvedValue({ id: newId });
    t.m.user.findFirst.mockResolvedValue(staffRow({ id: newId, isSuperadmin: true }));
    const ok = await request(t.app)
      .post('/api/v1/admin/users')
      .set(sa.headers)
      .send(body([], { isSuperadmin: true }));
    expect(ok.status).toBe(201);
    expect(t.m.user.create.mock.calls[0]?.[0].data.isSuperadmin).toBe(true);

    t.m.user.count.mockResolvedValueOnce(2);
    const limit = await request(t.app)
      .post('/api/v1/admin/users')
      .set(sa.headers)
      .send(body([], { isSuperadmin: true }));
    expect(limit.status).toBe(409);
    expect(limit.body.error.details[0].code).toBe('SUPERADMIN_LIMIT');
  });

  it('returns 409 DUPLICATE_RESOURCE for an existing email', async () => {
    const t = staffApp();
    const sa = t.staff({ isSuperadmin: true, reauthenticated: true });
    const roleId = randomUUID();
    t.m.role.findMany.mockResolvedValue([roleWithKeys('STAFF', [], roleId)]);
    t.m.user.findUnique.mockResolvedValue({ id: randomUUID() });
    const res = await request(t.app)
      .post('/api/v1/admin/users')
      .set(sa.headers)
      .send(body([roleId]));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_RESOURCE');
  });
});

describe('PUT /admin/users/:userId/roles', () => {
  it('X1: a Manager without admin_users.update → 403 PERMISSION_DENIED (middleware)', async () => {
    const t = staffApp();
    const manager = t.staff({ permissions: MANAGER_KEYS, reauthenticated: true });
    const res = await request(t.app)
      .put(`/api/v1/admin/users/${randomUUID()}/roles`)
      .set(manager.headers)
      .send({ roleIds: [] });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PERMISSION_DENIED');
  });

  it('R2: changing your own roles → SELF_MODIFICATION', async () => {
    const t = staffApp();
    const admin = t.staff({ permissions: ADMIN_PERMS, reauthenticated: true });
    const res = await request(t.app)
      .put(`/api/v1/admin/users/${admin.ctx.userId}/roles`)
      .set(admin.headers)
      .send({ roleIds: [] });
    expect(res.status).toBe(403);
    expect(res.body.error.details[0].code).toBe('SELF_MODIFICATION');
    expect(auditRows(t)[0]).toMatchObject({ action: 'PERMISSION_DENIED', outcome: 'FAILURE' });
  });

  it('R3: a non-Superadmin cannot change a Superadmin’s roles', async () => {
    const t = staffApp();
    const admin = t.staff({ permissions: ADMIN_PERMS, reauthenticated: true });
    const target = staffRow({ isSuperadmin: true, roles: [{ code: 'SUPERADMIN' }] });
    t.m.user.findFirst.mockResolvedValue(target);
    const res = await request(t.app)
      .put(`/api/v1/admin/users/${target.id}/roles`)
      .set(admin.headers)
      .send({ roleIds: [] });
    expect(res.status).toBe(403);
    expect(res.body.error.details[0].code).toBe('SUPERADMIN_ONLY');
  });

  it('X2: an Admin cannot assign ADMIN to an Employee', async () => {
    const t = staffApp();
    const admin = t.staff({ permissions: ADMIN_PERMS, roles: ['ADMIN'], reauthenticated: true });
    const target = staffRow({ roles: [{ code: 'EMPLOYEE' }] });
    const adminRoleId = randomUUID();
    t.m.user.findFirst.mockResolvedValue(target);
    t.m.role.findMany.mockResolvedValue([roleWithKeys('ADMIN', ALL_KEYS, adminRoleId)]);
    const res = await request(t.app)
      .put(`/api/v1/admin/users/${target.id}/roles`)
      .set(admin.headers)
      .send({ roleIds: [adminRoleId] });
    expect(res.status).toBe(403);
    expect(res.body.error.details[0].code).toBe('SUPERADMIN_ONLY');
  });

  it('R9: cannot manage a user who holds permissions the actor lacks', async () => {
    const t = staffApp();
    const manager = t.staff({
      permissions: ['admin_users.update', ...MANAGER_KEYS],
      reauthenticated: true,
    });
    const target = staffRow({ roles: [{ code: 'CUSTOM' }] });
    t.staff({ userId: target.id, permissions: ['refunds.approve'] }); // target's effective set
    t.m.user.findFirst.mockResolvedValue(target);
    t.m.role.findMany.mockResolvedValue([]);
    const res = await request(t.app)
      .put(`/api/v1/admin/users/${target.id}/roles`)
      .set(manager.headers)
      .send({ roleIds: [] });
    expect(res.status).toBe(403);
    expect(res.body.error.details[0].code).toBe('PRIVILEGE_ESCALATION');
  });

  it('replaces roles, revokes the target’s sessions (R6), audits ROLE_ASSIGN/ROLE_REVOKE and busts the cache', async () => {
    const t = staffApp();
    const sa = t.staff({ isSuperadmin: true, reauthenticated: true });
    const oldRole = randomUUID();
    const newRole = randomUUID();
    const target = staffRow({ roles: [{ id: oldRole, code: 'STAFF' }] });
    t.m.user.findFirst.mockResolvedValue(target);
    t.m.role.findMany.mockResolvedValue([roleWithKeys('EMPLOYEE', ['orders.view'], newRole)]);
    const res = await request(t.app)
      .put(`/api/v1/admin/users/${target.id}/roles`)
      .set(sa.headers)
      .send({ roleIds: [newRole] });
    expect(res.status).toBe(200);
    expect(res.body.data.sessionsRevoked).toBe(2);
    expect(t.m.userRole.deleteMany).toHaveBeenCalledWith({
      where: { userId: target.id, roleId: { in: [oldRole] } },
    });
    expect(t.m.userRole.createMany.mock.calls[0]?.[0].data[0]).toMatchObject({
      userId: target.id,
      roleId: newRole,
      assignedById: sa.ctx.userId,
    });
    expect(t.m.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: target.id, revokedAt: null },
      data: { revokedAt: NOW, revokedReason: 'PERMISSION_CHANGED' },
    });
    expect(auditRows(t).map((r) => r.action)).toEqual(['ROLE_ASSIGN', 'ROLE_REVOKE']);
    expect(t.permissions.invalidated).toContain(target.id);
  });
});

describe('PUT /admin/users/:userId/permission-overrides', () => {
  it('X4: removing your own DENY → SELF_MODIFICATION', async () => {
    const t = staffApp();
    const admin = t.staff({ permissions: ADMIN_PERMS, roles: ['ADMIN'], reauthenticated: true });
    const res = await request(t.app)
      .put(`/api/v1/admin/users/${admin.ctx.userId}/permission-overrides`)
      .set(admin.headers)
      .send({ overrides: [] });
    expect(res.status).toBe(403);
    expect(res.body.error.details[0].code).toBe('SELF_MODIFICATION');
  });

  it('X5: Admin A cannot edit overrides of Admin B', async () => {
    const t = staffApp();
    const adminA = t.staff({ permissions: ADMIN_PERMS, roles: ['ADMIN'], reauthenticated: true });
    const adminB = staffRow({ roles: [{ code: 'ADMIN' }] });
    t.m.user.findFirst.mockResolvedValue(adminB);
    const res = await request(t.app)
      .put(`/api/v1/admin/users/${adminB.id}/permission-overrides`)
      .set(adminA.headers)
      .send({ overrides: [{ permissionKey: 'tax.update', effect: 'DENY' }] });
    expect(res.status).toBe(403);
    expect(res.body.error.details[0].code).toBe('SUPERADMIN_ONLY');
  });

  it('accepts DENY only (ALLOW → 422) and rejects unknown keys', async () => {
    const t = staffApp();
    const sa = t.staff({ isSuperadmin: true, reauthenticated: true });
    const url = `/api/v1/admin/users/${randomUUID()}/permission-overrides`;
    const allow = await request(t.app)
      .put(url)
      .set(sa.headers)
      .send({ overrides: [{ permissionKey: 'tax.update', effect: 'ALLOW' }] });
    expect(allow.status).toBe(422);
    const unknown = await request(t.app)
      .put(url)
      .set(sa.headers)
      .send({ overrides: [{ permissionKey: 'tax.fly', effect: 'DENY' }] });
    expect(unknown.status).toBe(422);
  });

  it('a Superadmin restricts an Admin: overrides upserted, sessions revoked, PERMISSION_CHANGE audited', async () => {
    const t = staffApp();
    const sa = t.staff({ isSuperadmin: true, reauthenticated: true });
    const admin = staffRow({ roles: [{ code: 'ADMIN' }] });
    const permId = randomUUID();
    t.m.user.findFirst.mockResolvedValue(admin);
    t.m.permission.findMany.mockResolvedValue([{ id: permId, code: 'tax.update' }]);
    const res = await request(t.app)
      .put(`/api/v1/admin/users/${admin.id}/permission-overrides`)
      .set(sa.headers)
      .send({ overrides: [{ permissionKey: 'tax.update', effect: 'DENY', reason: 'CA only' }] });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      diff: { added: ['tax.update'], removed: [] },
      sessionsRevoked: 2,
    });
    expect(t.m.userPermissionOverride.upsert.mock.calls[0]?.[0].create).toMatchObject({
      userId: admin.id,
      permissionId: permId,
      effect: 'DENY',
      reason: 'CA only',
    });
    const row = auditRows(t)[0];
    expect(row).toMatchObject({ action: 'PERMISSION_CHANGE', module: 'admin_users' });
    expect(t.permissions.invalidated).toContain(admin.id);
  });

  it('R1: lifting a DENY on a key the actor lacks → PRIVILEGE_ESCALATION', async () => {
    const t = staffApp();
    const manager = t.staff({
      permissions: ['admin_users.update', ...MANAGER_KEYS],
      reauthenticated: true,
    });
    const target = staffRow({ roles: [{ code: 'STAFF' }] });
    t.m.user.findFirst.mockResolvedValue(target);
    t.m.userPermissionOverride.findMany.mockResolvedValue([
      { reason: null, createdAt: NOW, permission: { code: 'refunds.approve' } },
    ]);
    const res = await request(t.app)
      .put(`/api/v1/admin/users/${target.id}/permission-overrides`)
      .set(manager.headers)
      .send({ overrides: [] });
    expect(res.status).toBe(403);
    expect(res.body.error.details[0]).toMatchObject({
      code: 'PRIVILEGE_ESCALATION',
      meta: { notHeld: ['refunds.approve'] },
    });
  });
});

describe('PATCH /admin/users/:userId/status', () => {
  it('X7: an Admin cannot disable a Superadmin', async () => {
    const t = staffApp();
    const admin = t.staff({ permissions: ADMIN_PERMS, roles: ['ADMIN'], reauthenticated: true });
    const target = staffRow({ isSuperadmin: true });
    t.m.user.findFirst.mockResolvedValue(target);
    const res = await request(t.app)
      .patch(`/api/v1/admin/users/${target.id}/status`)
      .set(admin.headers)
      .send({ status: 'DISABLED', reason: 'off-boarding' });
    expect(res.status).toBe(403);
    expect(res.body.error.details[0].code).toBe('SUPERADMIN_ONLY');
  });

  it('X8: a Superadmin cannot disable themself', async () => {
    const t = staffApp();
    const sa = t.staff({ isSuperadmin: true, reauthenticated: true });
    const res = await request(t.app)
      .patch(`/api/v1/admin/users/${sa.ctx.userId}/status`)
      .set(sa.headers)
      .send({ status: 'DISABLED', reason: 'leaving' });
    expect(res.status).toBe(403);
    expect(res.body.error.details[0].code).toBe('SELF_MODIFICATION');
  });

  it('R5: suspending the last active Superadmin → 409 LAST_SUPERADMIN', async () => {
    const t = staffApp();
    const sa = t.staff({ isSuperadmin: true, reauthenticated: true });
    const other = staffRow({ isSuperadmin: true });
    t.m.user.findFirst.mockResolvedValue(other);
    t.m.user.count.mockResolvedValue(1);
    const res = await request(t.app)
      .patch(`/api/v1/admin/users/${other.id}/status`)
      .set(sa.headers)
      .send({ status: 'SUSPENDED', reason: 'investigation' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(res.body.error.details[0].code).toBe('LAST_SUPERADMIN');
    expect(t.m.user.update).not.toHaveBeenCalled();
  });

  it('requires a reason', async () => {
    const t = staffApp();
    const sa = t.staff({ isSuperadmin: true, reauthenticated: true });
    const res = await request(t.app)
      .patch(`/api/v1/admin/users/${randomUUID()}/status`)
      .set(sa.headers)
      .send({ status: 'SUSPENDED' });
    expect(res.status).toBe(422);
  });

  it('suspends a staff user: sessions revoked, STATUS_CHANGE audited with reason', async () => {
    const t = staffApp();
    const sa = t.staff({ isSuperadmin: true, reauthenticated: true });
    const target = staffRow({ roles: [{ code: 'STAFF' }] });
    t.m.user.findFirst.mockResolvedValue(target);
    const res = await request(t.app)
      .patch(`/api/v1/admin/users/${target.id}/status`)
      .set(sa.headers)
      .send({ status: 'SUSPENDED', reason: 'policy breach' });
    expect(res.status).toBe(200);
    expect(res.body.data.sessionsRevoked).toBe(2);
    expect(t.m.user.update).toHaveBeenCalledWith({
      where: { id: target.id },
      data: { status: 'SUSPENDED', updatedById: sa.ctx.userId },
    });
    expect(t.m.refreshToken.updateMany.mock.calls[0]?.[0].data.revokedReason).toBe(
      'STATUS_CHANGED',
    );
    expect(auditRows(t)[0]).toMatchObject({
      action: 'STATUS_CHANGE',
      reason: 'policy breach',
      oldValues: { id: target.id, status: 'ACTIVE' },
      newValues: expect.objectContaining({ status: 'SUSPENDED' }),
    });
    expect(t.permissions.invalidated).toContain(target.id);
  });
});

describe('DELETE /admin/users/:userId and /sessions', () => {
  it('self-delete → SELF_MODIFICATION; last Superadmin → LAST_SUPERADMIN', async () => {
    const t = staffApp();
    const sa = t.staff({ isSuperadmin: true, reauthenticated: true });
    t.m.user.findFirst.mockResolvedValue(staffRow({ id: sa.ctx.userId, isSuperadmin: true }));
    const self = await request(t.app)
      .delete(`/api/v1/admin/users/${sa.ctx.userId}`)
      .set(sa.headers);
    expect(self.status).toBe(403);
    expect(self.body.error.details[0].code).toBe('SELF_MODIFICATION');

    const other = staffRow({ isSuperadmin: true });
    t.m.user.findFirst.mockResolvedValue(other);
    t.m.user.count.mockResolvedValue(1);
    const last = await request(t.app).delete(`/api/v1/admin/users/${other.id}`).set(sa.headers);
    expect(last.status).toBe(409);
    expect(last.body.error.details[0].code).toBe('LAST_SUPERADMIN');
  });

  it('soft-deletes a staff user (DISABLED + deletedAt) and revokes sessions', async () => {
    const t = staffApp();
    const admin = t.staff({ permissions: ADMIN_PERMS, reauthenticated: true });
    const target = staffRow({ roles: [{ code: 'STAFF' }] });
    t.m.user.findFirst.mockResolvedValue(target);
    const res = await request(t.app).delete(`/api/v1/admin/users/${target.id}`).set(admin.headers);
    expect(res.status).toBe(200);
    expect(t.m.user.update.mock.calls[0]?.[0].data).toMatchObject({
      status: 'DISABLED',
      deletedAt: NOW,
      deletedById: admin.ctx.userId,
    });
    expect(t.m.verificationToken.updateMany).toHaveBeenCalled();
    expect(auditRows(t)[0]).toMatchObject({ action: 'DELETE', entityId: target.id });
  });

  it('force-logout revokes all sessions (ADMIN_REVOKED) and is audited; needs re-auth', async () => {
    const t = staffApp();
    const target = staffRow({ roles: [{ code: 'STAFF' }] });
    t.m.user.findFirst.mockResolvedValue(target);
    const noReauth = t.staff({ permissions: ADMIN_PERMS });
    expect(
      (
        await request(t.app)
          .delete(`/api/v1/admin/users/${target.id}/sessions`)
          .set(noReauth.headers)
      ).status,
    ).toBe(403);
    const admin = t.staff({ permissions: ADMIN_PERMS, reauthenticated: true });
    const res = await request(t.app)
      .delete(`/api/v1/admin/users/${target.id}/sessions`)
      .set(admin.headers);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ userId: target.id, sessionsRevoked: 2 });
    expect(t.m.refreshToken.updateMany.mock.calls[0]?.[0].data.revokedReason).toBe('ADMIN_REVOKED');
    expect(auditRows(t)[0]).toMatchObject({ action: 'LOGOUT', entityId: target.id });
  });
});

describe('PATCH /admin/users/:userId', () => {
  it('updates profile fields only and audits the diff', async () => {
    const t = staffApp();
    const admin = t.staff({ permissions: ADMIN_PERMS, reauthenticated: true });
    const target = staffRow({ roles: [{ code: 'STAFF' }] });
    t.m.user.findFirst.mockResolvedValue(target);
    const res = await request(t.app)
      .patch(`/api/v1/admin/users/${target.id}`)
      .set(admin.headers)
      .send({ firstName: 'Ravindra' });
    expect(res.status).toBe(200);
    expect(auditRows(t)[0]).toMatchObject({
      action: 'UPDATE',
      oldValues: { id: target.id, firstName: 'Ravi' },
    });
    const bad = await request(t.app)
      .patch(`/api/v1/admin/users/${target.id}`)
      .set(admin.headers)
      .send({ status: 'ACTIVE' });
    expect(bad.status).toBe(422);
  });
});

/**
 * RBAC end-to-end through the REAL permission service (context loading against the in-memory fake
 * rows from the auth test kit) — MOCKED DB, no MySQL. Covers TESTING_STRATEGY §16 TC-009 (a new
 * ADMIN's effective permissions = full catalogue) and TC-010 (ADMIN + DENY override → 403 + audit).
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { generateTotpSecret } from '../../../../src/core/security/totp.js';
import { PERMISSIONS } from '../../../../src/lib/permissions.js';
import { createAdminAuthModule } from '../../../../src/modules/admin-auth/index.js';
import { createStaffModule } from '../../../../src/modules/staff/index.js';
import { buildRoleDefinitions } from '../../../../prisma/seed/roles.seed.js';
import { ADMIN_ORIGIN } from '../../../helpers/testApp.js';
import { GOOD_PASSWORD, UA_A, buildAuthKit, type AuthKit } from '../auth/authTestKit.js';

const ALL_KEYS = PERMISSIONS.map((p) => p.key);

/** ADMIN role grants exactly as the roles seed defines them. */
function seededAdminKeys(): string[] {
  const admin = buildRoleDefinitions().find((r) => r.code === 'ADMIN');
  if (admin === undefined) throw new Error('ADMIN role missing from seed');
  return [...admin.permissionKeys];
}

/** A brand-new ADMIN (MFA enrolled, D-45) signs in; returns the access token and user id. */
async function newAdminSession(kit: AuthKit, email: string, denies: string[] = []) {
  const secret = generateTotpSecret();
  const user = kit.seedUser({
    email,
    password: GOOD_PASSWORD,
    accountType: 'STAFF',
    mfaEnabled: true,
    mfaSecretEncrypted: kit.t.container.cipher.encrypt(secret),
    roles: [{ code: 'ADMIN', permissions: seededAdminKeys() }],
    lastLoginAt: null,
  });
  if (denies.length > 0) kit.db.denies.set(user.id as string, denies);
  const step1 = await kit.adm('/auth/login').send({ email, password: GOOD_PASSWORD });
  expect(step1.body.data.mfaRequired).toBe(true);
  const verified = await kit
    .adm('/auth/mfa/verify')
    .send({ mfaChallengeId: step1.body.data.mfaChallengeId, totpCode: kit.totp(secret) });
  expect(verified.status).toBe(200);
  return { token: verified.body.data.accessToken as string, userId: user.id as string };
}

function adminGet(kit: AuthKit, path: string, token: string) {
  return request(kit.t.app)
    .get(`/api/v1/admin${path}`)
    .set({ Authorization: `Bearer ${token}`, Origin: ADMIN_ORIGIN, 'User-Agent': UA_A });
}

function kitWithStaff(): AuthKit {
  const kit = buildAuthKit([createAdminAuthModule, createStaffModule]);
  kit.t.m.auditLog.create.mockResolvedValue({});
  return kit;
}

describe('RBAC effective permissions through the API', () => {
  it('TC-009: a new ADMIN user receives every catalogue permission (effective, via /me and guards)', async () => {
    const kit = kitWithStaff();
    expect(new Set(seededAdminKeys())).toEqual(new Set(ALL_KEYS));
    const { token, userId } = await newAdminSession(kit, 'new-admin@example.com');

    const effective = await kit.permissions.effectivePermissions(kit.t.container.db, userId, false);
    expect(effective).toEqual([...ALL_KEYS].sort());

    const me = await adminGet(kit, '/auth/me', token);
    expect(me.status).toBe(200);
    expect(me.body.data.user.isSuperadmin).toBe(false);
    expect([...(me.body.data.permissions as string[])].sort()).toEqual([...ALL_KEYS].sort());
    expect(me.body.data.deniedOverrides).toEqual([]);

    // A permission-guarded route (roles.view) is allowed without any PERMISSION_DENIED row.
    const perms = await adminGet(kit, '/permissions', token);
    expect(perms.status).toBe(200);
    const actions = kit.t.m.auditLog.create.mock.calls.map(
      (c): unknown => (c[0] as { data: { action: string } }).data.action,
    );
    expect(actions).not.toContain('PERMISSION_DENIED');
  });

  it('TC-010: an ADMIN with a DENY override is blocked with 403 and the denial is audited', async () => {
    const kit = kitWithStaff();
    const { token, userId } = await newAdminSession(kit, 'denied-admin@example.com', [
      'roles.view',
    ]);
    const me = await adminGet(kit, '/auth/me', token);
    expect(me.body.data.permissions).not.toContain('roles.view');
    expect(me.body.data.deniedOverrides).toEqual(['roles.view']);

    const before = kit.t.m.auditLog.create.mock.calls.length;
    const res = await adminGet(kit, '/permissions', token);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PERMISSION_DENIED');

    const rows = kit.t.m.auditLog.create.mock.calls
      .slice(before)
      .map((c) => (c[0] as { data: Record<string, unknown> }).data);
    const denied = rows.find((r) => r.action === 'PERMISSION_DENIED');
    expect(denied).toMatchObject({
      action: 'PERMISSION_DENIED',
      outcome: 'FAILURE',
      module: 'roles',
      entityType: 'Route',
      actorType: 'STAFF',
      actorUserId: userId,
      actorRole: 'ADMIN',
    });
    expect(
      (denied?.newValues as { _event: { eventKey: string; metadata: Record<string, unknown> } })
        ._event,
    ).toMatchObject({
      eventKey: 'authz.denied',
      metadata: { required: ['roles.view'], missing: ['roles.view'], method: 'GET' },
    });
  });
});

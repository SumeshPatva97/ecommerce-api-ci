/**
 * Staff auth flows through the real Express app — MOCKED DB (in-memory fake delegates from
 * authTestKit.ts; no MySQL). Real EdDSA JWTs, real permission service, real TOTP and AES-GCM.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { generateTotpSecret } from '../../../../src/core/security/totp.js';
import { createAdminAuthModule } from '../../../../src/modules/admin-auth/index.js';
import { ADMIN_ORIGIN, STOREFRONT_ORIGIN } from '../../../helpers/testApp.js';
import { expectAdminRoutesGuarded } from '../../../helpers/routeTable.js';
import {
  GOOD_PASSWORD,
  UA_A,
  UA_B,
  buildAuthKit,
  installFakeAuthDb,
  seedUserRow,
  type AuthKit,
} from './authTestKit.js';
import { createAuthModule } from '../../../../src/modules/auth/index.js';
import {
  createPermissionService,
  type PermissionService,
} from '../../../../src/modules/rbac/permission.service.js';
import { buildModuleTestApp } from '../../../helpers/container.js';

interface SessionView {
  readonly sessionId: string;
  readonly current: boolean;
  readonly deviceLabel: string;
  readonly ipAddress: string | null;
}

const MANAGER = { code: 'MANAGER', permissions: ['orders.view', 'products.view'] };

function seedStaff(kit: AuthKit, email: string, extra: Record<string, unknown> = {}) {
  return kit.seedUser({
    email,
    password: GOOD_PASSWORD,
    accountType: 'STAFF',
    roles: [MANAGER],
    lastLoginAt: new Date('2026-11-01T00:00:00.000Z'),
    ...extra,
  });
}

async function staffLogin(kit: AuthKit, email: string, ua = UA_A) {
  const res = await kit.adm('/auth/login', ua).send({ email, password: GOOD_PASSWORD });
  return {
    res,
    token: res.body.data?.accessToken as string,
    cookie: kit.cookie(res, 'adm_rt') ?? '',
  };
}

function adminGet(kit: AuthKit, path: string, token: string) {
  return request(kit.t.app)
    .get(`/api/v1/admin${path}`)
    .set({ Authorization: `Bearer ${token}`, Origin: ADMIN_ORIGIN, 'User-Agent': UA_A });
}

describe('staff login & /admin/auth/me', () => {
  it('logs in without MFA, sets adm_rt (Strict, admin path) and returns permissions', async () => {
    const kit = buildAuthKit();
    const user = seedStaff(kit, 'priya@example.com');
    kit.db.denies.set(user.id as string, ['products.view']);
    const { res, token } = await staffLogin(kit, 'priya@example.com');
    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({ email: 'priya@example.com', isSuperadmin: false });
    expect(res.body.data.user.roles[0].code).toBe('MANAGER');
    expect(res.body.data.mfaEnrollmentRequired).toBeUndefined();
    const raw = kit.rawCookie(res, 'adm_rt') ?? '';
    expect(raw).toMatch(/SameSite=Strict/);
    expect(raw).toMatch(/Path=\/api\/v1\/admin\/auth/);
    expect(raw).toMatch(/Max-Age=43200/);

    const me = await adminGet(kit, '/auth/me', token);
    expect(me.status).toBe(200);
    expect(me.body.data.permissions).toEqual(['orders.view']); // DENY override wins
    expect(me.body.data.deniedOverrides).toEqual(['products.view']);
    expect(me.body.data.session.reauthValidUntil).toBeNull();
    expect(me.body.data.user.mfaEnabled).toBe(false);
  });

  it('keeps audiences apart (credentials, tokens and cookies)', async () => {
    const kit = buildAuthKit();
    seedStaff(kit, 'staff@example.com');
    kit.seedUser({ email: 'cust@example.com', password: GOOD_PASSWORD });
    const customerOnAdmin = await kit
      .adm('/auth/login')
      .send({ email: 'cust@example.com', password: GOOD_PASSWORD });
    expect(customerOnAdmin.status).toBe(401);
    expect(customerOnAdmin.body.error.message).toBe('Invalid email or password.');

    const customer = await kit
      .sf('/auth/login')
      .send({ email: 'cust@example.com', password: GOOD_PASSWORD });
    const { token: staffToken, cookie: staffCookie } = await staffLogin(kit, 'staff@example.com');
    expect((await adminGet(kit, '/auth/me', customer.body.data.accessToken as string)).status).toBe(
      401,
    );
    const staffOnMe = await request(kit.t.app)
      .get('/api/v1/me')
      .set({ Authorization: `Bearer ${staffToken}`, Origin: STOREFRONT_ORIGIN });
    expect(staffOnMe.status).toBe(401);
    // an admin refresh token is not accepted by the storefront refresh endpoint
    const crossed = await kit.sf('/auth/refresh').set('Cookie', `sf_rt=${staffCookie}`).send({});
    expect(crossed.status).toBe(401);
  });

  it('lists only own sessions and returns 404 for another user’s session', async () => {
    const kit = buildAuthKit();
    seedStaff(kit, 'a@example.com');
    seedStaff(kit, 'b@example.com');
    const a1 = await staffLogin(kit, 'a@example.com');
    await staffLogin(kit, 'a@example.com', UA_B);
    const b = await staffLogin(kit, 'b@example.com');
    const list = await adminGet(kit, '/auth/sessions', a1.token);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(2);
    const rows = list.body.data as SessionView[];
    const current = rows.find((s) => s.current);
    expect(current?.deviceLabel).toBe('Chrome on Windows');
    expect(current?.ipAddress).toMatch(/\*\*\*/);
    const other = rows.find((s) => !s.current);

    const bSessions = await adminGet(kit, '/auth/sessions', b.token);
    const bSid = bSessions.body.data[0].sessionId as string;
    const foreign = await request(kit.t.app)
      .delete(`/api/v1/admin/auth/sessions/${bSid}`)
      .set({ Authorization: `Bearer ${a1.token}`, Origin: ADMIN_ORIGIN });
    expect(foreign.status).toBe(404);

    const revoke = await request(kit.t.app)
      .delete(`/api/v1/admin/auth/sessions/${other?.sessionId ?? ''}`)
      .set({ Authorization: `Bearer ${a1.token}`, Origin: ADMIN_ORIGIN });
    expect(revoke.status).toBe(200);
    expect(revoke.body.data).toMatchObject({ deleted: true, current: false });
    expect((await adminGet(kit, '/auth/sessions', a1.token)).body.data).toHaveLength(1);
  });
});

describe('staff MFA step-up (TOTP)', () => {
  function seedMfa(kit: AuthKit, email: string) {
    const secret = generateTotpSecret();
    seedStaff(kit, email, {
      mfaEnabled: true,
      mfaSecretEncrypted: kit.t.container.cipher.encrypt(secret),
      roles: [{ code: 'ADMIN', permissions: ['orders.view'] }],
    });
    return secret;
  }

  it('requires the TOTP before issuing tokens and rejects a replayed code', async () => {
    const kit = buildAuthKit();
    const secret = seedMfa(kit, 'mfa@example.com');
    const step1 = await kit
      .adm('/auth/login')
      .send({ email: 'mfa@example.com', password: GOOD_PASSWORD });
    expect(step1.status).toBe(200);
    expect(step1.body.data).toMatchObject({ mfaRequired: true, expiresIn: 300 });
    expect(step1.body.data.accessToken).toBeUndefined();
    expect(kit.rawCookie(step1, 'adm_rt')).toBeUndefined();

    const code = kit.totp(secret);
    const ok = await kit
      .adm('/auth/mfa/verify')
      .send({ mfaChallengeId: step1.body.data.mfaChallengeId, totpCode: code });
    expect(ok.status).toBe(200);
    expect(ok.body.data.accessToken).toEqual(expect.any(String));
    expect(kit.cookie(ok, 'adm_rt')).toEqual(expect.any(String));

    // the challenge is single-use and the same code cannot be replayed on a new challenge
    const reuseChallenge = await kit
      .adm('/auth/mfa/verify')
      .send({ mfaChallengeId: step1.body.data.mfaChallengeId, totpCode: code });
    expect(reuseChallenge.body.error.details[0].code).toBe('MFA_CHALLENGE_EXPIRED');
    const again = await kit
      .adm('/auth/login')
      .send({ email: 'mfa@example.com', password: GOOD_PASSWORD });
    const replay = await kit
      .adm('/auth/mfa/verify')
      .send({ mfaChallengeId: again.body.data.mfaChallengeId, totpCode: code });
    expect(replay.status).toBe(401);
    expect(replay.body.error.details[0].code).toBe('MFA_INVALID');
  });

  it('invalidates the challenge after 5 wrong codes and binds it to the user agent', async () => {
    const kit = buildAuthKit();
    const secret = seedMfa(kit, 'mfa2@example.com');
    const login = await kit
      .adm('/auth/login')
      .send({ email: 'mfa2@example.com', password: GOOD_PASSWORD });
    const id = login.body.data.mfaChallengeId as string;
    const otherUa = await kit
      .adm('/auth/mfa/verify', UA_B)
      .send({ mfaChallengeId: id, totpCode: kit.totp(secret) });
    expect(otherUa.body.error.details[0].code).toBe('MFA_CHALLENGE_EXPIRED');
    const wrong = kit.totp(secret, 5);
    const codes: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await kit.adm('/auth/mfa/verify').send({ mfaChallengeId: id, totpCode: wrong });
      codes.push(r.body.error.details[0].code as string);
    }
    expect(codes).toEqual([
      'MFA_INVALID',
      'MFA_INVALID',
      'MFA_INVALID',
      'MFA_INVALID',
      'MFA_CHALLENGE_EXPIRED',
    ]);
    // 5 MFA failures counted toward lockout → account locked
    const user = [...kit.db.users.values()].find((u) => u.email === 'mfa2@example.com');
    expect(user?.lockedUntil).toBeInstanceOf(Date);
    const recovery = await kit
      .adm('/auth/mfa/verify')
      .send({ mfaChallengeId: id, recoveryCode: 'ABCDE-12345' });
    expect(recovery.status).toBe(401); // challenge gone first
  });

  it('blocks sign-in for an Admin without MFA: enrolment token only, no session (D-45)', async () => {
    const kit = buildAuthKit();
    seedStaff(kit, 'admin@example.com', { roles: [{ code: 'ADMIN', permissions: [] }] });
    const { res } = await staffLogin(kit, 'admin@example.com');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      mfaEnrollmentRequired: true,
      enrollmentToken: expect.any(String),
      expiresIn: 900,
    });
    expect(res.body.data.accessToken).toBeUndefined();
    expect(kit.cookie(res, 'adm_rt')).toBeUndefined();
    expect(kit.db.refreshTokens).toHaveLength(0);
  });
});

describe('re-auth, refresh and password management', () => {
  it('re-auth sets reauth:{sid} for the session only', async () => {
    const kit = buildAuthKit();
    seedStaff(kit, 'ra@example.com');
    const a = await staffLogin(kit, 'ra@example.com');
    const b = await staffLogin(kit, 'ra@example.com', UA_B);
    const reauth = (token: string, password: string) =>
      request(kit.t.app)
        .post('/api/v1/admin/auth/reauth')
        .set({ Authorization: `Bearer ${token}`, Origin: ADMIN_ORIGIN })
        .send({ password });
    const bad = await reauth(a.token, 'not-the-password');
    expect(bad.status).toBe(401);
    const ok = await reauth(a.token, GOOD_PASSWORD);
    expect(ok.status).toBe(200);
    expect(new Date(ok.body.data.validUntil as string).getTime() - kit.t.now.value.getTime()).toBe(
      600_000,
    );
    expect((await adminGet(kit, '/auth/me', a.token)).body.data.session.reauthValidUntil).toBe(
      ok.body.data.validUntil,
    );
    expect(
      (await adminGet(kit, '/auth/me', b.token)).body.data.session.reauthValidUntil,
    ).toBeNull();
    kit.advance(601);
    const fresh = await kit.adm('/auth/refresh').set('Cookie', `adm_rt=${a.cookie}`).send({});
    expect(
      (await adminGet(kit, '/auth/me', fresh.body.data.accessToken as string)).body.data.session
        .reauthValidUntil,
    ).toBeNull();
  });

  it('rotates admin refresh tokens with an 8 h idle and 12 h absolute cap', async () => {
    const kit = buildAuthKit();
    seedStaff(kit, 'rf@example.com');
    let { cookie } = await staffLogin(kit, 'rf@example.com');
    for (let i = 0; i < 2; i += 1) {
      kit.advance(5 * 3600);
      const r = await kit.adm('/auth/refresh').set('Cookie', `adm_rt=${cookie}`).send({});
      expect(r.status).toBe(200);
      expect(r.body.data.user.roles[0].code).toBe('MANAGER');
      cookie = kit.cookie(r, 'adm_rt') ?? '';
    }
    kit.advance(2 * 3600 + 1); // 12 h after login
    const expired = await kit.adm('/auth/refresh').set('Cookie', `adm_rt=${cookie}`).send({});
    expect(expired.status).toBe(401);
    expect(expired.body.error.code).toBe('TOKEN_EXPIRED');

    const idle = await staffLogin(kit, 'rf@example.com');
    kit.advance(8 * 3600 + 1);
    const idleRes = await kit.adm('/auth/refresh').set('Cookie', `adm_rt=${idle.cookie}`).send({});
    expect(idleRes.body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('change-password keeps the current session and revokes the others', async () => {
    const kit = buildAuthKit();
    const user = seedStaff(kit, 'cp@example.com');
    const a = await staffLogin(kit, 'cp@example.com');
    const b = await staffLogin(kit, 'cp@example.com', UA_B);
    const change = (current: string) =>
      request(kit.t.app)
        .post('/api/v1/admin/auth/change-password')
        .set({ Authorization: `Bearer ${a.token}`, Origin: ADMIN_ORIGIN })
        .send({ currentPassword: current, newPassword: 'fresh-saffron-meadow' });
    expect((await change('wrong-password-x')).status).toBe(401);
    expect(kit.db.users.get(user.id as string)?.failedLoginCount).toBe(1);
    const res = await change(GOOD_PASSWORD);
    expect(res.status).toBe(200);
    expect((await adminGet(kit, '/auth/me', a.token)).status).toBe(200);
    expect((await adminGet(kit, '/auth/me', b.token)).status).toBe(401);
    expect(kit.t.email.outbox.some((m) => m.templateKey === 'PASSWORD_CHANGED')).toBe(true);
  });

  it('forgot/reset for staff uses the admin URL and revokes sessions', async () => {
    const kit = buildAuthKit();
    seedStaff(kit, 'fr@example.com');
    const { token } = await staffLogin(kit, 'fr@example.com');
    const res = await kit.adm('/auth/forgot-password').send({ email: 'fr@example.com' });
    expect(res.status).toBe(202);
    const link = String(
      kit.t.email.outbox.find((m) => m.templateKey === 'PASSWORD_RESET_REQUESTED')?.variables?.link,
    );
    expect(link.startsWith('http://localhost:5174/reset-password?token=')).toBe(true);
    const reset = await kit.adm('/auth/reset-password').send({
      token: new URL(link).searchParams.get('token'),
      newPassword: 'fresh-saffron-meadow',
    });
    expect(reset.status).toBe(200);
    expect((await adminGet(kit, '/auth/me', token)).status).toBe(401);
    // a customer reset link cannot be used on the admin endpoint and vice versa
    kit.seedUser({ email: 'c@example.com', password: GOOD_PASSWORD });
    await kit.sf('/auth/forgot-password').send({ email: 'c@example.com' });
    const customerLink = String(kit.t.email.outbox.at(-1)?.variables?.link);
    const crossed = await kit.adm('/auth/reset-password').send({
      token: new URL(customerLink).searchParams.get('token'),
      newPassword: 'fresh-saffron-meadow',
    });
    expect(crossed.status).toBe(422);
  });

  it('accept-invite activates the account and signs in', async () => {
    const kit = buildAuthKit();
    const user = seedStaff(kit, 'new@example.com', {
      status: 'PENDING_VERIFICATION',
      passwordHash: null,
      lastLoginAt: null,
    });
    const { hashToken } = await import('../../../../src/core/security/tokens.js');
    const raw = 'invite-token-0123456789abcdefghijklmnopqrstu';
    kit.db.verificationTokens.push({
      id: '6f1d1d4e-1111-4c1c-8c1c-111111111111',
      userId: user.id,
      purpose: 'STAFF_INVITE',
      channel: 'EMAIL',
      target: 'new@example.com',
      tokenHash: hashToken(raw),
      attemptCount: 0,
      maxAttempts: 5,
      expiresAt: new Date(kit.t.now.value.getTime() + 3600_000),
      consumedAt: null,
      invalidatedAt: null,
    });
    const res = await kit
      .adm('/auth/accept-invite')
      .send({ token: raw, password: 'fresh-saffron-meadow', lastName: 'Rao' });
    expect(res.status).toBe(200);
    expect(res.body.data.user.lastName).toBe('Rao');
    expect(kit.cookie(res, 'adm_rt')).toEqual(expect.any(String));
    expect(kit.db.users.get(user.id as string)).toMatchObject({
      status: 'ACTIVE',
      passwordHash: 'test-hash:fresh-saffron-meadow',
    });
    const again = await kit
      .adm('/auth/accept-invite')
      .send({ token: raw, password: 'fresh-saffron-meadow' });
    expect(again.status).toBe(422);
  });

  it('admin logout clears adm_rt and requires the admin origin', async () => {
    const kit = buildAuthKit();
    seedStaff(kit, 'lo@example.com');
    const { cookie } = await staffLogin(kit, 'lo@example.com');
    const foreign = await request(kit.t.app)
      .post('/api/v1/admin/auth/logout')
      .set({ Origin: ADMIN_ORIGIN, 'X-Client': 'storefront', Cookie: `adm_rt=${cookie}` })
      .send({});
    expect(foreign.status).toBe(403);
    const out = await kit.adm('/auth/logout').set('Cookie', `adm_rt=${cookie}`).send({});
    expect(out.status).toBe(200);
    expect(kit.cookie(out, 'adm_rt')).toBe('');
    expect((await kit.adm('/auth/refresh').set('Cookie', `adm_rt=${cookie}`).send({})).status).toBe(
      401,
    );
  });
});

describe('route table', () => {
  it('every admin-auth route behind authentication is self-service (no permission needed)', () => {
    const kit = buildAuthKit();
    const module = createAdminAuthModule(kit.t.container);
    const routes = expectAdminRoutesGuarded(module);
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /auth/me',
      'POST /auth/reauth',
      'POST /auth/change-password',
      'GET /auth/sessions',
      'DELETE /auth/sessions/:sessionId',
    ]);
  });
});

describe('Phase 4 catalogue gaps — staff lockout, cookie flags, login audit', () => {
  type AuditData = Record<string, unknown> & {
    newValues?: { _event?: { eventKey?: string; metadata?: Record<string, unknown> } };
  };
  const audits = (kit: AuthKit): AuditData[] =>
    kit.t.m.auditLog.create.mock.calls.map((c) => (c[0] as { data: AuditData }).data);

  it('TC-003: 5 wrong staff passwords lock the account for 30 minutes (customer: 15)', async () => {
    const kit = buildAuthKit();
    expect(kit.t.container.config.auth.lockout.staff).toEqual({ maxAttempts: 5, lockMinutes: 30 });
    expect(kit.t.container.config.auth.lockout.customer).toEqual({
      maxAttempts: 5,
      lockMinutes: 15,
    });
    const user = seedStaff(kit, 'lockme@example.com');
    const start = kit.t.now.value.getTime();
    for (let i = 0; i < 4; i += 1) {
      const r = await kit
        .adm('/auth/login')
        .send({ email: 'lockme@example.com', password: `wrong-password-${String(i)}` });
      expect(r.status).toBe(401);
      expect(kit.db.users.get(user.id as string)?.lockedUntil).toBeNull();
    }
    const fifth = await kit
      .adm('/auth/login')
      .send({ email: 'lockme@example.com', password: 'wrong-password-4' });
    expect(fifth.status).toBe(401);
    const lockedUntil = kit.db.users.get(user.id as string)?.lockedUntil as Date;
    expect(lockedUntil).toBeInstanceOf(Date);
    expect(lockedUntil.getTime() - start).toBe(30 * 60 * 1000);
    const lockAudit = audits(kit).find(
      (a) => a.newValues?._event?.eventKey === 'auth.account_locked',
    );
    expect(lockAudit).toMatchObject({ action: 'LOGIN_FAILED', entityId: user.id });
    expect(lockAudit?.newValues?._event?.metadata).toMatchObject({
      audience: 'admin',
      lockedUntil: lockedUntil.toISOString(),
    });

    // Still locked at 29 min (the correct password fails generically) ...
    kit.advance(29 * 60);
    const stillLocked = await kit
      .adm('/auth/login')
      .send({ email: 'lockme@example.com', password: GOOD_PASSWORD });
    expect(stillLocked.status).toBe(401);
    expect(stillLocked.body.error.message).toBe('Invalid email or password.');
    // ... and unlocked once the 30 minutes have passed.
    kit.advance(61);
    const ok = await staffLogin(kit, 'lockme@example.com');
    expect(ok.res.status).toBe(200);
  });

  it('TC-006: adm_rt is HttpOnly, SameSite=Strict, Path=/api/v1/admin/auth; Secure follows config', async () => {
    const kit = buildAuthKit();
    seedStaff(kit, 'cookie@example.com');
    const { res } = await staffLogin(kit, 'cookie@example.com');
    expect(res.status).toBe(200);
    const raw = kit.rawCookie(res, 'adm_rt') ?? '';
    const attrs = raw.split(';').map((p) => p.trim());
    expect(attrs).toContain('HttpOnly');
    expect(attrs).toContain('SameSite=Strict');
    expect(attrs).toContain('Path=/api/v1/admin/auth');
    // Test config (NODE_ENV=test, no COOKIE_SECURE) resolves to secure=false -> no Secure flag.
    expect(kit.t.container.config.auth.cookies.secure).toBe(false);
    expect(attrs).not.toContain('Secure');
  });

  it('TC-006: with COOKIE_SECURE=true both refresh cookies carry Secure plus their flags', async () => {
    const holder: { target?: PermissionService } = {};
    const svc = (): PermissionService => {
      if (holder.target === undefined) throw new Error('permission service not wired');
      return holder.target;
    };
    const lazy: PermissionService = {
      loadContext: (...a) => svc().loadContext(...a),
      effectivePermissions: (...a) => svc().effectivePermissions(...a),
      invalidateUser: (...a) => {
        svc().invalidateUser(...a);
      },
      bumpVersion: () => {
        svc().bumpVersion();
      },
    };
    const t = buildModuleTestApp([createAuthModule, createAdminAuthModule], {
      env: { COOKIE_SECURE: 'true' },
      overrides: { permissions: lazy },
    });
    holder.target = createPermissionService({
      db: t.container.db,
      store: t.store,
      ttlSeconds: 0,
      clock: t.container.clock,
    });
    const db = installFakeAuthDb(t.m, () => t.now.value);
    expect(t.container.config.auth.cookies.secure).toBe(true);
    const staff = seedUserRow({
      email: 'sec@example.com',
      emailNormalized: 'sec@example.com',
      firstName: 'Riya',
      passwordHash: `test-hash:${GOOD_PASSWORD}`,
      accountType: 'STAFF',
      lastLoginAt: new Date('2026-11-01T00:00:00.000Z'),
    });
    db.users.set(staff.id as string, staff);
    db.roles.set(staff.id as string, [MANAGER]);
    const customer = seedUserRow({
      email: 'cust-sec@example.com',
      emailNormalized: 'cust-sec@example.com',
      firstName: 'Riya',
      passwordHash: `test-hash:${GOOD_PASSWORD}`,
    });
    db.users.set(customer.id as string, customer);

    const cookieAttrs = (res: request.Response, name: string): string[] => {
      const header = res.headers['set-cookie'] as unknown;
      const list = Array.isArray(header) ? (header as string[]) : [];
      return (list.find((c) => c.startsWith(`${name}=`)) ?? '').split(';').map((p) => p.trim());
    };
    const adm = await request(t.app)
      .post('/api/v1/admin/auth/login')
      .set({ Origin: ADMIN_ORIGIN, 'X-Client': 'admin', 'User-Agent': UA_A })
      .send({ email: 'sec@example.com', password: GOOD_PASSWORD });
    expect(adm.status).toBe(200);
    expect(cookieAttrs(adm, 'adm_rt')).toEqual(
      expect.arrayContaining(['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/api/v1/admin/auth']),
    );
    const sf = await request(t.app)
      .post('/api/v1/auth/login')
      .set({ Origin: STOREFRONT_ORIGIN, 'X-Client': 'storefront', 'User-Agent': UA_A })
      .send({ email: 'cust-sec@example.com', password: GOOD_PASSWORD });
    expect(sf.status).toBe(200);
    expect(cookieAttrs(sf, 'sf_rt')).toEqual(
      expect.arrayContaining(['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/api/v1/auth']),
    );
  });

  it('TC-063: a successful staff LOGIN is audited and audit rows carry no secrets', async () => {
    const kit = buildAuthKit();
    const secret = generateTotpSecret();
    const encrypted = kit.t.container.cipher.encrypt(secret);
    const user = seedStaff(kit, 'audited@example.com', {
      mfaEnabled: true,
      mfaSecretEncrypted: encrypted,
      roles: [{ code: 'ADMIN', permissions: ['orders.view'] }],
    });
    // One failure first so LOGIN_FAILED rows are covered by the secrets check too.
    await kit
      .adm('/auth/login')
      .send({ email: 'audited@example.com', password: 'nope-wrong-pass' });
    const step1 = await kit
      .adm('/auth/login')
      .send({ email: 'audited@example.com', password: GOOD_PASSWORD });
    const verified = await kit
      .adm('/auth/mfa/verify')
      .send({ mfaChallengeId: step1.body.data.mfaChallengeId, totpCode: kit.totp(secret) });
    expect(verified.status).toBe(200);
    const accessToken = verified.body.data.accessToken as string;
    const refreshToken = kit.cookie(verified, 'adm_rt') ?? '';
    expect(refreshToken).not.toBe('');

    const rows = audits(kit);
    const login = rows.find((a) => a.action === 'LOGIN' && a.outcome === 'SUCCESS');
    expect(login).toMatchObject({
      action: 'LOGIN',
      outcome: 'SUCCESS',
      module: 'auth',
      entityType: 'User',
      entityId: user.id,
      actorUserId: user.id,
      actorType: 'STAFF',
    });
    expect(login?.newValues?._event?.eventKey).toBe('auth.login');
    expect(login?.newValues?._event?.metadata).toMatchObject({ audience: 'admin' });

    const dump = JSON.stringify(rows);
    for (const forbidden of [
      GOOD_PASSWORD,
      'nope-wrong-pass',
      `test-hash:${GOOD_PASSWORD}`,
      accessToken,
      refreshToken,
      String(step1.body.data.mfaChallengeId),
      secret,
      encrypted,
    ]) {
      expect(dump).not.toContain(forbidden);
    }
    expect(dump).not.toMatch(/"(password|passwordHash|mfaSecret\w*|accessToken|refreshToken)"/);
  });
});

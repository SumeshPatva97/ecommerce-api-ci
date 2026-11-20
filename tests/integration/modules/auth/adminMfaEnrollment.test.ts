/**
 * Staff MFA enrolment & enforcement — `POST /admin/auth/mfa/enroll` + `/confirm` (owner decision
 * 2026-11-19, D-45). MOCKED DB: the stateful in-memory fake from authTestKit (no SQL runs).
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { hashToken } from '../../../../src/core/security/tokens.js';
import { ADMIN_ORIGIN } from '../../../helpers/testApp.js';
import { GOOD_PASSWORD, UA_B, buildAuthKit, type AuthKit } from './authTestKit.js';

const ADMIN_ROLE = { code: 'ADMIN', permissions: ['orders.view'] };
const MANAGER = { code: 'MANAGER', permissions: ['orders.view'] };

function seedStaff(kit: AuthKit, email: string, extra: Record<string, unknown> = {}) {
  return kit.seedUser({
    email,
    password: GOOD_PASSWORD,
    accountType: 'STAFF',
    roles: [ADMIN_ROLE],
    lastLoginAt: new Date('2026-11-01T00:00:00.000Z'),
    ...extra,
  });
}

async function loginForEnrollment(kit: AuthKit, email: string): Promise<string> {
  const res = await kit.adm('/auth/login').send({ email, password: GOOD_PASSWORD });
  expect(res.status).toBe(200);
  expect(res.body.data.mfaEnrollmentRequired).toBe(true);
  return res.body.data.enrollmentToken as string;
}

describe('MFA enrolment (token flow for mandatory-MFA staff)', () => {
  it('enrol → confirm activates MFA, issues the session and never stores the plaintext secret', async () => {
    const kit = buildAuthKit();
    const user = seedStaff(kit, 'sa@example.com', { isSuperadmin: true, roles: [] });
    const enrollmentToken = await loginForEnrollment(kit, 'sa@example.com');

    const enroll = await kit.adm('/auth/mfa/enroll').send({ enrollmentToken });
    expect(enroll.status).toBe(200);
    expect(enroll.headers['cache-control']).toContain('no-store');
    const { secret, otpauthUri, accountLabel, expiresIn } = enroll.body.data as Record<
      string,
      string | number
    >;
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(otpauthUri).toContain(`secret=${String(secret)}`);
    expect(accountLabel).toBe('sa@example.com');
    expect(expiresIn).toBe(900);
    // Nothing persisted before confirmation.
    expect(kit.db.users.get(user.id as string)).toMatchObject({
      mfaEnabled: false,
      mfaSecretEncrypted: null,
    });

    const confirm = await kit
      .adm('/auth/mfa/confirm')
      .send({ enrollmentToken, totpCode: kit.totp(String(secret)) });
    expect(confirm.status).toBe(200);
    expect(confirm.body.data.accessToken).toEqual(expect.any(String));
    expect(kit.cookie(confirm, 'adm_rt')).toEqual(expect.any(String));

    const stored = kit.db.users.get(user.id as string);
    expect(stored?.mfaEnabled).toBe(true);
    expect(stored?.mfaSecretEncrypted).not.toContain(String(secret));
    expect(kit.t.container.cipher.decrypt(stored?.mfaSecretEncrypted as string)).toBe(secret);
    // Responses after enrolment never expose the secret.
    expect(JSON.stringify(confirm.body)).not.toContain(String(secret));

    const enrolledAudit = kit.t.m.auditLog.create.mock.calls
      .map((call) => (call[0] as { data: { newValues?: { _event?: { eventKey?: string } } } }).data)
      .find((d) => d.newValues?._event?.eventKey === 'auth.mfa_enrolled');
    expect(enrolledAudit).toBeDefined();
    expect(JSON.stringify(kit.t.m.auditLog.create.mock.calls)).not.toContain(String(secret));

    // The enrolment token is single use.
    const reuse = await kit.adm('/auth/mfa/enroll').send({ enrollmentToken });
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.details[0].code).toBe('MFA_ENROLLMENT_INVALID');

    // Next sign-in now requires the TOTP step-up instead of enrolment.
    const next = await kit
      .adm('/auth/login')
      .send({ email: 'sa@example.com', password: GOOD_PASSWORD });
    expect(next.body.data).toMatchObject({ mfaRequired: true, mfaChallengeId: expect.any(String) });
  });

  it('rejects an invalid code, counts it toward lockout, and discards the pending secret after 5 failures', async () => {
    const kit = buildAuthKit();
    const user = seedStaff(kit, 'ad@example.com');
    const enrollmentToken = await loginForEnrollment(kit, 'ad@example.com');
    await kit.adm('/auth/mfa/enroll').send({ enrollmentToken });

    const codes: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await kit.adm('/auth/mfa/confirm').send({ enrollmentToken, totpCode: '000000' });
      expect(r.status).toBe(401);
      codes.push(r.body.error.details[0].code as string);
    }
    expect(codes).toEqual([
      'MFA_INVALID',
      'MFA_INVALID',
      'MFA_INVALID',
      'MFA_INVALID',
      'MFA_ENROLLMENT_EXPIRED',
    ]);
    expect(kit.db.users.get(user.id as string)?.mfaEnabled).toBe(false);
    expect(kit.db.users.get(user.id as string)?.lockedUntil).toBeInstanceOf(Date);
    expect(kit.db.refreshTokens).toHaveLength(0);
  });

  it('requires enrol before confirm, validates the code format and rejects unknown tokens', async () => {
    const kit = buildAuthKit();
    seedStaff(kit, 'nc@example.com');
    const enrollmentToken = await loginForEnrollment(kit, 'nc@example.com');

    const early = await kit.adm('/auth/mfa/confirm').send({ enrollmentToken, totpCode: '123456' });
    expect(early.status).toBe(409);
    expect(early.body.error.details[0].code).toBe('MFA_ENROLLMENT_NOT_STARTED');

    const badFormat = await kit
      .adm('/auth/mfa/confirm')
      .send({ enrollmentToken, totpCode: '12ab' });
    expect(badFormat.status).toBe(422);

    const unknown = await kit
      .adm('/auth/mfa/enroll')
      .send({ enrollmentToken: 'not-a-real-token-0123456789abcdefghijk' });
    expect(unknown.status).toBe(401);

    const extraField = await kit.adm('/auth/mfa/enroll').send({ enrollmentToken, secret: 'X' });
    expect(extraField.status).toBe(422);

    const anonymous = await kit.adm('/auth/mfa/enroll').send({});
    expect(anonymous.status).toBe(401);
  });

  it('repeated enrol requests rotate the pending secret: only the latest QR works', async () => {
    const kit = buildAuthKit();
    seedStaff(kit, 'rp@example.com');
    const enrollmentToken = await loginForEnrollment(kit, 'rp@example.com');
    const first = (await kit.adm('/auth/mfa/enroll').send({ enrollmentToken })).body.data
      .secret as string;
    const second = (await kit.adm('/auth/mfa/enroll').send({ enrollmentToken })).body.data
      .secret as string;
    expect(second).not.toBe(first);

    const stale = await kit
      .adm('/auth/mfa/confirm')
      .send({ enrollmentToken, totpCode: kit.totp(first) });
    expect(stale.status).toBe(401);
    const fresh = await kit
      .adm('/auth/mfa/confirm')
      .send({ enrollmentToken, totpCode: kit.totp(second) });
    expect(fresh.status).toBe(200);
    expect(fresh.body.data.accessToken).toEqual(expect.any(String));
  });

  it('rejects a replayed code and an expired pending enrolment', async () => {
    const kit = buildAuthKit();
    seedStaff(kit, 'ex@example.com');
    const enrollmentToken = await loginForEnrollment(kit, 'ex@example.com');
    await kit.adm('/auth/mfa/enroll').send({ enrollmentToken });
    kit.advance(16 * 60);
    const late = await kit.adm('/auth/mfa/confirm').send({ enrollmentToken, totpCode: '123456' });
    expect(late.status).toBe(401); // enrolment token (15 min) and pending secret both expired
    expect(late.body.error.details[0].code).toBe('MFA_ENROLLMENT_INVALID');
  });

  it('accept-invite for an Admin sets the password but issues no session until MFA is confirmed', async () => {
    const kit = buildAuthKit();
    const user = seedStaff(kit, 'inv@example.com', {
      status: 'PENDING_VERIFICATION',
      passwordHash: null,
      lastLoginAt: null,
    });
    const raw = 'invite-token-0123456789abcdefghijklmnopqrstu';
    kit.db.verificationTokens.push({
      id: '6f1d1d4e-1111-4c1c-8c1c-222222222222',
      userId: user.id,
      purpose: 'STAFF_INVITE',
      channel: 'EMAIL',
      target: 'inv@example.com',
      tokenHash: hashToken(raw),
      attemptCount: 0,
      maxAttempts: 5,
      expiresAt: new Date(kit.t.now.value.getTime() + 3600_000),
      consumedAt: null,
      invalidatedAt: null,
    });
    const res = await kit
      .adm('/auth/accept-invite')
      .send({ token: raw, password: 'fresh-saffron-meadow' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      mfaEnrollmentRequired: true,
      enrollmentToken: expect.any(String),
      expiresIn: 900,
    });
    expect(kit.cookie(res, 'adm_rt')).toBeUndefined();
    expect(kit.db.users.get(user.id as string)).toMatchObject({
      status: 'ACTIVE',
      passwordHash: 'test-hash:fresh-saffron-meadow',
      lastLoginAt: null,
    });
    expect(kit.db.refreshTokens).toHaveLength(0);

    const token = res.body.data.enrollmentToken as string;
    const secret = (await kit.adm('/auth/mfa/enroll').send({ enrollmentToken: token })).body.data
      .secret as string;
    const confirm = await kit
      .adm('/auth/mfa/confirm')
      .send({ enrollmentToken: token, totpCode: kit.totp(secret) });
    expect(confirm.status).toBe(200);
    expect(kit.cookie(confirm, 'adm_rt')).toEqual(expect.any(String));
  });

  it('refuses refresh for a session whose user became Admin without MFA', async () => {
    const kit = buildAuthKit();
    const user = seedStaff(kit, 'pr@example.com', { roles: [MANAGER] });
    const login = await kit
      .adm('/auth/login')
      .send({ email: 'pr@example.com', password: GOOD_PASSWORD });
    const cookie = kit.cookie(login, 'adm_rt') ?? '';
    expect(cookie).not.toBe('');
    kit.db.roles.set(user.id as string, [ADMIN_ROLE]); // promoted after sign-in
    const refresh = await request(kit.t.app)
      .post('/api/v1/admin/auth/refresh')
      .set({ Origin: ADMIN_ORIGIN, 'X-Client': 'admin', Cookie: `adm_rt=${cookie}` })
      .send({});
    expect(refresh.status).toBe(401);
    expect(refresh.body.error.details[0].code).toBe('MFA_ENROLLMENT_REQUIRED');
    expect(kit.db.refreshTokens.every((r) => r.revokedAt !== null)).toBe(true);
  });
});

describe('MFA enrolment (voluntary, signed-in staff)', () => {
  it('a Manager can enrol with the session; already-enrolled users get 409', async () => {
    const kit = buildAuthKit();
    seedStaff(kit, 'mg@example.com', { roles: [MANAGER] });
    const login = await kit
      .adm('/auth/login', UA_B)
      .send({ email: 'mg@example.com', password: GOOD_PASSWORD });
    expect(login.body.data.accessToken).toEqual(expect.any(String)); // not mandatory → normal session
    const auth = { Authorization: `Bearer ${login.body.data.accessToken as string}` };

    const enroll = await kit.adm('/auth/mfa/enroll', UA_B).set(auth).send({});
    expect(enroll.status).toBe(200);
    const confirm = await kit
      .adm('/auth/mfa/confirm', UA_B)
      .set(auth)
      .send({ totpCode: kit.totp(enroll.body.data.secret as string) });
    expect(confirm.status).toBe(200);
    expect(confirm.body.data).toEqual({ mfaEnabled: true });
    expect(kit.cookie(confirm, 'adm_rt')).toBeUndefined(); // existing session continues

    const again = await kit.adm('/auth/mfa/enroll', UA_B).set(auth).send({});
    expect(again.status).toBe(409);
    expect(again.body.error.details[0].code).toBe('MFA_ALREADY_ENABLED');
  });

  it('a customer token cannot use the staff enrolment routes', async () => {
    const kit = buildAuthKit();
    const customer = kit.t.customer();
    const res = await kit
      .adm('/auth/mfa/enroll')
      .set({ Authorization: customer.headers.Authorization ?? '' })
      .send({});
    expect(res.status).toBe(401);
  });
});

describe('customer authentication is unaffected', () => {
  it('customer login still issues a session directly', async () => {
    const kit = buildAuthKit();
    kit.seedUser({
      email: 'cust@example.com',
      password: GOOD_PASSWORD,
      accountType: 'CUSTOMER',
      status: 'ACTIVE',
    });
    const res = await kit
      .sf('/auth/login')
      .send({ email: 'cust@example.com', password: GOOD_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toEqual(expect.any(String));
    expect(res.body.data.mfaEnrollmentRequired).toBeUndefined();
  });
});

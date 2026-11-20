/**
 * Customer auth flows through the real Express app — MOCKED DB (in-memory fake delegates from
 * authTestKit.ts; no MySQL). Real EdDSA JWTs, real permission service, fake Argon2 stand-in.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { hashToken } from '../../../../src/core/security/tokens.js';
import { ADMIN_ORIGIN, STOREFRONT_ORIGIN } from '../../../helpers/testApp.js';
import { GOOD_PASSWORD, UA_A, UA_B, buildAuthKit, type AuthKit } from './authTestKit.js';

function linkToken(kit: AuthKit, to: string, templateKey: string): string {
  const mail = [...kit.t.email.outbox]
    .reverse()
    .find((m) => m.to === to && m.templateKey === templateKey);
  const link = mail?.variables?.link;
  if (typeof link !== 'string') throw new Error(`no ${templateKey} email for ${to}`);
  return new URL(link).searchParams.get('token') ?? '';
}

async function login(
  kit: AuthKit,
  email: string,
  password = GOOD_PASSWORD,
  ua = UA_A,
  rememberMe = false,
) {
  return kit.sf('/auth/login', ua).send({ email, password, rememberMe });
}

describe('POST /auth/register (R-07)', () => {
  it('answers the same 202 for new and existing emails and never 409', async () => {
    const kit = buildAuthKit();
    kit.seedUser({ email: 'taken@example.com', password: GOOD_PASSWORD });
    const body = {
      firstName: 'Ananya',
      lastName: 'Rao',
      password: GOOD_PASSWORD,
      acceptTerms: true,
      marketingConsent: { email: true, whatsapp: false },
    };
    const fresh = await kit.sf('/auth/register').send({ ...body, email: 'New@Example.com' });
    const dup = await kit.sf('/auth/register').send({ ...body, email: 'taken@example.com' });
    expect(fresh.status).toBe(202);
    expect(dup.status).toBe(202);
    expect(fresh.body.data).toEqual(dup.body.data);
    expect(fresh.body.data.verification.channel).toBe('EMAIL_LINK');

    const created = [...kit.db.users.values()].find((u) => u.emailNormalized === 'new@example.com');
    expect(created).toMatchObject({ status: 'PENDING_VERIFICATION', accountType: 'CUSTOMER' });
    expect(created?.passwordHash).toBe(`test-hash:${GOOD_PASSWORD}`);
    expect(kit.t.email.outbox.map((m) => [m.to, m.templateKey])).toEqual([
      ['new@example.com', 'VERIFICATION_REQUESTED'],
      ['taken@example.com', 'ACCOUNT_ALREADY_EXISTS'],
    ]);
    expect(kit.t.m.notificationPreference.createMany).toHaveBeenCalledTimes(1);
    expect(kit.db.verificationTokens).toHaveLength(1);
    // the raw token is never stored
    const raw = linkToken(kit, 'new@example.com', 'VERIFICATION_REQUESTED');
    expect(kit.db.verificationTokens[0]?.tokenHash).toBe(hashToken(raw));
  });

  it('validates strictly (weak password, unknown keys, acceptTerms) with 422', async () => {
    const kit = buildAuthKit();
    const weak = await kit
      .sf('/auth/register')
      .send({ firstName: 'A', email: 'a@example.com', password: 'short', acceptTerms: true });
    expect(weak.status).toBe(422);
    const extra = await kit.sf('/auth/register').send({
      firstName: 'A',
      email: 'a@example.com',
      password: GOOD_PASSWORD,
      acceptTerms: true,
      userId: 'x',
    });
    expect(extra.status).toBe(422);
    const terms = await kit.sf('/auth/register').send({
      firstName: 'A',
      email: 'a@example.com',
      password: GOOD_PASSWORD,
      acceptTerms: false,
    });
    expect(terms.status).toBe(422);
  });

  it('does not attach a phone that belongs to another account', async () => {
    const kit = buildAuthKit();
    kit.seedUser({ email: 'owner@example.com', phone: '+919812345678' });
    const res = await kit.sf('/auth/register').send({
      firstName: 'B',
      email: 'b@example.com',
      phone: '98123 45678',
      password: GOOD_PASSWORD,
      acceptTerms: true,
    });
    expect(res.status).toBe(202);
    const created = [...kit.db.users.values()].find((u) => u.emailNormalized === 'b@example.com');
    expect(created?.phone).toBeNull();
  });
});

describe('email verification', () => {
  it('verifies with the emailed link, is idempotent, and rejects bad tokens', async () => {
    const kit = buildAuthKit();
    await kit.sf('/auth/register').send({
      firstName: 'C',
      email: 'c@example.com',
      password: GOOD_PASSWORD,
      acceptTerms: true,
    });
    const token = linkToken(kit, 'c@example.com', 'VERIFICATION_REQUESTED');
    const res = await kit.sf('/auth/verify-email').send({ token });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ verified: true, user: { status: 'ACTIVE' } });
    const again = await kit.sf('/auth/verify-email').send({ token });
    expect(again.status).toBe(200);
    const bad = await kit.sf('/auth/verify-email').send({ token: 'x'.repeat(43) });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details[0].code).toBe('TOKEN_INVALID_OR_EXPIRED');
    expect(
      kit.t.m.auditLog.create.mock.calls.some(
        (c) => c[0].data.newValues?._event?.eventKey === 'auth.email_verified',
      ),
    ).toBe(true);
  });

  it('rejects an expired link and resend is always 202 with a cooldown', async () => {
    const kit = buildAuthKit();
    const user = kit.seedUser({
      email: 'd@example.com',
      password: GOOD_PASSWORD,
      status: 'PENDING_VERIFICATION',
    });
    const first = await kit.sf('/auth/resend-verification').send({ email: 'd@example.com' });
    const second = await kit.sf('/auth/resend-verification').send({ email: 'd@example.com' });
    const unknown = await kit.sf('/auth/resend-verification').send({ email: 'nobody@example.com' });
    for (const r of [first, second, unknown]) {
      expect(r.status).toBe(202);
      expect(r.body.data).toEqual({ sent: true });
    }
    expect(kit.t.email.outbox).toHaveLength(1); // cooldown suppressed the second one
    const token = linkToken(kit, 'd@example.com', 'VERIFICATION_REQUESTED');
    kit.advance(25 * 3600);
    const expired = await kit.sf('/auth/verify-email').send({ token });
    expect(expired.status).toBe(422);
    expect(kit.db.users.get(user.id as string)?.status).toBe('PENDING_VERIFICATION');
  });
});

describe('POST /auth/login', () => {
  it('logs in (also PENDING_VERIFICATION), sets sf_rt and the token works on /me', async () => {
    const kit = buildAuthKit();
    kit.seedUser({
      email: 'riya@example.com',
      password: GOOD_PASSWORD,
      status: 'PENDING_VERIFICATION',
    });
    const res = await login(kit, 'Riya@Example.com');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ tokenType: 'Bearer', expiresIn: 900 });
    expect(res.body.data.user).toMatchObject({ email: 'riya@example.com', emailVerified: false });
    const raw = kit.rawCookie(res, 'sf_rt') ?? '';
    expect(raw).toMatch(/HttpOnly/);
    expect(raw).toMatch(/SameSite=Lax/);
    expect(raw).toMatch(/Path=\/api\/v1\/auth/);
    expect(raw).not.toMatch(/Max-Age/); // remember me unticked → session cookie (OQ-92)
    const cookie = kit.cookie(res, 'sf_rt') ?? '';
    expect(kit.db.refreshTokens[0]?.tokenHash).toBe(hashToken(cookie));
    expect(kit.db.refreshTokens[0]?.tokenHash).not.toBe(cookie);

    const me = await request(kit.t.app)
      .get('/api/v1/me')
      .set({
        Authorization: `Bearer ${res.body.data.accessToken as string}`,
        Origin: STOREFRONT_ORIGIN,
      });
    expect(me.status).toBe(200);
    expect(me.body.data.email).toBe('riya@example.com');

    const remembered = await login(kit, 'riya@example.com', GOOD_PASSWORD, UA_A, true);
    expect(kit.rawCookie(remembered, 'sf_rt')).toMatch(/Max-Age=2592000/);
  });

  it('returns the same generic 401 for unknown email, wrong password and staff accounts', async () => {
    const kit = buildAuthKit();
    kit.seedUser({ email: 'riya@example.com', password: GOOD_PASSWORD });
    kit.seedUser({ email: 'staff@example.com', password: GOOD_PASSWORD, accountType: 'STAFF' });
    const results = await Promise.all([
      login(kit, 'nobody@example.com'),
      login(kit, 'riya@example.com', 'wrong-password-1'),
      login(kit, 'staff@example.com'),
    ]);
    for (const r of results) {
      expect(r.status).toBe(401);
      expect(r.body.error).toEqual({
        code: 'UNAUTHENTICATED',
        message: 'Invalid email or password.',
      });
      expect(kit.rawCookie(r, 'sf_rt')).toBeUndefined();
    }
    const failed = kit.t.m.auditLog.create.mock.calls.filter(
      (c) => c[0].data.action === 'LOGIN_FAILED',
    );
    expect(failed).toHaveLength(3);
    expect(JSON.stringify(failed)).not.toContain('wrong-password-1');
  });

  it('locks the account after 5 failures: correct password still fails, owner is emailed', async () => {
    const kit = buildAuthKit();
    const user = kit.seedUser({ email: 'lock@example.com', password: GOOD_PASSWORD });
    for (let i = 0; i < 5; i += 1) {
      expect((await login(kit, 'lock@example.com', `bad-password-${String(i)}`)).status).toBe(401);
    }
    expect(kit.db.users.get(user.id as string)?.lockedUntil).toBeInstanceOf(Date);
    expect(kit.t.email.outbox.some((m) => m.variables?.reason === 'ACCOUNT_LOCKED')).toBe(true);
    const locked = await login(kit, 'lock@example.com');
    expect(locked.status).toBe(401);
    expect(locked.body.error.message).toBe('Invalid email or password.');
    kit.advance(16 * 60);
    expect((await login(kit, 'lock@example.com')).status).toBe(200);
    expect(kit.db.users.get(user.id as string)?.failedLoginCount).toBe(0);
  });

  it('refuses suspended / disabled accounts with 403 after a correct password', async () => {
    const kit = buildAuthKit();
    kit.seedUser({ email: 's@example.com', password: GOOD_PASSWORD, status: 'SUSPENDED' });
    const res = await login(kit, 's@example.com');
    expect(res.status).toBe(403);
    expect(res.body.error.details[0].code).toBe('ACCOUNT_SUSPENDED');
    expect((await login(kit, 's@example.com', 'nope-nope-nope')).status).toBe(401);
  });
});

describe('POST /auth/refresh — rotation, grace window, reuse detection', () => {
  it('rotates, replays the same successor within 10 s (same UA), revokes the family after', async () => {
    const kit = buildAuthKit();
    const user = kit.seedUser({ email: 'r@example.com', password: GOOD_PASSWORD });
    const t1 = kit.cookie(await login(kit, 'r@example.com'), 'sf_rt') ?? '';

    const r1 = await kit.sf('/auth/refresh').set('Cookie', `sf_rt=${t1}`).send({});
    expect(r1.status).toBe(200);
    const t2 = kit.cookie(r1, 'sf_rt') ?? '';
    expect(t2).not.toBe(t1);

    kit.advance(5);
    const replay = await kit.sf('/auth/refresh').set('Cookie', `sf_rt=${t1}`).send({});
    expect(replay.status).toBe(200);
    expect(kit.cookie(replay, 'sf_rt')).toBe(t2);
    expect(replay.body.data.accessToken).toBe(r1.body.data.accessToken);
    expect(kit.db.refreshTokens.filter((r) => r.revokedAt === null)).toHaveLength(1);

    kit.advance(6); // now 11 s after rotation
    const reuse = await kit.sf('/auth/refresh').set('Cookie', `sf_rt=${t1}`).send({});
    expect(reuse.status).toBe(401);
    expect(kit.cookie(reuse, 'sf_rt')).toBe('');
    expect(kit.db.refreshTokens.every((r) => r.revokedAt !== null)).toBe(true);
    const audit = kit.t.m.auditLog.create.mock.calls.find(
      (c) => c[0].data.action === 'TOKEN_REUSE_DETECTED',
    );
    expect(audit?.[0].data).toMatchObject({ actorUserId: user.id, outcome: 'FAILURE' });
    expect(kit.t.email.outbox.some((m) => m.variables?.reason === 'TOKEN_REUSE')).toBe(true);
    // the victim's successor is dead too
    expect((await kit.sf('/auth/refresh').set('Cookie', `sf_rt=${t2}`).send({})).status).toBe(401);
  });

  it('treats a replay from a different user agent inside the window as reuse', async () => {
    const kit = buildAuthKit();
    kit.seedUser({ email: 'r2@example.com', password: GOOD_PASSWORD });
    const t1 = kit.cookie(await login(kit, 'r2@example.com'), 'sf_rt') ?? '';
    expect((await kit.sf('/auth/refresh').set('Cookie', `sf_rt=${t1}`).send({})).status).toBe(200);
    const other = await kit.sf('/auth/refresh', UA_B).set('Cookie', `sf_rt=${t1}`).send({});
    expect(other.status).toBe(401);
    expect(kit.db.refreshTokens.every((r) => r.revokedAt !== null)).toBe(true);
  });

  it('slides the customer expiry and answers TOKEN_EXPIRED after 30 idle days', async () => {
    const kit = buildAuthKit();
    kit.seedUser({ email: 'r3@example.com', password: GOOD_PASSWORD });
    let token = kit.cookie(await login(kit, 'r3@example.com'), 'sf_rt') ?? '';
    kit.advance(29 * 24 * 3600);
    const slid = await kit.sf('/auth/refresh').set('Cookie', `sf_rt=${token}`).send({});
    expect(slid.status).toBe(200);
    token = kit.cookie(slid, 'sf_rt') ?? '';
    kit.advance(31 * 24 * 3600);
    const expired = await kit.sf('/auth/refresh').set('Cookie', `sf_rt=${token}`).send({});
    expect(expired.status).toBe(401);
    expect(expired.body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('enforces the CSRF guard (Origin + X-Client) on refresh and logout', async () => {
    const kit = buildAuthKit();
    const noOrigin = await request(kit.t.app)
      .post('/api/v1/auth/refresh')
      .set('X-Client', 'storefront')
      .send({});
    expect(noOrigin.status).toBe(403);
    const noClient = await request(kit.t.app)
      .post('/api/v1/auth/refresh')
      .set('Origin', STOREFRONT_ORIGIN)
      .send({});
    expect(noClient.status).toBe(403);
    const adminOrigin = await request(kit.t.app)
      .post('/api/v1/auth/logout')
      .set({ Origin: ADMIN_ORIGIN, 'X-Client': 'storefront' })
      .send({});
    expect(adminOrigin.status).toBe(403);
    const noCookie = await kit.sf('/auth/refresh').send({});
    expect(noCookie.status).toBe(401);
  });
});

describe('POST /auth/logout', () => {
  it('revokes the current family, clears the cookie and is idempotent', async () => {
    const kit = buildAuthKit();
    kit.seedUser({ email: 'l@example.com', password: GOOD_PASSWORD });
    const a = kit.cookie(await login(kit, 'l@example.com'), 'sf_rt') ?? '';
    const b = kit.cookie(await login(kit, 'l@example.com', GOOD_PASSWORD, UA_B), 'sf_rt') ?? '';
    const out = await kit.sf('/auth/logout').set('Cookie', `sf_rt=${a}`).send({});
    expect(out.status).toBe(200);
    expect(out.body.data).toEqual({ loggedOut: true });
    expect(kit.cookie(out, 'sf_rt')).toBe('');
    expect((await kit.sf('/auth/refresh').set('Cookie', `sf_rt=${a}`).send({})).status).toBe(401);
    expect((await kit.sf('/auth/refresh', UA_B).set('Cookie', `sf_rt=${b}`).send({})).status).toBe(
      200,
    );
    expect((await kit.sf('/auth/logout').send({})).status).toBe(200);
  });

  it('allDevices revokes every family (by access token, even when expired)', async () => {
    const kit = buildAuthKit();
    kit.seedUser({ email: 'l2@example.com', password: GOOD_PASSWORD });
    const first = await login(kit, 'l2@example.com');
    await login(kit, 'l2@example.com', GOOD_PASSWORD, UA_B);
    kit.advance(20 * 60); // access token expired
    const out = await kit
      .sf('/auth/logout')
      .set('Authorization', `Bearer ${first.body.data.accessToken as string}`)
      .send({ allDevices: true });
    expect(out.status).toBe(200);
    expect(kit.db.refreshTokens.every((r) => r.revokedReason === 'LOGOUT_ALL')).toBe(true);
  });
});

describe('forgot / reset password', () => {
  it('is enumeration-safe and the reset revokes every session', async () => {
    const kit = buildAuthKit();
    const user = kit.seedUser({
      email: 'f@example.com',
      password: GOOD_PASSWORD,
      status: 'PENDING_VERIFICATION',
    });
    const session = kit.cookie(await login(kit, 'f@example.com'), 'sf_rt') ?? '';
    const known = await kit.sf('/auth/forgot-password').send({ email: 'f@example.com' });
    const unknown = await kit.sf('/auth/forgot-password').send({ email: 'ghost@example.com' });
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(known.body.data).toEqual(unknown.body.data);
    const token = linkToken(kit, 'f@example.com', 'PASSWORD_RESET_REQUESTED');

    const weak = await kit.sf('/auth/reset-password').send({ token, newPassword: 'short' });
    expect(weak.status).toBe(422);
    const reset = await kit
      .sf('/auth/reset-password')
      .send({ token, newPassword: 'new-orchid-passphrase' });
    expect(reset.status).toBe(200);
    expect(reset.body.data).toEqual({ reset: true });
    expect(kit.db.users.get(user.id as string)).toMatchObject({
      status: 'ACTIVE',
      failedLoginCount: 0,
    });
    expect(kit.db.refreshTokens.every((r) => r.revokedReason === 'PASSWORD_CHANGED')).toBe(true);
    expect((await kit.sf('/auth/refresh').set('Cookie', `sf_rt=${session}`).send({})).status).toBe(
      401,
    );
    expect(kit.permissions.invalidated).toContain(user.id);
    expect(kit.t.email.outbox.some((m) => m.templateKey === 'PASSWORD_CHANGED')).toBe(true);

    const reused = await kit
      .sf('/auth/reset-password')
      .send({ token, newPassword: 'another-orchid-pass' });
    expect(reused.status).toBe(422);
    expect(reused.body.error.details[0].code).toBe('TOKEN_INVALID_OR_EXPIRED');
    expect((await login(kit, 'f@example.com', 'new-orchid-passphrase')).status).toBe(200);
  });

  it('a newer reset link invalidates the older one; expired links fail', async () => {
    const kit = buildAuthKit();
    kit.seedUser({ email: 'g@example.com', password: GOOD_PASSWORD });
    await kit.sf('/auth/forgot-password').send({ email: 'g@example.com' });
    const older = linkToken(kit, 'g@example.com', 'PASSWORD_RESET_REQUESTED');
    await kit.sf('/auth/forgot-password').send({ email: 'g@example.com' });
    const newer = linkToken(kit, 'g@example.com', 'PASSWORD_RESET_REQUESTED');
    expect(
      (
        await kit
          .sf('/auth/reset-password')
          .send({ token: older, newPassword: 'new-orchid-passphrase' })
      ).status,
    ).toBe(422);
    kit.advance(31 * 60);
    expect(
      (
        await kit
          .sf('/auth/reset-password')
          .send({ token: newer, newPassword: 'new-orchid-passphrase' })
      ).status,
    ).toBe(422);
  });
});

describe('phone OTP (VERIFY_PHONE only)', () => {
  it('sends a WhatsApp code, verifies it, and rejects LOGIN purpose (D-46)', async () => {
    const kit = buildAuthKit();
    const user = kit.seedUser({
      email: 'p@example.com',
      password: GOOD_PASSWORD,
      phone: '+919812345678',
    });
    const send = await kit
      .sf('/auth/otp/send')
      .send({ channel: 'WHATSAPP', destination: '+919812345678', purpose: 'VERIFY_PHONE' });
    expect(send.status).toBe(200);
    expect(send.body.data).toEqual({ sent: true, expiresIn: 600, resendAfter: 60 });
    const code = String(kit.whatsapp.sent[0]?.variables?.code);
    expect(code).toMatch(/^\d{6}$/);
    expect(JSON.stringify(kit.db.verificationTokens)).not.toContain(`"${code}"`);

    const wrong = await kit.sf('/auth/otp/verify').send({
      destination: '+919812345678',
      purpose: 'VERIFY_PHONE',
      otp: code === '000000' ? '111111' : '000000',
    });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.details[0].code).toBe('OTP_INVALID');
    const right = await kit
      .sf('/auth/otp/verify')
      .send({ destination: '+919812345678', purpose: 'VERIFY_PHONE', otp: code });
    expect(right.status).toBe(200);
    expect(kit.db.users.get(user.id as string)?.phoneVerifiedAt).toBeInstanceOf(Date);

    const loginOtp = await kit
      .sf('/auth/otp/send')
      .send({ channel: 'WHATSAPP', destination: '+919812345678', purpose: 'LOGIN' });
    expect(loginOtp.status).toBe(422);
    const unknown = await kit
      .sf('/auth/otp/send')
      .send({ channel: 'WHATSAPP', destination: '+919800000000', purpose: 'VERIFY_PHONE' });
    expect(unknown.status).toBe(200); // generic
    expect(kit.whatsapp.sent).toHaveLength(1);
  });

  it('burns the code after 5 wrong attempts', async () => {
    const kit = buildAuthKit();
    kit.seedUser({ email: 'p2@example.com', phone: '+919812345670' });
    await kit
      .sf('/auth/otp/send')
      .send({ channel: 'WHATSAPP', destination: '+919812345670', purpose: 'VERIFY_PHONE' });
    const code = String(kit.whatsapp.sent[0]?.variables?.code);
    const wrong = code === '000000' ? '111111' : '000000';
    let last;
    for (let i = 0; i < 5; i += 1) {
      last = await kit
        .sf('/auth/otp/verify')
        .send({ destination: '+919812345670', purpose: 'VERIFY_PHONE', otp: wrong });
    }
    expect(last?.body.error.details[0].code).toBe('OTP_ATTEMPTS_EXCEEDED');
    const late = await kit
      .sf('/auth/otp/verify')
      .send({ destination: '+919812345670', purpose: 'VERIFY_PHONE', otp: code });
    expect(late.status).toBe(422);
  });
});

describe('Phase 4 catalogue gaps — customer refresh cookie flags', () => {
  it('TC-006: sf_rt is HttpOnly, SameSite=Lax, Path=/api/v1/auth; Secure follows config', async () => {
    const kit = buildAuthKit();
    kit.seedUser({ email: 'flags@example.com', password: GOOD_PASSWORD });
    const res = await login(kit, 'flags@example.com');
    expect(res.status).toBe(200);
    const attrs = (kit.rawCookie(res, 'sf_rt') ?? '').split(';').map((p) => p.trim());
    expect(attrs).toEqual(
      expect.arrayContaining(['HttpOnly', 'SameSite=Lax', 'Path=/api/v1/auth']),
    );
    // NODE_ENV=test without COOKIE_SECURE resolves to secure=false (production forces Secure).
    expect(kit.t.container.config.auth.cookies.secure).toBe(false);
    expect(attrs).not.toContain('Secure');
  });
});

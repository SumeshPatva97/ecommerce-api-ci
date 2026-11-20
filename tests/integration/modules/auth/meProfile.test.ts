/**
 * `/me` profile, change-password and sessions — MOCKED DB (in-memory fake delegates from
 * authTestKit.ts; no MySQL).
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { STOREFRONT_ORIGIN } from '../../../helpers/testApp.js';
import { GOOD_PASSWORD, UA_A, UA_B, buildAuthKit, type AuthKit } from './authTestKit.js';

async function signIn(kit: AuthKit, email: string, ua = UA_A) {
  const res = await kit.sf('/auth/login', ua).send({ email, password: GOOD_PASSWORD });
  return {
    token: res.body.data.accessToken as string,
    cookie: kit.cookie(res, 'sf_rt') ?? '',
  };
}

function me(
  kit: AuthKit,
  method: 'get' | 'patch' | 'post' | 'delete',
  path: string,
  token: string,
) {
  return request(kit.t.app)
    [method](`/api/v1${path}`)
    .set({
      Authorization: `Bearer ${token}`,
      Origin: STOREFRONT_ORIGIN,
      'User-Agent': UA_A,
    });
}

describe('GET/PATCH /me', () => {
  it('requires a storefront token', async () => {
    const kit = buildAuthKit();
    expect((await request(kit.t.app).get('/api/v1/me')).status).toBe(401);
  });

  it('returns the profile and updates names/phone (phone change resets verification)', async () => {
    const kit = buildAuthKit();
    const user = kit.seedUser({
      email: 'm@example.com',
      password: GOOD_PASSWORD,
      lastName: 'Rao',
      phone: '+919812345678',
      phoneVerifiedAt: new Date('2026-10-01T00:00:00.000Z'),
      emailVerifiedAt: new Date('2026-10-01T00:00:00.000Z'),
    });
    kit.seedUser({ email: 'other@example.com', phone: '+919800000001' });
    const { token } = await signIn(kit, 'm@example.com');
    const get = await me(kit, 'get', '/me', token);
    expect(get.status).toBe(200);
    expect(get.body.data).toMatchObject({
      id: user.id,
      emailVerified: true,
      phone: '+919812345678',
      phoneVerified: true,
      defaultAddressId: null,
    });

    const dup = await me(kit, 'patch', '/me', token).send({ phone: '+919800000001' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_RESOURCE');

    const upd = await me(kit, 'patch', '/me', token).send({
      firstName: 'Ananya',
      phone: '9876543210',
    });
    expect(upd.status).toBe(200);
    expect(upd.body.data).toMatchObject({
      firstName: 'Ananya',
      phone: '+919876543210',
      phoneVerified: false,
    });
    const audit = kit.t.m.auditLog.create.mock.calls.find(
      (c) => c[0].data.newValues?._event?.eventKey === 'profile.updated',
    );
    expect(JSON.stringify(audit)).not.toContain('9876543210'); // phone masked in audit

    expect((await me(kit, 'patch', '/me', token).send({})).status).toBe(422);
    expect((await me(kit, 'patch', '/me', token).send({ email: 'x@example.com' })).status).toBe(
      422,
    );
  });
});

describe('POST /me/change-password', () => {
  it('verifies the current password, keeps this session and revokes the others', async () => {
    const kit = buildAuthKit();
    kit.seedUser({ email: 'cp@example.com', password: GOOD_PASSWORD });
    const a = await signIn(kit, 'cp@example.com');
    const b = await signIn(kit, 'cp@example.com', UA_B);
    const wrong = await me(kit, 'post', '/me/change-password', a.token).send({
      currentPassword: 'wrong-password-x',
      newPassword: 'fresh-saffron-meadow',
    });
    expect(wrong.status).toBe(401);
    const same = await me(kit, 'post', '/me/change-password', a.token).send({
      currentPassword: GOOD_PASSWORD,
      newPassword: GOOD_PASSWORD,
    });
    expect(same.status).toBe(422);
    const ok = await me(kit, 'post', '/me/change-password', a.token).send({
      currentPassword: GOOD_PASSWORD,
      newPassword: 'fresh-saffron-meadow',
    });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toEqual({ changed: true });
    expect((await me(kit, 'get', '/me', a.token)).status).toBe(200);
    expect((await me(kit, 'get', '/me', b.token)).status).toBe(401);
    expect(
      (await kit.sf('/auth/refresh', UA_B).set('Cookie', `sf_rt=${b.cookie}`).send({})).status,
    ).toBe(401);
  });
});

describe('/me/sessions', () => {
  it('lists own sessions and revokes one; foreign session ids are 404', async () => {
    const kit = buildAuthKit();
    kit.seedUser({ email: 's1@example.com', password: GOOD_PASSWORD });
    kit.seedUser({ email: 's2@example.com', password: GOOD_PASSWORD });
    const a = await signIn(kit, 's1@example.com');
    await signIn(kit, 's1@example.com', UA_B);
    const other = await signIn(kit, 's2@example.com');

    const list = await me(kit, 'get', '/me/sessions', a.token);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(2);
    const rows = list.body.data as { sessionId: string; current: boolean; deviceLabel: string }[];
    expect(rows.filter((s) => s.current)).toHaveLength(1);
    expect(JSON.stringify(list.body.data)).not.toMatch(/tokenHash|refreshToken/);

    const foreignSid = (await me(kit, 'get', '/me/sessions', other.token)).body.data[0]
      .sessionId as string;
    expect((await me(kit, 'delete', `/me/sessions/${foreignSid}`, a.token)).status).toBe(404);
    expect((await me(kit, 'delete', '/me/sessions/not-a-uuid', a.token)).status).toBe(422);

    const iphone = rows.find((s) => !s.current);
    expect(iphone?.deviceLabel).toBe('Safari on iOS');
    const del = await me(kit, 'delete', `/me/sessions/${iphone?.sessionId ?? ''}`, a.token);
    expect(del.status).toBe(200);
    expect(del.body.data).toEqual({ id: iphone?.sessionId, deleted: true, current: false });
    expect((await me(kit, 'get', '/me/sessions', a.token)).body.data).toHaveLength(1);
  });
});

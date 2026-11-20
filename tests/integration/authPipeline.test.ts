/**
 * Auth pipeline through the real Express app (MOCKED DB): audience separation, session context,
 * permission guard + denial audit, re-auth, idempotency, route-table self-test.
 */
import { Router } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { ok } from '../../src/core/http/envelope.js';
import { respondsWith } from '../../src/core/http/successStatus.js';
import { signAccessToken } from '../../src/core/security/jwt.js';
import type { ModuleFactory } from '../../src/modules/types.js';
import { buildModuleTestApp } from '../helpers/container.js';
import { expectAdminRoutesGuarded, listRoutes } from '../helpers/routeTable.js';

const fixture: ModuleFactory = (c) => {
  const adminRouter = Router();
  adminRouter.get('/things', c.auth.requirePermission('products.view'), (req, res) => {
    ok(req, res, { who: req.authz?.userId });
  });
  adminRouter.post(
    '/things/:id/approve',
    c.auth.requirePermission('refunds.approve'),
    c.auth.requireReauth(),
    c.idempotency({ required: true }),
    respondsWith(201),
    (req, res) => {
      ok(req, res, { approved: req.params.id }, { status: 201 });
    },
  );
  adminRouter.get(
    '/either',
    c.auth.requireAnyPermission('orders.view', 'reports.view'),
    (req, res) => {
      ok(req, res, true);
    },
  );
  const publicRouter = Router();
  publicRouter.get('/me/thing', c.auth.authenticate('storefront'), (req, res) => {
    ok(req, res, { id: req.authz?.userId });
  });
  publicRouter.get('/maybe', c.auth.optionalAuthenticate('storefront'), (req, res) => {
    ok(req, res, { authenticated: req.authz !== undefined });
  });
  return { name: 'fixture', adminRouter, publicRouter };
};

describe('auth pipeline', () => {
  it('requires a valid admin token on every /admin route (router-level authentication)', async () => {
    const t = buildModuleTestApp([fixture]);
    const res = await request(t.app).get('/api/v1/admin/things');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    const unknown = await request(t.app).get('/api/v1/admin/nope');
    expect(unknown.status).toBe(401); // no admin surface is reachable anonymously
  });

  it('rejects a customer token on admin routes and a staff token on customer routes', async () => {
    const t = buildModuleTestApp([fixture]);
    const customer = t.customer();
    const staff = t.staff({ permissions: ['products.view'] });
    // Storefront origin on /admin is refused by CORS first (403) …
    expect((await request(t.app).get('/api/v1/admin/things').set(customer.headers)).status).toBe(
      403,
    );
    // … and with the admin origin the audience check rejects the customer token (401).
    expect(
      (
        await request(t.app)
          .get('/api/v1/admin/things')
          .set({ ...customer.headers, Origin: 'http://localhost:5174' })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(t.app)
          .get('/api/v1/me/thing')
          .set({ ...staff.headers, Origin: 'http://localhost:5173' })
      ).status,
    ).toBe(401);
    const okRes = await request(t.app).get('/api/v1/me/thing').set(customer.headers);
    expect(okRes.status).toBe(200);
    expect(okRes.body.data.id).toBe(customer.ctx.userId);
  });

  it('returns TOKEN_EXPIRED for an expired access token and 401 for a revoked session', async () => {
    const t = buildModuleTestApp([fixture]);
    const staff = t.staff({ permissions: ['products.view'] });
    t.now.value = new Date(t.now.value.getTime() + 20 * 60 * 1000);
    const expired = await request(t.app).get('/api/v1/admin/things').set(staff.headers);
    expect(expired.status).toBe(401);
    expect(expired.body.error.code).toBe('TOKEN_EXPIRED');

    const fresh = t.staff({ permissions: ['products.view'] });
    t.permissions.sessions.clear(); // session revoked server-side
    expect((await request(t.app).get('/api/v1/admin/things').set(fresh.headers)).status).toBe(401);
  });

  it('denies missing permissions with 403 and audits PERMISSION_DENIED', async () => {
    const t = buildModuleTestApp([fixture]);
    const staff = t.staff({ permissions: ['orders.view'] });
    const res = await request(t.app).get('/api/v1/admin/things').set(staff.headers);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PERMISSION_DENIED');
    expect(t.m.auditLog.create).toHaveBeenCalledTimes(1);
    const row = t.m.auditLog.create.mock.calls[0]?.[0].data;
    expect(row).toMatchObject({
      action: 'PERMISSION_DENIED',
      outcome: 'FAILURE',
      actorUserId: staff.ctx.userId,
      module: 'products',
    });
    expect((await request(t.app).get('/api/v1/admin/either').set(staff.headers)).status).toBe(200);
  });

  it('lets Superadmins bypass permissions but not re-auth', async () => {
    const t = buildModuleTestApp([fixture]);
    const sa = t.staff({ isSuperadmin: true });
    expect((await request(t.app).get('/api/v1/admin/things').set(sa.headers)).status).toBe(200);
    const res = await request(t.app)
      .post('/api/v1/admin/things/x/approve')
      .set(sa.headers)
      .set('Idempotency-Key', 'key-0000000000000001')
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('REAUTH_REQUIRED');
  });

  it('enforces Idempotency-Key and replays completed responses', async () => {
    const t = buildModuleTestApp([fixture]);
    const sa = t.staff({ isSuperadmin: true, reauthenticated: true });
    const missing = await request(t.app)
      .post('/api/v1/admin/things/x/approve')
      .set(sa.headers)
      .send({});
    expect(missing.status).toBe(400);

    t.m.idempotencyKey.create.mockResolvedValueOnce({ id: 'row-1' });
    const first = await request(t.app)
      .post('/api/v1/admin/things/x/approve')
      .set(sa.headers)
      .set('Idempotency-Key', 'key-0000000000000001')
      .send({ a: 1 });
    expect(first.status).toBe(201);
    expect(t.m.idempotencyKey.update).toHaveBeenCalledWith({
      where: { id: 'row-1' },
      data: { status: 'COMPLETED', responseRef: { status: 201, body: first.body } },
    });

    const duplicate = Object.assign(new Error('dup'), { code: 'P2002', clientVersion: '7.10.1' });
    const { requestHash } = await import('../../src/core/middleware/idempotency.js');
    const hash = requestHash('POST', '/api/v1/admin/things/x/approve', { a: 1 });
    t.m.idempotencyKey.create.mockRejectedValueOnce(duplicate);
    t.m.idempotencyKey.findFirst.mockResolvedValueOnce({
      requestHash: hash,
      status: 'COMPLETED',
      responseRef: { status: 201, body: first.body },
    });
    const replay = await request(t.app)
      .post('/api/v1/admin/things/x/approve')
      .set(sa.headers)
      .set('Idempotency-Key', 'key-0000000000000001')
      .send({ a: 1 });
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(first.body);

    t.m.idempotencyKey.create.mockRejectedValueOnce(duplicate);
    t.m.idempotencyKey.findFirst.mockResolvedValueOnce({
      requestHash: 'other',
      status: 'COMPLETED',
      responseRef: null,
    });
    const mismatch = await request(t.app)
      .post('/api/v1/admin/things/x/approve')
      .set(sa.headers)
      .set('Idempotency-Key', 'key-0000000000000001')
      .send({ a: 2 });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.error.details[0].code).toBe('PAYLOAD_MISMATCH');

    t.m.idempotencyKey.create.mockRejectedValueOnce(duplicate);
    t.m.idempotencyKey.findFirst.mockResolvedValueOnce({
      requestHash: hash,
      status: 'IN_PROGRESS',
      responseRef: null,
    });
    const busy = await request(t.app)
      .post('/api/v1/admin/things/x/approve')
      .set(sa.headers)
      .set('Idempotency-Key', 'key-0000000000000001')
      .send({ a: 1 });
    expect(busy.status).toBe(409);
    expect(busy.headers['retry-after']).toBe('2');

    const badKey = await request(t.app)
      .post('/api/v1/admin/things/x/approve')
      .set(sa.headers)
      .set('Idempotency-Key', 'short')
      .send({});
    expect(badKey.status).toBe(422);
  });

  it('optional authentication accepts anonymous calls but rejects bad tokens', async () => {
    const t = buildModuleTestApp([fixture]);
    expect((await request(t.app).get('/api/v1/maybe')).body.data.authenticated).toBe(false);
    expect(
      (await request(t.app).get('/api/v1/maybe').set(t.customer().headers)).body.data.authenticated,
    ).toBe(true);
    expect(
      (await request(t.app).get('/api/v1/maybe').set('Authorization', 'Bearer a.b.c')).status,
    ).toBe(401);
    const foreign = signAccessToken(t.container.keySet, {
      sub: 'x',
      sid: 'y',
      aud: 'storefront',
      iss: 'https://evil.example',
      ttlSeconds: 900,
      now: t.now.value,
    });
    expect(
      (await request(t.app).get('/api/v1/maybe').set('Authorization', `Bearer ${foreign}`)).status,
    ).toBe(401);
  });

  it('route-table self-test detects unguarded admin routes and missing re-auth', () => {
    const t = buildModuleTestApp([fixture]);
    const module = fixture(t.container);
    const routes = expectAdminRoutesGuarded(module);
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /things',
      'POST /things/:id/approve',
      'GET /either',
    ]);
    const bad = Router();
    bad.get('/open', (_req, res) => res.end());
    expect(listRoutes(bad)[0]?.permissions).toEqual([]);
    expect(() => expectAdminRoutesGuarded({ name: 'bad', adminRouter: bad })).toThrow(
      /no permission guard/,
    );
  });
});

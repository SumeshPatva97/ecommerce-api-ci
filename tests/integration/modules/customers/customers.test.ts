/**
 * Admin customers API — MOCKED DB (Prisma stand-in, no MySQL).
 */
import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { Prisma } from '../../../../src/generated/prisma/client.js';
import { createCustomersModule } from '../../../../src/modules/customers/index.js';
import { buildModuleTestApp } from '../../../helpers/container.js';
import { expectAdminRoutesGuarded } from '../../../helpers/routeTable.js';

const NOW = new Date('2026-11-19T06:30:00.000Z');

function app() {
  const t = buildModuleTestApp([createCustomersModule], { now: NOW });
  t.m.refreshToken.updateMany.mockResolvedValue({ count: 3 });
  t.m.auditLog.create.mockResolvedValue({});
  t.m.order.groupBy.mockResolvedValue([]);
  return t;
}

function customer(id: string = randomUUID(), status = 'ACTIVE') {
  return {
    id,
    firstName: 'Ananya',
    lastName: 'Rao',
    email: 'ananya@example.com',
    phone: '+919812345678',
    status,
    emailVerifiedAt: NOW,
    phoneVerifiedAt: null,
    lastLoginAt: null,
    createdAt: NOW,
  };
}

describe('customers module', () => {
  it('guards every admin route', () => {
    const t = app();
    const routes = expectAdminRoutesGuarded(createCustomersModule(t.container));
    expect(routes.map((r) => `${r.method} ${r.path} ${r.permissions.join()}`)).toEqual([
      'GET /customers customers.view',
      'GET /customers/:customerId customers.view',
      'PATCH /customers/:customerId/status customers.update',
    ]);
  });

  it('lists customers with order stats and pagination meta', async () => {
    const t = app();
    const viewer = t.staff({ permissions: ['customers.view'] });
    const c1 = customer();
    t.m.user.count.mockResolvedValue(26);
    t.m.user.findMany
      .mockResolvedValueOnce([{ id: c1.id }]) // page ids
      .mockResolvedValueOnce([c1]); // rows
    t.m.order.groupBy.mockResolvedValue([
      {
        userId: c1.id,
        _count: { _all: 4 },
        _sum: { grandTotal: new Prisma.Decimal('12500.5') },
        _max: { placedAt: NOW },
      },
    ]);
    const res = await request(t.app)
      .get('/api/v1/admin/customers?q=ananya&status=ACTIVE&from=2026-11-01&to=2026-11-19')
      .set(viewer.headers);
    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ page: 1, limit: 25, totalItems: 26, totalPages: 2 });
    expect(res.body.data[0]).toEqual({
      id: c1.id,
      name: 'Ananya Rao',
      email: 'ananya@example.com',
      phone: '+919812345678',
      status: 'ACTIVE',
      emailVerified: true,
      orderCount: 4,
      totalSpent: '12500.50',
      lastOrderAt: NOW.toISOString(),
      createdAt: NOW.toISOString(),
    });
    const where = t.m.user.count.mock.calls[0]?.[0].where;
    expect(where).toMatchObject({ accountType: 'CUSTOMER', status: 'ACTIVE', deletedAt: null });
    // IST business days: 2026-11-01 00:00 IST = 2026-10-31T18:30Z
    expect(where.createdAt.gte).toEqual(new Date('2026-10-31T18:30:00.000Z'));
    expect(where.createdAt.lt).toEqual(new Date('2026-11-19T18:30:00.000Z'));
  });

  it('sorts by -totalSpent: ranked spenders first, then customers without orders', async () => {
    const t = app();
    const viewer = t.staff({ permissions: ['customers.view'] });
    const big = customer();
    const none = customer();
    t.m.user.count.mockResolvedValue(2);
    t.m.order.groupBy
      .mockResolvedValueOnce([{ userId: big.id }]) // ranking
      .mockResolvedValueOnce([]); // stats
    t.m.user.findMany
      .mockResolvedValueOnce([{ id: none.id }]) // non-spenders
      .mockResolvedValueOnce([none, big]); // rows (any order)
    const res = await request(t.app)
      .get('/api/v1/admin/customers?sort=-totalSpent')
      .set(viewer.headers);
    expect(res.status).toBe(200);
    expect((res.body.data as { id: string }[]).map((c) => c.id)).toEqual([big.id, none.id]);
    expect(t.m.order.groupBy.mock.calls[0]?.[0].orderBy[0]).toEqual({
      _sum: { grandTotal: 'desc' },
    });
  });

  it('rejects an invalid sort and from > to', async () => {
    const t = app();
    const viewer = t.staff({ permissions: ['customers.view'] });
    expect(
      (await request(t.app).get('/api/v1/admin/customers?sort=name').set(viewer.headers)).status,
    ).toBe(422);
    expect(
      (
        await request(t.app)
          .get('/api/v1/admin/customers?from=2026-11-10&to=2026-11-01')
          .set(viewer.headers)
      ).status,
    ).toBe(422);
  });

  it('returns customer detail without secrets, 404 for unknown ids', async () => {
    const t = app();
    const viewer = t.staff({ permissions: ['customers.view'] });
    const c1 = customer();
    t.m.user.findFirst.mockResolvedValueOnce({
      ...c1,
      anonymizedAt: null,
      updatedAt: NOW,
      addresses: [],
      notificationPrefs: [
        {
          channel: 'EMAIL',
          category: 'MARKETING',
          isOptedIn: true,
          consentSource: 'checkout',
          consentTextVersion: 'v1',
          consentedAt: NOW,
          optedOutAt: null,
        },
      ],
    });
    t.m.order.aggregate.mockResolvedValue({
      _count: { _all: 0 },
      _sum: { grandTotal: null },
      _max: { placedAt: null },
    });
    t.m.order.findMany.mockResolvedValue([]);
    t.m.review.count.mockResolvedValue(2);
    const res = await request(t.app).get(`/api/v1/admin/customers/${c1.id}`).set(viewer.headers);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: c1.id,
      reviewCount: 2,
      orderSummary: { orderCount: 0, totalSpent: '0.00' },
      consents: [{ channel: 'EMAIL', source: 'checkout' }],
    });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|tokenHash|mfaSecret/);

    t.m.user.findFirst.mockResolvedValueOnce(null);
    expect(
      (await request(t.app).get(`/api/v1/admin/customers/${randomUUID()}`).set(viewer.headers))
        .status,
    ).toBe(404);
  });

  it('changes status with a reason: sessions revoked, STATUS_CHANGE audited, cache busted', async () => {
    const t = app();
    const actor = t.staff({ permissions: ['customers.update'] });
    const id = randomUUID();
    t.m.user.findFirst.mockResolvedValue({ id, status: 'ACTIVE' });
    const res = await request(t.app)
      .patch(`/api/v1/admin/customers/${id}/status`)
      .set(actor.headers)
      .send({ status: 'SUSPENDED', reason: 'Chargeback fraud review' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id, status: 'SUSPENDED', sessionsRevoked: 3 });
    expect(t.m.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: NOW, revokedReason: 'STATUS_CHANGED' },
    });
    const row = t.m.auditLog.create.mock.calls[0]?.[0].data;
    expect(row).toMatchObject({
      action: 'STATUS_CHANGE',
      module: 'customers',
      entityId: id,
      reason: 'Chargeback fraud review',
      actorUserId: actor.ctx.userId,
      oldValues: { id, status: 'ACTIVE' },
    });
    expect(t.permissions.invalidated).toContain(id);
  });

  it('requires a reason, rejects no-op/invalid transitions and unknown keys', async () => {
    const t = app();
    const actor = t.staff({ permissions: ['customers.update'] });
    const id = randomUUID();
    const url = `/api/v1/admin/customers/${id}/status`;
    expect(
      (await request(t.app).patch(url).set(actor.headers).send({ status: 'SUSPENDED' })).status,
    ).toBe(422);
    expect(
      (
        await request(t.app)
          .patch(url)
          .set(actor.headers)
          .send({ status: 'SUSPENDED', reason: 'x', userId: id })
      ).status,
    ).toBe(422);
    t.m.user.findFirst.mockResolvedValueOnce({ id, status: 'SUSPENDED' });
    const same = await request(t.app)
      .patch(url)
      .set(actor.headers)
      .send({ status: 'SUSPENDED', reason: 'x' });
    expect(same.status).toBe(409);
    expect(same.body.error.code).toBe('INVALID_STATE_TRANSITION');
    t.m.user.findFirst.mockResolvedValueOnce({ id, status: 'PENDING_VERIFICATION' });
    expect(
      (await request(t.app).patch(url).set(actor.headers).send({ status: 'ACTIVE', reason: 'x' }))
        .status,
    ).toBe(409);
    const viewer = t.staff({ permissions: ['customers.view'] });
    expect(
      (await request(t.app).patch(url).set(viewer.headers).send({ status: 'ACTIVE', reason: 'x' }))
        .status,
    ).toBe(403);
  });
});

/**
 * Admin promotions through the real Express app — API_DOCUMENTATION.md §4.9 (Promotions).
 * MOCKED DB (tests/helpers/mockDb.ts): guards, validation, status transitions, delete rules and
 * audit rows; no SQL is executed.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { Decimal } from '../../../../src/lib/money.js';
import { createPromotionsModule } from '../../../../src/modules/promotions/index.js';
import { buildModuleTestApp } from '../../../helpers/container.js';
import { expectAdminRoutesGuarded } from '../../../helpers/routeTable.js';

const ALL = ['promotions.view', 'promotions.create', 'promotions.update', 'promotions.delete'];
const PROMO_ID = '5a1b2c3d-4e5f-4a6b-8c7d-000000000001';
const CAT = '5a1b2c3d-4e5f-4a6b-8c7d-0000000000c1';
const COL = '5a1b2c3d-4e5f-4a6b-8c7d-0000000000c2';

function setup(permissions: readonly string[] = ALL) {
  const t = buildModuleTestApp([createPromotionsModule]);
  return { t, auth: t.staff({ permissions }).headers };
}

function promoRow(over: Record<string, unknown> = {}) {
  return {
    id: PROMO_ID,
    name: 'Festive 10% off',
    nameNormalized: 'festive 10% off',
    scope: 'CATEGORY',
    discountType: 'PERCENTAGE',
    discountValue: new Decimal(10),
    maxDiscountAmount: null,
    startsAt: new Date('2026-11-01T00:00:00.000Z'),
    endsAt: new Date('2026-12-01T00:00:00.000Z'),
    status: 'SCHEDULED',
    priority: 50,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
    deletedAt: null,
    products: [],
    categories: [{ categoryId: CAT, includeDescendants: true }],
    brands: [],
    collections: [],
    ...over,
  };
}

const body = {
  name: 'Festive 10% off',
  scope: 'CATEGORY',
  targetIds: [CAT],
  discountType: 'PERCENTAGE',
  discountValue: '10',
  startsAt: '2026-11-01T00:00:00.000Z',
  endsAt: '2026-12-01T00:00:00.000Z',
  status: 'SCHEDULED',
};

describe('admin promotions', () => {
  it('guards every admin route with a promotions.* permission', () => {
    const { t } = setup();
    const routes = expectAdminRoutesGuarded(createPromotionsModule(t.container));
    expect(routes.map((r) => `${r.method} ${r.path} ${r.permissions.join(',')}`)).toEqual([
      'GET /promotions promotions.view',
      'POST /promotions promotions.create',
      'GET /promotions/:promotionId promotions.view',
      'PATCH /promotions/:promotionId promotions.update',
      'DELETE /promotions/:promotionId promotions.delete',
      'POST /promotions/:promotionId/pause promotions.update',
      'POST /promotions/:promotionId/resume promotions.update',
    ]);
  });

  it('creates a promotion, derives ACTIVE from the dates and audits CREATE', async () => {
    const { t, auth } = setup();
    t.m.promotion.findUnique.mockResolvedValue(null);
    t.m.category.findMany.mockResolvedValue([{ id: CAT }]);
    t.m.promotion.findFirst.mockResolvedValue(promoRow({ status: 'ACTIVE' }));
    const res = await request(t.app).post('/api/v1/admin/promotions').set(auth).send(body);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      name: 'Festive 10% off',
      label: 'Festive 10% off',
      status: 'ACTIVE',
      targetIds: [CAT],
      includeDescendants: true,
      discountValue: '10.00',
    });
    expect(t.m.promotion.create.mock.calls[0]?.[0].data).toMatchObject({
      nameNormalized: 'festive 10% off',
      status: 'ACTIVE',
      priority: 50,
    });
    expect(t.m.promotionCategory.createMany.mock.calls[0]?.[0].data).toEqual([
      { promotionId: expect.any(String), categoryId: CAT, includeDescendants: true },
    ]);
    expect(t.m.auditLog.create.mock.calls[0]?.[0].data).toMatchObject({
      action: 'CREATE',
      module: 'promotions',
    });
  });

  it('supports COLLECTION scope and keeps DRAFT when requested', async () => {
    const { t, auth } = setup();
    t.m.promotion.findUnique.mockResolvedValue(null);
    t.m.collection.findMany.mockResolvedValue([{ id: COL }]);
    t.m.promotion.findFirst.mockResolvedValue(
      promoRow({
        scope: 'COLLECTION',
        status: 'DRAFT',
        categories: [],
        collections: [{ collectionId: COL }],
      }),
    );
    const res = await request(t.app)
      .post('/api/v1/admin/promotions')
      .set(auth)
      .send({ ...body, scope: 'COLLECTION', targetIds: [COL], status: 'DRAFT' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      status: 'DRAFT',
      targetIds: [COL],
      includeDescendants: null,
    });
    expect(t.m.promotion.create.mock.calls[0]?.[0].data.status).toBe('DRAFT');
    expect(t.m.promotionCollection.createMany).toHaveBeenCalled();
  });

  it('validates the body, targets, name uniqueness and the end date', async () => {
    const { t, auth } = setup();
    const bad = await request(t.app)
      .post('/api/v1/admin/promotions')
      .set(auth)
      .send({
        ...body,
        discountType: 'FIXED_AMOUNT',
        maxDiscountAmount: '10',
        endsAt: body.startsAt,
      });
    expect(bad.status).toBe(422);
    const fields = (bad.body.error.details as { field: string }[]).map((d) => d.field);
    expect(fields).toEqual(expect.arrayContaining(['maxDiscountAmount', 'endsAt']));

    const past = await request(t.app)
      .post('/api/v1/admin/promotions')
      .set(auth)
      .send({ ...body, startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2026-11-01T00:00:00.000Z' });
    expect(past.status).toBe(422);

    t.m.promotion.findUnique.mockResolvedValue({ id: 'other' });
    expect(
      (await request(t.app).post('/api/v1/admin/promotions').set(auth).send(body)).status,
    ).toBe(409);

    t.m.promotion.findUnique.mockResolvedValue(null);
    t.m.category.findMany.mockResolvedValue([]);
    const missing = await request(t.app).post('/api/v1/admin/promotions').set(auth).send(body);
    expect(missing.status).toBe(422);
    expect(missing.body.error.details[0]).toMatchObject({
      field: 'targetIds',
      code: 'UNKNOWN_TARGET',
    });
  });

  it('lists with filters and reports the effective status', async () => {
    const { t, auth } = setup();
    t.m.promotion.findMany.mockResolvedValue([promoRow()]);
    t.m.promotion.count.mockResolvedValue(1);
    const res = await request(t.app)
      .get(
        '/api/v1/admin/promotions?status=ACTIVE&scope=CATEGORY&from=2026-11-01&to=2026-11-30&q=fest',
      )
      .set(auth);
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({ status: 'ACTIVE', storedStatus: 'SCHEDULED' });
    for (const status of ['DRAFT', 'SCHEDULED', 'EXPIRED', 'PAUSED']) {
      expect(
        (await request(t.app).get(`/api/v1/admin/promotions?status=${status}`).set(auth)).status,
      ).toBe(200);
    }
  });

  it('pauses an active promotion and resumes it per dates (STATUS_CHANGE)', async () => {
    const { t, auth } = setup();
    t.m.promotion.findFirst.mockResolvedValue(promoRow({ status: 'ACTIVE' }));
    t.m.promotion.update.mockResolvedValue(promoRow({ status: 'PAUSED' }));
    const pause = await request(t.app).post(`/api/v1/admin/promotions/${PROMO_ID}/pause`).set(auth);
    expect(pause.status).toBe(200);
    expect(pause.body.data.status).toBe('PAUSED');
    expect(t.m.auditLog.create.mock.calls[0]?.[0].data.action).toBe('STATUS_CHANGE');

    t.m.promotion.findFirst.mockResolvedValue(promoRow({ status: 'PAUSED' }));
    t.m.promotion.update.mockResolvedValue(promoRow({ status: 'ACTIVE' }));
    const resume = await request(t.app)
      .post(`/api/v1/admin/promotions/${PROMO_ID}/resume`)
      .set(auth);
    expect(resume.status).toBe(200);
    expect(t.m.promotion.update.mock.calls[1]?.[0].data).toEqual({ status: 'ACTIVE' });
  });

  it('rejects invalid transitions with 409 INVALID_STATE_TRANSITION', async () => {
    const { t, auth } = setup();
    t.m.promotion.findFirst.mockResolvedValue(promoRow({ status: 'DRAFT' }));
    const pause = await request(t.app).post(`/api/v1/admin/promotions/${PROMO_ID}/pause`).set(auth);
    expect(pause.status).toBe(409);
    expect(pause.body.error.code).toBe('INVALID_STATE_TRANSITION');
    const resume = await request(t.app)
      .post(`/api/v1/admin/promotions/${PROMO_ID}/resume`)
      .set(auth);
    expect(resume.status).toBe(409);
    t.m.promotion.findFirst.mockResolvedValue(promoRow({ status: 'PAUSED' }));
    const patch = await request(t.app)
      .patch(`/api/v1/admin/promotions/${PROMO_ID}`)
      .set(auth)
      .send({ status: 'SCHEDULED' });
    expect(patch.status).toBe(409);
  });

  it('updates fields and targets with an UPDATE audit diff', async () => {
    const { t, auth } = setup();
    t.m.promotion.findFirst.mockResolvedValue(promoRow({ status: 'DRAFT' }));
    t.m.promotion.findUnique.mockResolvedValue(null);
    t.m.category.findMany.mockResolvedValue([{ id: CAT }]);
    const res = await request(t.app)
      .patch(`/api/v1/admin/promotions/${PROMO_ID}`)
      .set(auth)
      .send({
        name: 'Festive 15% off',
        discountValue: '15',
        targetIds: [CAT],
        status: 'SCHEDULED',
        priority: 5,
      });
    expect(res.status).toBe(200);
    expect(t.m.promotion.update.mock.calls[0]?.[0].data).toMatchObject({
      name: 'Festive 15% off',
      nameNormalized: 'festive 15% off',
      status: 'ACTIVE',
      priority: 5,
    });
    expect(t.m.promotionCategory.deleteMany).toHaveBeenCalled();
    expect(t.m.auditLog.create.mock.calls[0]?.[0].data.action).toBe('UPDATE');

    const scopeOnly = await request(t.app)
      .patch(`/api/v1/admin/promotions/${PROMO_ID}`)
      .set(auth)
      .send({ scope: 'BRAND' });
    expect(scopeOnly.status).toBe(422);
    expect(scopeOnly.body.error.details[0].field).toBe('targetIds');
  });

  it('deletes only never-applied draft/scheduled/expired promotions', async () => {
    const { t, auth } = setup();
    t.m.promotion.findFirst.mockResolvedValue(promoRow({ status: 'ACTIVE' }));
    t.m.orderItem.count.mockResolvedValue(0);
    const active = await request(t.app).delete(`/api/v1/admin/promotions/${PROMO_ID}`).set(auth);
    expect(active.status).toBe(409);
    expect(active.body.error.details[0].code).toBe('IN_USE');

    t.m.promotion.findFirst.mockResolvedValue(promoRow({ status: 'DRAFT' }));
    t.m.orderItem.count.mockResolvedValue(3);
    expect(
      (await request(t.app).delete(`/api/v1/admin/promotions/${PROMO_ID}`).set(auth)).status,
    ).toBe(409);

    t.m.orderItem.count.mockResolvedValue(0);
    t.m.promotion.update.mockResolvedValue(promoRow({ deletedAt: new Date() }));
    const ok = await request(t.app).delete(`/api/v1/admin/promotions/${PROMO_ID}`).set(auth);
    expect(ok.status).toBe(200);
    expect(ok.body.data).toEqual({ id: PROMO_ID, deleted: true });
    expect(t.m.auditLog.create.mock.calls[0]?.[0].data.action).toBe('DELETE');
  });

  it('returns 404 for unknown promotions and 403 without permission', async () => {
    const { t, auth } = setup();
    t.m.promotion.findFirst.mockResolvedValue(null);
    expect(
      (await request(t.app).get(`/api/v1/admin/promotions/${PROMO_ID}`).set(auth)).status,
    ).toBe(404);
    const viewer = t.staff({ permissions: ['promotions.view'] });
    expect(
      (await request(t.app).post(`/api/v1/admin/promotions/${PROMO_ID}/pause`).set(viewer.headers))
        .status,
    ).toBe(403);
  });
});

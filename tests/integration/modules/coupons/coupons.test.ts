/**
 * Admin coupons through the real Express app — API_DOCUMENTATION.md §4.9.
 * MOCKED DB (tests/helpers/mockDb.ts): verifies guards, validation table, service rules and audit
 * rows; no SQL is executed.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { Decimal } from '../../../../src/lib/money.js';
import { createCouponsModule } from '../../../../src/modules/coupons/index.js';
import { buildModuleTestApp } from '../../../helpers/container.js';
import { expectAdminRoutesGuarded } from '../../../helpers/routeTable.js';

const ALL = ['coupons.view', 'coupons.create', 'coupons.update', 'coupons.delete'];
const COUPON_ID = '7d9f0a1c-2b3c-4d5e-8f90-000000000001';
const CAT_A = '7d9f0a1c-2b3c-4d5e-8f90-0000000000c1';
const BRAND_X = '7d9f0a1c-2b3c-4d5e-8f90-0000000000b1';

function setup(permissions: readonly string[] = ALL) {
  const t = buildModuleTestApp([createCouponsModule]);
  return { t, auth: t.staff({ permissions }).headers };
}

function couponRow(over: Record<string, unknown> = {}) {
  return {
    id: COUPON_ID,
    code: 'FESTIVE500',
    codeNormalized: 'FESTIVE500',
    description: '₹500 off on orders above ₹4,999',
    discountType: 'FIXED_AMOUNT',
    discountValue: new Decimal('500.00'),
    maxDiscountAmount: null,
    minOrderValue: new Decimal('4999.00'),
    startsAt: new Date('2026-11-14T18:30:00.000Z'),
    expiresAt: new Date('2026-11-30T18:29:59.999Z'),
    usageLimitEnabled: true,
    usageLimit: 1000,
    perCustomerLimit: 1,
    usedCount: 0,
    isFirstOrderOnly: false,
    isCombinableWithPromotions: false,
    isPublic: false,
    status: 'ACTIVE',
    createdAt: new Date('2026-11-13T00:00:00.000Z'),
    updatedAt: new Date('2026-11-13T00:00:00.000Z'),
    deletedAt: null,
    applicabilities: [
      {
        ruleType: 'INCLUDE',
        targetType: 'CATEGORY',
        productId: null,
        categoryId: CAT_A,
        brandId: null,
        collectionId: null,
      },
      {
        ruleType: 'EXCLUDE',
        targetType: 'BRAND',
        productId: null,
        categoryId: null,
        brandId: BRAND_X,
        collectionId: null,
      },
    ],
    ...over,
  };
}

const validBody = {
  code: 'festive500',
  description: '₹500 off on orders above ₹4,999',
  discountType: 'FIXED_AMOUNT',
  discountValue: '500.00',
  minOrderValue: '4999.00',
  startsAt: '2026-11-14T18:30:00.000Z',
  expiresAt: '2026-11-30T18:29:59.999Z',
  usageLimitEnabled: true,
  usageLimit: 1000,
  perCustomerLimit: 1,
  isCombinableWithPromotions: false,
  applicability: { includeCategoryIds: [CAT_A], excludeBrandIds: [BRAND_X] },
  status: 'ACTIVE',
};

describe('admin coupons — guards', () => {
  it('guards every admin route with a coupons.* permission', () => {
    const { t } = setup();
    const routes = expectAdminRoutesGuarded(createCouponsModule(t.container));
    expect(routes.map((r) => `${r.method} ${r.path} ${r.permissions.join(',')}`)).toEqual([
      'GET /coupons coupons.view',
      'POST /coupons coupons.create',
      'GET /coupons/:couponId coupons.view',
      'PATCH /coupons/:couponId coupons.update',
      'DELETE /coupons/:couponId coupons.delete',
      'GET /coupons/:couponId/usage coupons.view',
    ]);
  });

  it('denies a viewer creating a coupon (403) and a customer token', async () => {
    const { t } = setup();
    const viewer = t.staff({ permissions: ['coupons.view'] });
    const res = await request(t.app)
      .post('/api/v1/admin/coupons')
      .set(viewer.headers)
      .send(validBody);
    expect(res.status).toBe(403);
    const customer = t.customer();
    const res2 = await request(t.app).get('/api/v1/admin/coupons').set(customer.headers);
    expect([401, 403]).toContain(res2.status);
  });
});

describe('POST /admin/coupons', () => {
  it('creates a normalized coupon with applicability rows and a CREATE audit row', async () => {
    const { t, auth } = setup();
    t.m.coupon.findUnique.mockResolvedValue(null);
    t.m.category.findMany.mockResolvedValue([{ id: CAT_A }]);
    t.m.brand.findMany.mockResolvedValue([{ id: BRAND_X }]);
    t.m.coupon.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve(couponRow({ ...data, applicabilities: [] })),
    );
    t.m.coupon.findFirst.mockResolvedValue(couponRow());
    const res = await request(t.app).post('/api/v1/admin/coupons').set(auth).send(validBody);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      code: 'FESTIVE500',
      usedCount: 0,
      remaining: 1000,
      discountValue: '500.00',
      validity: 'ACTIVE',
      applicability: { includeCategoryIds: [CAT_A], excludeBrandIds: [BRAND_X] },
    });
    const data = t.m.coupon.create.mock.calls[0]?.[0].data;
    expect(data).toMatchObject({
      code: 'FESTIVE500',
      codeNormalized: 'FESTIVE500',
      usageLimit: 1000,
    });
    const rules = t.m.couponApplicability.createMany.mock.calls[0]?.[0].data;
    expect(rules).toEqual([
      expect.objectContaining({ ruleType: 'INCLUDE', targetType: 'CATEGORY', categoryId: CAT_A }),
      expect.objectContaining({ ruleType: 'EXCLUDE', targetType: 'BRAND', brandId: BRAND_X }),
    ]);
    const audit = t.m.auditLog.create.mock.calls[0]?.[0].data;
    expect(audit).toMatchObject({ action: 'CREATE', module: 'coupons', entityType: 'Coupon' });
  });

  it.each([
    [{ usageLimit: 0 }, 'usageLimit', 'Must be at least 1 when usage limit is enabled.'],
    [{ usageLimit: null }, 'usageLimit', 'Usage limit is required when usage limit is enabled.'],
    [{ usageLimit: -5 }, 'usageLimit', 'Must be a whole number of at least 1.'],
    [{ usageLimit: 2.5 }, 'usageLimit', 'Must be a whole number of at least 1.'],
    [
      { usageLimitEnabled: false, usageLimit: 10 },
      'usageLimit',
      'Remove the usage limit or enable it.',
    ],
    [
      { discountType: 'PERCENTAGE', discountValue: '120' },
      'discountValue',
      'Percentage must be between 0.01 and 100.',
    ],
    [
      { maxDiscountAmount: '100.00' },
      'maxDiscountAmount',
      'Maximum discount applies to percentage coupons only.',
    ],
    [
      { expiresAt: '2026-11-14T18:30:00.000Z' },
      'expiresAt',
      'Expiry must be after the start date.',
    ],
    [{ code: 'AB' }, 'code', 'Use 3–32 letters, numbers, hyphens or underscores.'],
    [{ code: 'SAVE 10' }, 'code', 'Use 3–32 letters, numbers, hyphens or underscores.'],
  ])('rejects %j with the documented message', async (patch, field, message) => {
    const { t, auth } = setup();
    const res = await request(t.app)
      .post('/api/v1/admin/coupons')
      .set(auth)
      .send({ ...validBody, ...patch });
    expect(res.status).toBe(422);
    expect(res.body.error.details).toContainEqual({ field, message });
    expect(t.m.coupon.create).not.toHaveBeenCalled();
  });

  it('rejects an expiry in the past and unknown keys', async () => {
    const { t, auth } = setup();
    const past = await request(t.app)
      .post('/api/v1/admin/coupons')
      .set(auth)
      .send({
        ...validBody,
        startsAt: '2026-10-01T00:00:00.000Z',
        expiresAt: '2026-11-01T00:00:00.000Z',
      });
    expect(past.status).toBe(422);
    expect(past.body.error.details[0].field).toBe('expiresAt');
    const extra = await request(t.app)
      .post('/api/v1/admin/coupons')
      .set(auth)
      .send({ ...validBody, usedCount: 5 });
    expect(extra.status).toBe(422);
  });

  it('returns 409 DUPLICATE_RESOURCE for the same code in another case', async () => {
    const { t, auth } = setup();
    t.m.coupon.findUnique.mockResolvedValue({ id: 'other' });
    const res = await request(t.app).post('/api/v1/admin/coupons').set(auth).send(validBody);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'DUPLICATE_RESOURCE',
      message: 'Coupon code FESTIVE500 already exists.',
    });
  });

  it('rejects unknown applicability targets (422)', async () => {
    const { t, auth } = setup();
    t.m.coupon.findUnique.mockResolvedValue(null);
    t.m.category.findMany.mockResolvedValue([]);
    t.m.brand.findMany.mockResolvedValue([{ id: BRAND_X }]);
    const res = await request(t.app).post('/api/v1/admin/coupons').set(auth).send(validBody);
    expect(res.status).toBe(422);
    expect(res.body.error.details[0]).toMatchObject({
      field: 'applicability.includeCategoryIds',
      code: 'UNKNOWN_TARGET',
      meta: { missing: [CAT_A] },
    });
  });
});

describe('GET /admin/coupons', () => {
  it('lists with pagination meta and filters', async () => {
    const { t, auth } = setup();
    t.m.coupon.findMany.mockResolvedValue([couponRow({ usedCount: 37 })]);
    t.m.coupon.count.mockResolvedValue(1);
    const res = await request(t.app)
      .get('/api/v1/admin/coupons?validity=active&status=ACTIVE&discountType=FIXED_AMOUNT&q=fest')
      .set(auth);
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({ usedCount: 37, remaining: 963 });
    expect(res.body.meta).toMatchObject({ page: 1, limit: 25, totalItems: 1 });
    const where = t.m.coupon.findMany.mock.calls[0]?.[0].where;
    expect(JSON.stringify(where)).toContain('FEST');
    for (const validity of ['scheduled', 'expired']) {
      expect(
        (await request(t.app).get(`/api/v1/admin/coupons?validity=${validity}`).set(auth)).status,
      ).toBe(200);
    }
  });

  it('returns 404 for an unknown coupon', async () => {
    const { t, auth } = setup();
    t.m.coupon.findFirst.mockResolvedValue(null);
    expect((await request(t.app).get(`/api/v1/admin/coupons/${COUPON_ID}`).set(auth)).status).toBe(
      404,
    );
  });
});

describe('PATCH /admin/coupons/:couponId', () => {
  it('keeps the code immutable once used and forbids lowering the limit below usage', async () => {
    const { t, auth } = setup();
    t.m.coupon.findFirst.mockResolvedValue(couponRow({ usedCount: 37 }));
    const res = await request(t.app)
      .patch(`/api/v1/admin/coupons/${COUPON_ID}`)
      .set(auth)
      .send({ code: 'NEWCODE', usageLimit: 10 });
    expect(res.status).toBe(422);
    expect(res.body.error.details).toEqual([
      { field: 'code', message: 'The code cannot be changed after the coupon has been used.' },
      { field: 'usageLimit', message: 'Cannot be lower than redemptions already used (37).' },
    ]);
    expect(t.m.$queryRaw).toHaveBeenCalled(); // row locked FOR UPDATE
    expect(t.m.coupon.update).not.toHaveBeenCalled();
  });

  it('deactivates a used coupon with a STATUS_CHANGE audit row', async () => {
    const { t, auth } = setup();
    t.m.coupon.findFirst.mockResolvedValue(couponRow({ usedCount: 37 }));
    t.m.coupon.update.mockResolvedValue(couponRow({ usedCount: 37, status: 'INACTIVE' }));
    const res = await request(t.app)
      .patch(`/api/v1/admin/coupons/${COUPON_ID}`)
      .set(auth)
      .send({ status: 'INACTIVE' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'INACTIVE', validity: 'INACTIVE' });
    expect(t.m.coupon.update.mock.calls[0]?.[0].data).toEqual({ status: 'INACTIVE' });
    expect(t.m.auditLog.create.mock.calls[0]?.[0].data.action).toBe('STATUS_CHANGE');
  });

  it('re-validates cross-field rules on the merged coupon and replaces applicability', async () => {
    const { t, auth } = setup();
    t.m.coupon.findFirst.mockResolvedValue(couponRow());
    const bad = await request(t.app)
      .patch(`/api/v1/admin/coupons/${COUPON_ID}`)
      .set(auth)
      .send({ maxDiscountAmount: '50.00' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details[0].field).toBe('maxDiscountAmount');

    t.m.coupon.findUnique.mockResolvedValue(null);
    t.m.product.findMany.mockResolvedValue([{ id: CAT_A }]);
    t.m.coupon.update.mockResolvedValue(couponRow({ code: 'DIWALI25' }));
    const ok = await request(t.app)
      .patch(`/api/v1/admin/coupons/${COUPON_ID}`)
      .set(auth)
      .send({
        code: 'diwali25',
        discountType: 'PERCENTAGE',
        discountValue: '25',
        maxDiscountAmount: '750.00',
        usageLimitEnabled: false,
        applicability: { includeProductIds: [CAT_A] },
      });
    expect(ok.status).toBe(200);
    const data = t.m.coupon.update.mock.calls[0]?.[0].data;
    expect(data).toMatchObject({ code: 'DIWALI25', codeNormalized: 'DIWALI25', usageLimit: null });
    expect(t.m.couponApplicability.deleteMany).toHaveBeenCalled();
    expect(t.m.auditLog.create.mock.calls[0]?.[0].data.action).toBe('UPDATE');
  });
});

describe('DELETE /admin/coupons/:couponId', () => {
  it('refuses to delete a used coupon (409 IN_USE)', async () => {
    const { t, auth } = setup();
    t.m.coupon.findFirst.mockResolvedValue(couponRow({ usedCount: 0 }));
    t.m.couponUsage.count.mockResolvedValue(1);
    t.m.order.count.mockResolvedValue(0);
    const res = await request(t.app).delete(`/api/v1/admin/coupons/${COUPON_ID}`).set(auth);
    expect(res.status).toBe(409);
    expect(res.body.error.details[0].code).toBe('IN_USE');
  });

  it('soft-deletes a never-used coupon with a DELETE audit row', async () => {
    const { t, auth } = setup();
    t.m.coupon.findFirst.mockResolvedValue(couponRow());
    t.m.couponUsage.count.mockResolvedValue(0);
    t.m.order.count.mockResolvedValue(0);
    t.m.coupon.update.mockResolvedValue(couponRow({ deletedAt: new Date(), status: 'INACTIVE' }));
    const res = await request(t.app).delete(`/api/v1/admin/coupons/${COUPON_ID}`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: COUPON_ID, deleted: true });
    expect(t.m.coupon.update.mock.calls[0]?.[0].data).toMatchObject({ status: 'INACTIVE' });
    expect(t.m.auditLog.create.mock.calls[0]?.[0].data.action).toBe('DELETE');
  });
});

describe('GET /admin/coupons/:couponId/usage', () => {
  const usageRow = {
    id: 'usage-1',
    status: 'REDEEMED',
    discountAmount: new Decimal('300.00'),
    reservedAt: new Date('2026-11-15T10:00:00.000Z'),
    redeemedAt: new Date('2026-11-15T10:05:00.000Z'),
    releasedAt: null,
    order: { id: 'o-1', orderNumber: 'ORD-261115-00001' },
    user: { id: 'u-1', firstName: 'Ananya', lastName: 'Rao', email: 'ananya@example.com' },
  };

  it('returns rows with a summary; e-mail masked without customers.view', async () => {
    const { t, auth } = setup();
    t.m.coupon.findFirst.mockResolvedValue(couponRow());
    t.m.couponUsage.findMany.mockResolvedValue([usageRow]);
    t.m.couponUsage.count.mockResolvedValue(1);
    t.m.couponUsage.groupBy.mockResolvedValue([
      { status: 'REDEEMED', _count: { _all: 1 }, _sum: { discountAmount: new Decimal('300.00') } },
      { status: 'RELEASED', _count: { _all: 2 }, _sum: { discountAmount: new Decimal('0') } },
    ]);
    const res = await request(t.app).get(`/api/v1/admin/coupons/${COUPON_ID}/usage`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({
      orderNumber: 'ORD-261115-00001',
      customer: { id: 'u-1', name: 'Ananya Rao', email: 'a***@example.com' },
      status: 'REDEEMED',
      discountAmount: '300.00',
    });
    expect(res.body.meta.summary).toEqual({
      redeemed: 1,
      reserved: 0,
      released: 2,
      totalDiscount: '300.00',
    });

    const pii = t.staff({ permissions: ['coupons.view', 'customers.view'] });
    const full = await request(t.app)
      .get(`/api/v1/admin/coupons/${COUPON_ID}/usage?status=REDEEMED`)
      .set(pii.headers);
    expect(full.body.data[0].customer.email).toBe('ananya@example.com');
  });
});

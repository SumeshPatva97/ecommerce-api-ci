/**
 * Customer address book + recently viewed through the real Express app — API_DOCUMENTATION.md
 * §3.2, §2.10, §3.6. MOCKED DB (tests/helpers/mockDb.ts): ownership (IDOR → 404), limits, default
 * handling, audit rows (customer self-service) and the OQ-33 trim; no SQL is executed.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { Decimal } from '../../../../src/lib/money.js';
import { gstinCheckChar } from '../../../../src/lib/tax/gstin.js';
import { createMeAddressesModule } from '../../../../src/modules/me-addresses/index.js';
import { buildModuleTestApp } from '../../../helpers/container.js';

const ADDR = '3c4d5e6f-7a8b-4c9d-8e0f-000000000001';
const OTHER = '3c4d5e6f-7a8b-4c9d-8e0f-000000000002';
const PRODUCT = '3c4d5e6f-7a8b-4c9d-8e0f-000000000003';
const PRODUCT_2 = '3c4d5e6f-7a8b-4c9d-8e0f-000000000004';
const GSTIN_27 = `27ABCDE1234F1Z${gstinCheckChar('27ABCDE1234F1Z')}`;
const BAD_GSTIN_27 = `27ABCDE1234F1Z${GSTIN_27.endsWith('0') ? '1' : '0'}`;

function setup() {
  const t = buildModuleTestApp([createMeAddressesModule]);
  const customer = t.customer();
  return { t, customer, auth: customer.headers };
}

function addressRow(over: Record<string, unknown> = {}) {
  return {
    id: ADDR,
    label: 'HOME',
    fullName: 'Ananya Rao',
    phone: '+919812345678',
    line1: 'Flat 12B, Lotus Residency',
    line2: 'Baner Road',
    landmark: 'Near Balewadi Phata',
    city: 'Pune',
    district: null,
    stateCode: '27',
    postalCode: '411045',
    countryCode: 'IN',
    companyName: null,
    gstin: null,
    isDefault: true,
    createdAt: new Date('2026-11-01T00:00:00.000Z'),
    updatedAt: new Date('2026-11-01T00:00:00.000Z'),
    state: { name: 'Maharashtra' },
    ...over,
  };
}

const body = {
  fullName: 'Ananya Rao',
  phone: '98123 45678',
  line1: 'Flat 12B, Lotus Residency',
  line2: 'Baner Road',
  landmark: 'Near Balewadi Phata',
  city: 'Pune',
  stateCode: '27',
  pincode: '411045',
  country: 'IN',
  addressType: 'HOME',
  gstin: null,
};

describe('GET/POST /me/addresses', () => {
  it('lists the caller’s addresses only', async () => {
    const { t, customer, auth } = setup();
    t.m.userAddress.findMany.mockResolvedValue([addressRow()]);
    const res = await request(t.app).get('/api/v1/me/addresses').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({
      id: ADDR,
      pincode: '411045',
      country: 'IN',
      stateName: 'Maharashtra',
      addressType: 'HOME',
      isDefault: true,
    });
    expect(t.m.userAddress.findMany.mock.calls[0]?.[0].where).toEqual({
      userId: customer.ctx.userId,
    });
  });

  it('creates the first address as default, normalizes the phone and audits CREATE (masked)', async () => {
    const { t, customer, auth } = setup();
    t.m.setting.findUnique.mockResolvedValue(null);
    t.m.state.findUnique.mockResolvedValue({ code: '27' });
    t.m.userAddress.count.mockResolvedValue(0);
    t.m.userAddress.create.mockResolvedValue(addressRow());
    const res = await request(t.app).post('/api/v1/me/addresses').set(auth).send(body);
    expect(res.status).toBe(201);
    const data = t.m.userAddress.create.mock.calls[0]?.[0].data;
    expect(data).toMatchObject({
      userId: customer.ctx.userId,
      phone: '+919812345678',
      postalCode: '411045',
      label: 'HOME',
      isDefault: true,
    });
    expect(t.m.$queryRaw).toHaveBeenCalled(); // user row locked
    expect(t.m.userAddress.updateMany).toHaveBeenCalled(); // previous default cleared
    const audit = t.m.auditLog.create.mock.calls[0]?.[0].data;
    expect(audit).toMatchObject({
      action: 'CREATE',
      module: 'customers',
      entityType: 'UserAddress',
      actorType: 'CUSTOMER',
      actorUserId: customer.ctx.userId,
    });
    const json = JSON.stringify(audit.newValues);
    expect(json).not.toContain('Lotus');
    expect(json).not.toContain('9812345678');
    expect(json).not.toContain('Ananya');
    expect(json).toContain('Pune');
  });

  it('enforces the 20-address limit (R-02) and the state FK', async () => {
    const { t, auth } = setup();
    t.m.setting.findUnique.mockResolvedValue(null);
    t.m.state.findUnique.mockResolvedValue({ code: '27' });
    t.m.userAddress.count.mockResolvedValue(20);
    const full = await request(t.app).post('/api/v1/me/addresses').set(auth).send(body);
    expect(full.status).toBe(422);
    expect(full.body.error.details[0].code).toBe('ADDRESS_LIMIT_REACHED');
    t.m.state.findUnique.mockResolvedValue(null);
    const state = await request(t.app).post('/api/v1/me/addresses').set(auth).send(body);
    expect(state.status).toBe(422);
    expect(state.body.error.details[0]).toMatchObject({
      field: 'stateCode',
      code: 'UNKNOWN_STATE',
    });
  });

  it('validates PIN, phone, country, GSTIN checksum/state prefix and rejects userId', async () => {
    const { t, auth } = setup();
    const res = await request(t.app)
      .post('/api/v1/me/addresses')
      .set(auth)
      .send({ ...body, pincode: '011045', phone: '12345', country: 'US', userId: ADDR });
    expect(res.status).toBe(422);
    const fields = (res.body.error.details as { field?: string }[]).map((d) => d.field);
    expect(fields).toEqual(expect.arrayContaining(['pincode', 'phone', 'country']));
    const wrongState = await request(t.app)
      .post('/api/v1/me/addresses')
      .set(auth)
      .send({ ...body, stateCode: '29', gstin: GSTIN_27 });
    expect(wrongState.status).toBe(422);
    expect(wrongState.body.error.details).toContainEqual({
      field: 'gstin',
      message: 'GSTIN state code must match the address state.',
    });
    const badChecksum = await request(t.app)
      .post('/api/v1/me/addresses')
      .set(auth)
      .send({
        ...body,
        gstin: BAD_GSTIN_27,
      });
    expect(badChecksum.status).toBe(422);
  });
});

describe('PATCH/DELETE /me/addresses/:addressId', () => {
  it("returns 404 for another customer's address (IDOR) on every mutation", async () => {
    const { t, customer, auth } = setup();
    t.m.userAddress.findFirst.mockResolvedValue(null);
    const patch = await request(t.app)
      .patch(`/api/v1/me/addresses/${ADDR}`)
      .set(auth)
      .send({ city: 'Mumbai' });
    const del = await request(t.app).delete(`/api/v1/me/addresses/${ADDR}`).set(auth);
    const def = await request(t.app).post(`/api/v1/me/addresses/${ADDR}/default`).set(auth);
    expect([patch.status, del.status, def.status]).toEqual([404, 404, 404]);
    expect(t.m.userAddress.findFirst.mock.calls[0]?.[0].where).toEqual({
      id: ADDR,
      userId: customer.ctx.userId,
    });
    expect(t.m.userAddress.update).not.toHaveBeenCalled();
    expect(t.m.userAddress.delete).not.toHaveBeenCalled();
  });

  it('updates fields with an UPDATE audit row listing changed field names', async () => {
    const { t, auth } = setup();
    t.m.userAddress.findFirst.mockResolvedValue(addressRow({ isDefault: false }));
    t.m.userAddress.update.mockResolvedValue(addressRow({ city: 'Mumbai', isDefault: true }));
    const res = await request(t.app)
      .patch(`/api/v1/me/addresses/${ADDR}`)
      .set(auth)
      .send({ city: 'Mumbai', line1: 'Flat 9, Sea View', isDefault: true });
    expect(res.status).toBe(200);
    expect(t.m.userAddress.update.mock.calls[0]?.[0].data).toEqual({
      city: 'Mumbai',
      line1: 'Flat 9, Sea View',
      isDefault: true,
    });
    const audit = t.m.auditLog.create.mock.calls[0]?.[0].data;
    expect(audit.action).toBe('UPDATE');
    expect(audit.newValues._event.metadata.changedFields).toEqual(['line1', 'city', 'isDefault']);
    expect(JSON.stringify(audit.newValues)).not.toContain('Sea View');
  });

  it('checks the GSTIN against the merged state and skips no-op updates', async () => {
    const { t, auth } = setup();
    t.m.userAddress.findFirst.mockResolvedValue(addressRow({ gstin: GSTIN_27 }));
    t.m.state.findUnique.mockResolvedValue({ code: '29' });
    const bad = await request(t.app)
      .patch(`/api/v1/me/addresses/${ADDR}`)
      .set(auth)
      .send({ stateCode: '29' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details[0].field).toBe('gstin');
    const same = await request(t.app)
      .patch(`/api/v1/me/addresses/${ADDR}`)
      .set(auth)
      .send({ city: 'Pune' });
    expect(same.status).toBe(200);
    expect(t.m.userAddress.update).not.toHaveBeenCalled();
    const clear = await request(t.app)
      .patch(`/api/v1/me/addresses/${ADDR}`)
      .set(auth)
      .send({ isDefault: false });
    expect(clear.status).toBe(422);
  });

  it('deleting the default promotes the most recent other address', async () => {
    const { t, auth } = setup();
    t.m.userAddress.findFirst
      .mockResolvedValueOnce(addressRow({ isDefault: true }))
      .mockResolvedValueOnce({ id: OTHER });
    const res = await request(t.app).delete(`/api/v1/me/addresses/${ADDR}`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: ADDR, deleted: true });
    expect(t.m.userAddress.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: OTHER }, data: { isDefault: true } }),
    );
    expect(t.m.auditLog.create.mock.calls[0]?.[0].data.action).toBe('DELETE');
  });

  it('sets the default address (clears the previous one)', async () => {
    const { t, auth } = setup();
    t.m.userAddress.findFirst.mockResolvedValue(addressRow({ isDefault: false }));
    t.m.userAddress.update.mockResolvedValue(addressRow({ isDefault: true }));
    const res = await request(t.app).post(`/api/v1/me/addresses/${ADDR}/default`).set(auth);
    expect(res.body.data).toEqual({ id: ADDR, isDefault: true });
    expect(t.m.userAddress.updateMany.mock.calls[0]?.[0].where).toMatchObject({
      isDefault: true,
      id: { not: ADDR },
    });
    expect(t.m.auditLog.create).toHaveBeenCalledTimes(1);
    // already default → no write, no audit
    t.m.userAddress.findFirst.mockResolvedValue(addressRow({ isDefault: true }));
    await request(t.app).post(`/api/v1/me/addresses/${ADDR}/default`).set(auth).expect(200);
    expect(t.m.auditLog.create).toHaveBeenCalledTimes(1);
  });
});

describe('recently viewed (OQ-33)', () => {
  const card = (id: string) => ({
    viewedAt: new Date('2026-11-18T10:00:00.000Z'),
    product: {
      id,
      slug: `p-${id.slice(-1)}`,
      name: 'Tara Silver Ring',
      productType: 'SIMPLE',
      isNewArrival: false,
      isBestSellerPinned: false,
      publishedAt: new Date('2026-10-01T00:00:00.000Z'),
      avgRating: new Decimal(0),
      reviewCount: 0,
      totalSold: 0,
      brand: null,
      category: { id: 'c', name: 'Rings', slug: 'rings' },
      images: [],
      variants: [],
    },
  });

  it('lists listing cards newest first (limit ≤ 20)', async () => {
    const { t, customer, auth } = setup();
    t.m.recentlyViewedProduct.findMany.mockResolvedValue([card(PRODUCT)]);
    const res = await request(t.app).get('/api/v1/me/recently-viewed?limit=5').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({ id: PRODUCT, viewedAt: '2026-11-18T10:00:00.000Z' });
    const args = t.m.recentlyViewedProduct.findMany.mock.calls[0]?.[0];
    expect(args.take).toBe(5);
    expect(args.where.userId).toBe(customer.ctx.userId);
    expect((await request(t.app).get('/api/v1/me/recently-viewed?limit=21').set(auth)).status).toBe(
      422,
    );
  });

  it('records a view (upsert) and trims to the last 20', async () => {
    const { t, auth } = setup();
    t.m.product.findMany.mockResolvedValue([{ id: PRODUCT }]);
    t.m.recentlyViewedProduct.findMany.mockResolvedValue([{ id: 'old-1' }, { id: 'old-2' }]);
    t.m.recentlyViewedProduct.deleteMany.mockResolvedValue({ count: 2 });
    const res = await request(t.app)
      .post('/api/v1/me/recently-viewed')
      .set(auth)
      .send({ productId: PRODUCT });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ recorded: true });
    expect(t.m.recentlyViewedProduct.upsert.mock.calls[0]?.[0].update).toMatchObject({
      viewCount: { increment: 1 },
    });
    expect(t.m.recentlyViewedProduct.findMany.mock.calls[0]?.[0].skip).toBe(20);
    expect(t.m.recentlyViewedProduct.deleteMany.mock.calls[0]?.[0].where).toEqual({
      id: { in: ['old-1', 'old-2'] },
    });
    t.m.product.findMany.mockResolvedValue([]);
    expect(
      (
        await request(t.app)
          .post('/api/v1/me/recently-viewed')
          .set(auth)
          .send({ productId: PRODUCT })
      ).status,
    ).toBe(404);
  });

  it('merges guest views: union, newest wins, future clamped, cap 20', async () => {
    const { t, auth } = setup();
    t.m.product.findMany.mockResolvedValue([{ id: PRODUCT }, { id: PRODUCT_2 }]);
    t.m.recentlyViewedProduct.findMany
      .mockResolvedValueOnce([
        { id: 'row-1', productId: PRODUCT, viewedAt: new Date('2026-11-10T00:00:00.000Z') },
      ])
      .mockResolvedValueOnce([]) // trim
      .mockResolvedValueOnce([card(PRODUCT_2), card(PRODUCT)]); // list
    const res = await request(t.app)
      .post('/api/v1/me/recently-viewed/merge')
      .set(auth)
      .send({
        items: [
          { productId: PRODUCT, viewedAt: '2026-11-12T00:00:00.000Z' },
          { productId: PRODUCT, viewedAt: '2026-11-11T00:00:00.000Z' },
          { productId: PRODUCT_2, viewedAt: '2027-01-01T00:00:00.000Z' },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(t.m.recentlyViewedProduct.update.mock.calls[0]?.[0]).toMatchObject({
      where: { id: 'row-1' },
      data: { viewedAt: new Date('2026-11-12T00:00:00.000Z') },
    });
    expect(t.m.recentlyViewedProduct.create.mock.calls[0]?.[0].data).toMatchObject({
      productId: PRODUCT_2,
      viewedAt: t.now.value,
    });
    const tooMany = Array.from({ length: 21 }, () => ({
      productId: PRODUCT,
      viewedAt: '2026-11-12T00:00:00.000Z',
    }));
    expect(
      (
        await request(t.app)
          .post('/api/v1/me/recently-viewed/merge')
          .set(auth)
          .send({ items: tooMany })
      ).status,
    ).toBe(422);
  });

  it('requires authentication', async () => {
    const { t } = setup();
    expect((await request(t.app).get('/api/v1/me/recently-viewed')).status).toBe(401);
    expect((await request(t.app).get('/api/v1/me/addresses')).status).toBe(401);
  });
});

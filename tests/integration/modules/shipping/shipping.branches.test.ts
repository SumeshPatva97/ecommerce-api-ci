/**
 * Shipping HTTP — branch-level behaviour of methods (public listing, filters, uniqueness, ETA rules,
 * soft delete) and shipments (filters, DTO mapping, create re-checks, provider bookings, update /
 * cancel / tracking rules, multi-event webhooks).
 * MOCKED DB (tests/helpers/mockDb.ts): no SQL runs; assertions target service logic and contracts.
 */
import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import {
  MockShippingProviderAdapter,
  createShippingProviderRegistry,
  signMockShippingWebhook,
  type CreateProviderShipmentInput,
  type CreateProviderShipmentResult,
  type ShippingWebhookEvent,
} from '../../../../src/integrations/shipping/shippingProvider.js';
import { shippingModuleWith } from '../../../../src/modules/shipping/index.js';
import { dedupeHash } from '../../../../src/modules/shipping/shipping.shipments.js';
import { buildModuleTestApp } from '../../../helpers/container.js';

const NOW = new Date('2026-11-19T06:30:00.000Z');
const ALL = ['shipping.view', 'shipping.create', 'shipping.update', 'shipping.delete'];
const ORDER_ID = randomUUID();
const ITEM_ID = randomUUID();
const ITEM_2 = randomUUID();
const SHIPMENT_ID = randomUUID();

function setup(provider: MockShippingProviderAdapter = new MockShippingProviderAdapter()) {
  const factory = shippingModuleWith({ providers: createShippingProviderRegistry([provider]) });
  const t = buildModuleTestApp([factory], { now: NOW });
  t.m.auditLog.create.mockResolvedValue({});
  t.m.notification.findUnique.mockResolvedValue(null);
  const auth = t.staff({ permissions: ALL }).headers;
  return { t, auth, provider };
}

type T = ReturnType<typeof setup>['t'];

function settings(t: T, values: Record<string, unknown>) {
  t.m.setting.findUnique.mockImplementation((args: { where: { settingKey: string } }) =>
    Promise.resolve(
      args.where.settingKey in values ? { value: values[args.where.settingKey] } : null,
    ),
  );
}

function methodRow(over: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    code: 'STANDARD',
    name: 'Standard Delivery',
    nameNormalized: 'standard delivery',
    description: null,
    rateType: 'FLAT',
    baseCharge: '99.00',
    freeAboveAmount: null,
    etaMinDays: 3,
    etaMaxDays: 6,
    codSupported: true,
    codCharge: '49.00',
    isActive: true,
    sortOrder: 0,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...over,
  };
}

function orderRow(over: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    orderNumber: 'ORD-261119-00001',
    status: 'PACKED',
    shippingMethodId: null,
    paymentMethod: 'ONLINE',
    grandTotal: '2499.00',
    shippingAddressSnapshot: { pincode: '411045' },
    items: [
      { id: ITEM_ID, quantity: 2, quantityCancelled: 0 },
      { id: ITEM_2, quantity: 1, quantityCancelled: 0 },
    ],
    shipments: [],
    ...over,
  };
}

function coreRow(over: Record<string, unknown> = {}) {
  return {
    id: SHIPMENT_ID,
    shipmentNumber: 'SHP-261119-00001',
    orderId: ORDER_ID,
    status: 'READY_TO_SHIP',
    provider: 'BlueDart',
    awbNumber: 'AWB123456',
    shippedAt: null,
    deliveredAt: null,
    items: [{ orderItemId: ITEM_ID, quantity: 2 }],
    order: {
      id: ORDER_ID,
      orderNumber: 'ORD-261119-00001',
      userId: randomUUID(),
      grandTotal: '2499.00',
      paymentMethod: 'ONLINE',
      customerPhoneSnapshot: '+919800000000',
      user: { firstName: 'Riya', email: 'riya@example.com', phone: null },
    },
    ...over,
  };
}

function detailRow(over: Record<string, unknown> = {}) {
  return {
    id: SHIPMENT_ID,
    shipmentNumber: 'SHP-261119-00001',
    orderId: ORDER_ID,
    shippingMethodId: null,
    status: 'READY_TO_SHIP',
    provider: 'BlueDart',
    awbNumber: 'AWB123456',
    shippedAt: null,
    deliveredAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    items: [
      {
        shipmentId: SHIPMENT_ID,
        orderItemId: ITEM_ID,
        quantity: 2,
        orderItem: { productName: 'Jhumka', variantName: null, sku: 'EAR-1' },
      },
    ],
    trackingEvents: [],
    order: { id: ORDER_ID, orderNumber: 'ORD-261119-00001', status: 'PACKED' },
    shippingMethod: null,
    ...over,
  };
}

/** `shipment.findUnique`: successive core (select) rows — last one repeats — and a detail row. */
function mockShipment(t: T, cores: object[], detail: object = detailRow()) {
  let i = 0;
  t.m.shipment.findUnique.mockImplementation((args: { select?: unknown }) => {
    if (args.select === undefined) return Promise.resolve(detail);
    const row = cores[Math.min(i, cores.length - 1)];
    i += 1;
    return Promise.resolve(row);
  });
}

/** Order row for `advanceOrderForShipment`; CANCELLED keeps the order untouched (off path). */
function orderForAdvance(status = 'CANCELLED') {
  return {
    id: ORDER_ID,
    orderNumber: 'ORD-261119-00001',
    status,
    userId: randomUUID(),
    grandTotal: '2499.00',
    paymentMethod: 'ONLINE',
    shippedAt: null,
    customerEmailSnapshot: 'riya@example.com',
    customerPhoneSnapshot: null,
    user: { firstName: 'Riya', email: 'riya@example.com', phone: '+919812345678' },
    items: [{ quantity: 2, quantityShipped: 2, quantityCancelled: 0 }],
    shipments: [{ status: 'SHIPPED' }],
  };
}

const notified = (t: T) =>
  t.m.notification.create.mock.calls.map(
    (c) => (c[0] as { data: { event: string; channel: string } }).data,
  );

describe('shipping methods — public listing', () => {
  it('serviceability for an unserviceable pincode has no ETA and no COD', async () => {
    const { t } = setup();
    settings(t, { 'checkout.cod_enabled': true });
    const res = await request(t.app).get('/api/v1/shipping/serviceability?pincode=999999');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      pincode: '999999',
      serviceable: false,
      city: null,
      stateCode: null,
      estimatedDelivery: null,
      codAvailable: false,
    });
  });

  it('serviceable pincode: global threshold for FREE_ABOVE methods, COD per method/setting, no quote without cartValue', async () => {
    const { t } = setup();
    settings(t, {
      'checkout.cod_enabled': true,
      'shipping.free_shipping_threshold': '1000.00',
    });
    t.m.shippingMethod.findMany.mockResolvedValue([
      methodRow({ code: 'FREEBIE', rateType: 'FREE_ABOVE' }),
      methodRow({ code: 'EXPRESS', codSupported: false, description: 'Fast' }),
    ]);
    const res = await request(t.app).get('/api/v1/shipping/methods?pincode=560001');
    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ totalItems: 2, pincode: '560001', serviceable: true });
    expect(res.body.data[0]).toMatchObject({
      code: 'FREEBIE',
      freeAbove: '1000.00',
      codAvailable: true,
      estimatedDays: { min: 3, max: 6 },
    });
    expect(res.body.data[0]).not.toHaveProperty('quote');
    expect(res.body.data[1]).toMatchObject({
      code: 'EXPRESS',
      freeAbove: null,
      codAvailable: false,
      description: 'Fast',
    });
    expect(t.m.shippingMethod.findMany.mock.calls[0]?.[0].where).toEqual({
      isActive: true,
      deletedAt: null,
    });
  });

  it('provider outage still lists methods (serviceable null, COD off) and quotes the cart', async () => {
    const { t } = setup(new MockShippingProviderAdapter({ failServiceability: true }));
    settings(t, { 'checkout.cod_enabled': true });
    t.m.shippingMethod.findMany.mockResolvedValue([methodRow()]);
    const res = await request(t.app).get(
      '/api/v1/shipping/methods?pincode=411045&cartValue=100.00',
    );
    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ pincode: '411045', serviceable: null });
    expect(res.body.data[0]).toMatchObject({
      codAvailable: false,
      quote: { charge: '99.00', payable: '99.00', isFree: false },
    });
    expect((await request(t.app).get('/api/v1/shipping/methods?cartValue=abc')).status).toBe(422);
  });
});

describe('shipping methods — admin CRUD', () => {
  it('GET list maps ACTIVE / INACTIVE / DELETED / q filters', async () => {
    const { t, auth } = setup();
    t.m.shippingMethod.findMany.mockResolvedValue([methodRow({ deletedAt: NOW, isActive: false })]);
    t.m.shippingMethod.count.mockResolvedValue(1);
    const cases: [string, Record<string, unknown>][] = [
      ['status=DELETED', { deletedAt: { not: null } }],
      ['status=ACTIVE', { deletedAt: null, isActive: true }],
      ['status=INACTIVE', { deletedAt: null, isActive: false }],
      [
        'q=std',
        { deletedAt: null, OR: [{ name: { contains: 'std' } }, { code: { contains: 'std' } }] },
      ],
      ['', { deletedAt: null }],
    ];
    for (const [qs, where] of cases) {
      t.m.shippingMethod.findMany.mockClear();
      const res = await request(t.app).get(`/api/v1/admin/shipping/methods?${qs}`).set(auth);
      expect(res.status, qs).toBe(200);
      expect(t.m.shippingMethod.findMany.mock.calls[0]?.[0].where, qs).toEqual(where);
    }
    const res = await request(t.app).get('/api/v1/admin/shipping/methods').set(auth);
    expect(res.body.data[0]).toMatchObject({ status: 'INACTIVE', deleted: true, freeAbove: null });
  });

  it('GET /:id returns the DTO or 404; viewer cannot create', async () => {
    const { t, auth } = setup();
    const row = methodRow({ freeAboveAmount: '4999.00' });
    t.m.shippingMethod.findUnique.mockResolvedValueOnce(row);
    const res = await request(t.app).get(`/api/v1/admin/shipping/methods/${row.id}`).set(auth);
    expect(res.body.data).toMatchObject({
      id: row.id,
      charge: '99.00',
      freeAbove: '4999.00',
      codAllowed: true,
      codCharge: '49.00',
      status: 'ACTIVE',
      deleted: false,
    });
    t.m.shippingMethod.findUnique.mockResolvedValueOnce(null);
    expect(
      (await request(t.app).get(`/api/v1/admin/shipping/methods/${row.id}`).set(auth)).status,
    ).toBe(404);
    const viewer = t.staff({ permissions: ['shipping.view'] }).headers;
    expect(
      (
        await request(t.app)
          .post('/api/v1/admin/shipping/methods')
          .set(viewer)
          .send({ code: 'X', name: 'X', charge: '1' })
      ).status,
    ).toBe(403);
  });

  it('POST: duplicate name → 409 (field name); ETA order and strict body are validated; optional fields stored', async () => {
    const { t, auth } = setup();
    t.m.shippingMethod.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(methodRow({ code: 'OTHER' }));
    const dup = await request(t.app)
      .post('/api/v1/admin/shipping/methods')
      .set(auth)
      .send({ code: 'NEW', name: 'Standard  Delivery', charge: '10.00' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.details[0]).toMatchObject({ field: 'name', code: 'DUPLICATE' });

    const eta = await request(t.app).post('/api/v1/admin/shipping/methods').set(auth).send({
      code: 'NEW',
      name: 'New',
      charge: '10.00',
      estimatedDaysMin: 5,
      estimatedDaysMax: 2,
    });
    expect(eta.status).toBe(422);
    const strict = await request(t.app)
      .post('/api/v1/admin/shipping/methods')
      .set(auth)
      .send({ code: 'NEW', name: 'New', charge: '10.00', extra: true });
    expect(strict.status).toBe(422);

    t.m.shippingMethod.findUnique.mockResolvedValue(null);
    t.m.shippingMethod.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve(methodRow(data)),
    );
    const ok = await request(t.app).post('/api/v1/admin/shipping/methods').set(auth).send({
      code: 'cod_plus',
      name: 'COD Plus',
      description: 'Pay on delivery',
      rateType: 'FREE_ABOVE',
      charge: '59.00',
      estimatedDaysMin: 2,
      estimatedDaysMax: 5,
      codAllowed: true,
      codCharge: '30.00',
      status: 'INACTIVE',
      sortOrder: 9,
    });
    expect(ok.status).toBe(201);
    expect(t.m.shippingMethod.create.mock.calls[0]?.[0].data).toMatchObject({
      code: 'COD_PLUS',
      nameNormalized: 'cod plus',
      description: 'Pay on delivery',
      rateType: 'FREE_ABOVE',
      freeAboveAmount: null,
      etaMinDays: 2,
      etaMaxDays: 5,
      codSupported: true,
      codCharge: '30.00',
      isActive: false,
      sortOrder: 9,
    });
  });

  it('PATCH: 404 for missing/deleted, 409 for another method’s code, own code/name allowed', async () => {
    const { t, auth } = setup();
    const row = methodRow();
    const url = `/api/v1/admin/shipping/methods/${row.id}`;
    t.m.shippingMethod.findUnique.mockResolvedValueOnce(null);
    expect((await request(t.app).patch(url).set(auth).send({ sortOrder: 1 })).status).toBe(404);
    t.m.shippingMethod.findUnique.mockResolvedValueOnce(methodRow({ deletedAt: NOW }));
    expect((await request(t.app).patch(url).set(auth).send({ sortOrder: 1 })).status).toBe(404);

    t.m.shippingMethod.findUnique
      .mockResolvedValueOnce(row)
      .mockResolvedValueOnce(methodRow({ code: 'EXPRESS' }));
    const clash = await request(t.app).patch(url).set(auth).send({ code: 'EXPRESS' });
    expect(clash.status).toBe(409);
    expect(clash.body.error.details[0].field).toBe('code');

    t.m.shippingMethod.findUnique.mockReset();
    t.m.shippingMethod.findUnique.mockResolvedValue(row); // every lookup finds itself
    t.m.shippingMethod.update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ ...row, ...data }),
    );
    const own = await request(t.app)
      .patch(url)
      .set(auth)
      .send({ code: 'STANDARD', name: 'Standard Delivery' });
    expect(own.status).toBe(200);
    expect(t.m.shippingMethod.update.mock.calls[0]?.[0].data).toEqual({
      code: 'STANDARD',
      name: 'Standard Delivery',
      nameNormalized: 'standard delivery',
    });
  });

  it('PATCH: ETA checked against stored values; all fields written; status-only → STATUS_CHANGE', async () => {
    const { t, auth } = setup();
    const row = methodRow({ etaMinDays: 3, etaMaxDays: 6 });
    const url = `/api/v1/admin/shipping/methods/${row.id}`;
    t.m.shippingMethod.findUnique.mockImplementation((args: { where: { id?: string } }) =>
      Promise.resolve(args.where.id === row.id ? row : null),
    );
    const tooHigh = await request(t.app).patch(url).set(auth).send({ estimatedDaysMin: 9 });
    expect(tooHigh.status).toBe(422);
    expect(tooHigh.body.error.details[0].field).toBe('estimatedDaysMax');
    const tooLow = await request(t.app).patch(url).set(auth).send({ estimatedDaysMax: 1 });
    expect(tooLow.status).toBe(422);

    t.m.shippingMethod.update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ ...row, ...data }),
    );
    const full = await request(t.app).patch(url).set(auth).send({
      name: 'Standard Plus',
      description: null,
      rateType: 'FREE_ABOVE',
      charge: '79.00',
      freeAbove: null,
      estimatedDaysMin: null,
      estimatedDaysMax: 10,
      codAllowed: false,
      codCharge: '0.00',
      sortOrder: 2,
      status: 'ACTIVE',
    });
    expect(full.status).toBe(200);
    expect(t.m.shippingMethod.update.mock.calls[0]?.[0].data).toEqual({
      name: 'Standard Plus',
      nameNormalized: 'standard plus',
      description: null,
      rateType: 'FREE_ABOVE',
      baseCharge: '79.00',
      freeAboveAmount: null,
      etaMinDays: null,
      etaMaxDays: 10,
      codSupported: false,
      codCharge: '0.00',
      isActive: true,
      sortOrder: 2,
    });
    expect(t.m.auditLog.create.mock.calls.at(-1)?.[0].data.action).toBe('UPDATE');

    const off = await request(t.app).patch(url).set(auth).send({ status: 'INACTIVE' });
    expect(off.status).toBe(200);
    expect(t.m.shippingMethod.update.mock.calls[1]?.[0].data).toEqual({ isActive: false });
    expect(t.m.auditLog.create.mock.calls.at(-1)?.[0].data.action).toBe('STATUS_CHANGE');
  });

  it('DELETE: unused method is soft-deleted and deactivated; missing/deleted → 404', async () => {
    const { t, auth } = setup();
    const row = methodRow();
    const url = `/api/v1/admin/shipping/methods/${row.id}`;
    t.m.shippingMethod.findUnique.mockResolvedValueOnce(row);
    t.m.order.count.mockResolvedValue(0);
    t.m.shippingMethod.update.mockResolvedValue({ ...row, deletedAt: NOW, isActive: false });
    const res = await request(t.app).delete(url).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: row.id, deleted: true });
    expect(t.m.shippingMethod.update.mock.calls[0]?.[0].data).toEqual({
      deletedAt: NOW,
      isActive: false,
    });
    expect(t.m.auditLog.create.mock.calls.at(-1)?.[0].data.action).toBe('DELETE');

    t.m.shippingMethod.findUnique.mockResolvedValueOnce(null);
    expect((await request(t.app).delete(url).set(auth)).status).toBe(404);
    t.m.shippingMethod.findUnique.mockResolvedValueOnce(methodRow({ deletedAt: NOW }));
    expect((await request(t.app).delete(url).set(auth)).status).toBe(404);
    expect(t.m.shippingMethod.update).toHaveBeenCalledTimes(1);
  });
});

describe('shipments — list & detail', () => {
  it('GET /admin/shipments builds filters (status/order/courier/q/date range)', async () => {
    const { t, auth } = setup();
    t.m.shipment.findMany.mockResolvedValue([]);
    t.m.shipment.count.mockResolvedValue(0);
    const res = await request(t.app)
      .get(
        `/api/v1/admin/shipments?status=SHIPPED&orderId=${ORDER_ID}&courier=Blue&q=awb1&from=2026-11-01&to=2026-11-19`,
      )
      .set(auth);
    expect(res.status).toBe(200);
    const where = t.m.shipment.findMany.mock.calls[0]?.[0].where;
    expect(where).toMatchObject({
      status: 'SHIPPED',
      orderId: ORDER_ID,
      provider: { contains: 'Blue' },
      OR: [
        { awbNumber: { contains: 'AWB1' } },
        { shipmentNumber: { contains: 'AWB1' } },
        { order: { orderNumber: { contains: 'AWB1' } } },
      ],
    });
    expect(where.createdAt.gte).toBeInstanceOf(Date);
    expect(where.createdAt.lt).toBeInstanceOf(Date);
    const range = where.createdAt as { gte: Date; lt: Date };
    expect(range.lt.getTime()).toBeGreaterThan(range.gte.getTime());

    t.m.shipment.findMany.mockClear();
    await request(t.app).get('/api/v1/admin/shipments?from=2026-11-01').set(auth);
    expect(t.m.shipment.findMany.mock.calls[0]?.[0].where.createdAt).toEqual({
      gte: expect.any(Date),
    });
    t.m.shipment.findMany.mockClear();
    await request(t.app).get('/api/v1/admin/shipments?to=2026-11-19').set(auth);
    expect(t.m.shipment.findMany.mock.calls[0]?.[0].where.createdAt).toEqual({
      lt: expect.any(Date),
    });
    t.m.shipment.findMany.mockClear();
    await request(t.app).get('/api/v1/admin/shipments').set(auth);
    expect(t.m.shipment.findMany.mock.calls[0]?.[0].where).toEqual({});
    expect((await request(t.app).get('/api/v1/admin/shipments?q=a').set(auth)).status).toBe(422);
    expect(
      (await request(t.app).get('/api/v1/admin/shipments?from=19-11-2026').set(auth)).status,
    ).toBe(422);
  });

  it('list DTO splits provider bookings, derives tracking URLs and handles nulls', async () => {
    const { t, auth } = setup();
    const base = {
      shipmentNumber: 'SHP-261119-00001',
      orderId: ORDER_ID,
      shippingMethodId: null,
      createdAt: NOW,
      updatedAt: NOW,
      order: { id: ORDER_ID, orderNumber: 'ORD-261119-00001' },
      _count: { items: 2 },
    };
    t.m.shipment.findMany.mockResolvedValue([
      {
        ...base,
        id: 'a',
        status: 'SHIPPED',
        provider: 'mock:MockExpress',
        awbNumber: 'MOCK1',
        shippedAt: NOW,
        deliveredAt: null,
      },
      {
        ...base,
        id: 'b',
        status: 'PENDING',
        provider: null,
        awbNumber: null,
        shippedAt: null,
        deliveredAt: null,
      },
      {
        ...base,
        id: 'c',
        status: 'DELIVERED',
        provider: 'acme:Ground',
        awbNumber: 'X1',
        shippedAt: NOW,
        deliveredAt: NOW,
      },
    ]);
    t.m.shipment.count.mockResolvedValue(3);
    const res = await request(t.app).get('/api/v1/admin/shipments').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      expect.objectContaining({
        id: 'a',
        courier: 'MockExpress',
        trackingUrl: 'https://tracking.example.com/mock/MOCK1',
        itemCount: 2,
        shippedAt: NOW.toISOString(),
        deliveredAt: null,
      }),
      expect.objectContaining({ id: 'b', courier: null, awb: null, trackingUrl: null }),
      expect.objectContaining({
        id: 'c',
        courier: 'acme:Ground', // unknown adapter prefix → kept as a plain courier name
        trackingUrl: 'https://tracking.example.com/mock/X1',
        deliveredAt: NOW.toISOString(),
      }),
    ]);
    expect(res.body.meta.totalItems).toBe(3);
  });

  it('GET /admin/shipments/:id maps events, method, bookedVia and allowed transitions; 404 otherwise', async () => {
    const { t, auth } = setup();
    const methodId = randomUUID();
    t.m.shipment.findUnique.mockResolvedValueOnce(
      detailRow({
        status: 'SHIPPED',
        provider: 'mock:MockExpress',
        shippedAt: NOW,
        shippingMethod: { id: methodId, code: 'STANDARD', name: 'Standard' },
        trackingEvents: [
          {
            id: 'e1',
            mappedStatus: 'SHIPPED',
            providerStatus: 'picked_up',
            message: 'Picked up',
            location: 'Pune',
            source: 'WEBHOOK',
            eventAt: NOW,
          },
        ],
      }),
    );
    const res = await request(t.app).get(`/api/v1/admin/shipments/${SHIPMENT_ID}`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      courier: 'MockExpress',
      bookedVia: 'mock',
      shippingMethod: { id: methodId, code: 'STANDARD' },
      items: [{ orderItemId: ITEM_ID, productName: 'Jhumka', variantName: null, sku: 'EAR-1' }],
      events: [
        {
          id: 'e1',
          status: 'SHIPPED',
          providerStatus: 'picked_up',
          description: 'Picked up',
          location: 'Pune',
          source: 'WEBHOOK',
          at: NOW.toISOString(),
        },
      ],
      allowedTransitions: [
        'IN_TRANSIT',
        'OUT_FOR_DELIVERY',
        'DELIVERED',
        'DELIVERY_FAILED',
        'RTO_INITIATED',
      ],
      shippedAt: NOW.toISOString(),
    });
    t.m.shipment.findUnique.mockResolvedValueOnce(null);
    const missing = await request(t.app).get(`/api/v1/admin/shipments/${SHIPMENT_ID}`).set(auth);
    expect(missing.status).toBe(404);
  });
});

describe('shipments — create', () => {
  const post = (t: T, auth: Record<string, string>, body: Record<string, unknown>) =>
    request(t.app)
      .post('/api/v1/admin/shipments')
      .set(auth)
      .send({ orderId: ORDER_ID, packageWeightGrams: 250, ...body });

  it('validates body refinements, unknown orders and full shipments of PROCESSING orders', async () => {
    const { t, auth } = setup();
    expect((await post(t, auth, {})).body.error.details[0].field).toBe('courier');
    const awbWithProvider = await post(t, auth, { createWithProvider: true, awb: 'ABCDEF1' });
    expect(awbWithProvider.status).toBe(422);
    expect(awbWithProvider.body.error.details[0].field).toBe('awb');

    t.m.order.findUnique.mockResolvedValueOnce(null);
    expect((await post(t, auth, { courier: 'BlueDart' })).status).toBe(404);

    t.m.order.findUnique.mockResolvedValueOnce(orderRow({ status: 'PROCESSING' }));
    const full = await post(t, auth, { courier: 'BlueDart' });
    expect(full.status).toBe(409);
    expect(full.body.error.message).toMatch(/must be packed/);

    t.m.order.findUnique.mockResolvedValueOnce(orderRow({ status: 'SHIPPED' }));
    const partialWrong = await post(t, auth, {
      courier: 'BlueDart',
      items: [{ orderItemId: ITEM_ID, quantity: 1 }],
    });
    expect(partialWrong.status).toBe(409);
    expect(partialWrong.body.error.message).toMatch(/packed or processing/);

    t.m.order.findUnique.mockResolvedValueOnce(orderRow());
    const foreign = await post(t, auth, {
      courier: 'BlueDart',
      items: [{ orderItemId: randomUUID(), quantity: 1 }],
    });
    expect(foreign.status).toBe(422);
    expect(t.m.shipment.create).not.toHaveBeenCalled();
  });

  it('partial shipment of a PROCESSING order without AWB is PENDING and uses the order’s method', async () => {
    const { t, auth } = setup();
    const orderMethod = randomUUID();
    t.m.order.findUnique.mockResolvedValue(
      orderRow({ status: 'PROCESSING', shippingMethodId: orderMethod }),
    );
    t.m.shipment.findUnique.mockResolvedValue(detailRow({ status: 'PENDING', awbNumber: null }));
    const res = await post(t, auth, {
      courier: 'Delhivery',
      items: [{ orderItemId: ITEM_2, quantity: 1 }],
    });
    expect(res.status).toBe(201);
    expect(t.m.shipment.findFirst).not.toHaveBeenCalled(); // no AWB → no clash check
    expect(t.m.shipment.create.mock.calls[0]?.[0].data).toMatchObject({
      status: 'PENDING',
      awbNumber: null,
      provider: 'Delhivery',
      shippingMethodId: orderMethod,
    });
    expect(t.m.shipmentItem.createMany.mock.calls[0]?.[0].data).toEqual([
      expect.objectContaining({ orderItemId: ITEM_2, quantity: 1 }),
    ]);
    expect(res.body.data.trackingUrl).toBeNull();
    const audit = t.m.auditLog.create.mock.calls[0]?.[0].data;
    expect(audit).toMatchObject({ action: 'CREATE', module: 'shipping' });
  });

  it('explicit shippingMethodId must exist and not be deleted', async () => {
    const { t, auth } = setup();
    const methodId = randomUUID();
    t.m.order.findUnique.mockResolvedValue(orderRow());
    t.m.shippingMethod.findUnique.mockResolvedValueOnce(null);
    const missing = await post(t, auth, { courier: 'BlueDart', shippingMethodId: methodId });
    expect(missing.status).toBe(422);
    expect(missing.body.error.details[0].field).toBe('shippingMethodId');
    t.m.shippingMethod.findUnique.mockResolvedValueOnce({ id: methodId, deletedAt: NOW });
    expect((await post(t, auth, { courier: 'BlueDart', shippingMethodId: methodId })).status).toBe(
      422,
    );

    t.m.shippingMethod.findUnique.mockResolvedValueOnce({ id: methodId, deletedAt: null });
    t.m.shipment.findUnique.mockResolvedValue(detailRow());
    const ok = await post(t, auth, { courier: 'BlueDart', shippingMethodId: methodId });
    expect(ok.status).toBe(201);
    expect(t.m.shipment.create.mock.calls[0]?.[0].data.shippingMethodId).toBe(methodId);
  });

  it('AWB already used by the same courier → 409 DUPLICATE', async () => {
    const { t, auth } = setup();
    t.m.order.findUnique.mockResolvedValue(orderRow());
    t.m.shipment.findFirst.mockResolvedValue({ id: randomUUID() });
    const res = await post(t, auth, { courier: 'BlueDart', awb: 'awb999999' });
    expect(res.status).toBe(409);
    expect(res.body.error.details[0]).toMatchObject({ field: 'awb', code: 'DUPLICATE' });
    expect(t.m.shipment.findFirst.mock.calls[0]?.[0].where).toEqual({
      awbNumber: 'AWB999999',
      provider: 'BlueDart',
    });
  });

  it('order changed between preview and lock → re-check fails inside the transaction', async () => {
    const { t, auth } = setup();
    t.m.order.findUnique
      .mockResolvedValueOnce(orderRow())
      .mockResolvedValueOnce(orderRow({ status: 'CANCELLED' }));
    const res = await post(t, auth, { courier: 'BlueDart' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect(t.m.shipment.create).not.toHaveBeenCalled();
  });

  it('provider booking passes COD amount, blank pincode and dimensions; stores adapter:courier', async () => {
    class SpyProvider extends MockShippingProviderAdapter {
      readonly inputs: CreateProviderShipmentInput[] = [];
      override createShipment(
        input: CreateProviderShipmentInput,
      ): Promise<CreateProviderShipmentResult> {
        this.inputs.push(input);
        return super.createShipment(input);
      }
    }
    const spy = new SpyProvider();
    const { t, auth } = setup(spy);
    t.m.order.findUnique.mockResolvedValue(
      orderRow({ paymentMethod: 'COD', shippingAddressSnapshot: { line1: 'no pin' } }),
    );
    t.m.shipment.findFirst.mockResolvedValue(null);
    t.m.shipment.findUnique.mockResolvedValue(detailRow({ provider: 'mock:MockExpress' }));
    const dims = { l: 10, w: 8, h: 4 };
    const res = await post(t, auth, { createWithProvider: true, dimensionsCm: dims });
    expect(res.status).toBe(201);
    expect(spy.inputs[0]).toEqual({
      reference: 'ORD-261119-00001',
      pincode: '',
      weightGrams: 250,
      dimensionsCm: dims,
      codAmount: '2499.00',
    });
    expect(t.m.shipment.create.mock.calls[0]?.[0].data).toMatchObject({
      provider: 'mock:MockExpress',
      awbNumber: 'MOCK0000000001',
      status: 'READY_TO_SHIP',
    });
    expect(t.m.auditLog.create.mock.calls[0]?.[0].data).toBeDefined();
    expect(res.body.data).toMatchObject({ courier: 'MockExpress', bookedVia: 'mock' });
    expect(spy.cancelled).toEqual([]);
  });

  it('a failing best-effort cancel of an orphaned booking does not mask the original error', async () => {
    class FlakyCancel extends MockShippingProviderAdapter {
      override cancelShipment(awb: string): Promise<void> {
        this.cancelled.push(awb);
        return Promise.reject(new Error('provider down'));
      }
    }
    const flaky = new FlakyCancel();
    const { t, auth } = setup(flaky);
    t.m.order.findUnique.mockResolvedValue(orderRow());
    t.m.shipment.findFirst.mockResolvedValue({ id: randomUUID() }); // AWB clash inside the tx
    const res = await post(t, auth, { createWithProvider: true });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_RESOURCE');
    expect(flaky.cancelled).toEqual(['MOCK0000000001']);
  });
});

describe('shipments — update', () => {
  const patch = (t: T, auth: Record<string, string>, body: Record<string, unknown>) =>
    request(t.app).patch(`/api/v1/admin/shipments/${SHIPMENT_ID}`).set(auth).send(body);

  it('404 for unknown shipment; empty body 422', async () => {
    const { t, auth } = setup();
    t.m.shipment.findUnique.mockResolvedValue(null);
    expect((await patch(t, auth, { status: 'SHIPPED' })).status).toBe(404);
    expect((await patch(t, auth, { note: 'only a note' })).status).toBe(422);
  });

  it('courier/AWB cannot change after dispatch', async () => {
    const { t, auth } = setup();
    mockShipment(t, [coreRow({ status: 'SHIPPED', shippedAt: NOW })]);
    const res = await patch(t, auth, { awb: 'NEWAWB999' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/after dispatch/);
    expect(t.m.shipment.update).not.toHaveBeenCalled();
  });

  it('adding an AWB to a PENDING shipment auto-moves it to READY_TO_SHIP (audited UPDATE)', async () => {
    const { t, auth } = setup();
    mockShipment(t, [coreRow({ status: 'PENDING', awbNumber: null })]);
    t.m.shipment.findFirst.mockResolvedValue(null);
    const res = await patch(t, auth, { awb: 'newawb777', note: 'Booked manually' });
    expect(res.status).toBe(200);
    expect(t.m.shipment.findFirst.mock.calls[0]?.[0].where).toEqual({
      awbNumber: 'NEWAWB777',
      provider: 'BlueDart',
      id: { not: SHIPMENT_ID },
    });
    expect(t.m.shipment.update.mock.calls[0]?.[0].data).toEqual({
      provider: 'BlueDart',
      awbNumber: 'NEWAWB777',
      status: 'READY_TO_SHIP',
    });
    expect(t.m.auditLog.create.mock.calls[0]?.[0].data).toMatchObject({
      action: 'UPDATE',
      reason: 'Booked manually',
    });
    expect(t.m.shipmentTrackingEvent.create).not.toHaveBeenCalled();
  });

  it('courier-only change without an AWB skips the clash check and keeps the status', async () => {
    const { t, auth } = setup();
    mockShipment(t, [coreRow({ status: 'PENDING', awbNumber: null })]);
    const res = await patch(t, auth, { courier: 'Delhivery' });
    expect(res.status).toBe(200);
    expect(t.m.shipment.findFirst).not.toHaveBeenCalled();
    expect(t.m.shipment.update.mock.calls[0]?.[0].data).toEqual({
      provider: 'Delhivery',
      awbNumber: null,
    });
  });

  it('AWB clash on update → 409', async () => {
    const { t, auth } = setup();
    mockShipment(t, [coreRow()]);
    t.m.shipment.findFirst.mockResolvedValue({ id: randomUUID() });
    const res = await patch(t, auth, { awb: 'TAKEN12345', courier: 'Ekart' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_RESOURCE');
  });

  it('AWB + SHIPPED in one call: AWB stored first (no auto-ready), then dispatched', async () => {
    const { t, auth } = setup();
    mockShipment(t, [
      coreRow({ status: 'PENDING', awbNumber: null }),
      coreRow({ status: 'PENDING', awbNumber: null }),
      coreRow({ status: 'PENDING', awbNumber: 'FRESH12345' }),
    ]);
    t.m.shipment.findFirst.mockResolvedValue(null);
    t.m.order.findUnique.mockResolvedValue(orderForAdvance());
    const res = await patch(t, auth, { awb: 'FRESH12345', status: 'SHIPPED' });
    expect(res.status).toBe(200);
    expect(t.m.shipment.update.mock.calls[0]?.[0].data).toEqual({
      provider: 'BlueDart',
      awbNumber: 'FRESH12345',
    });
    expect(t.m.shipment.update.mock.calls[1]?.[0].data).toEqual({
      status: 'SHIPPED',
      shippedAt: NOW,
    });
    expect(t.m.shipmentTrackingEvent.create.mock.calls[0]?.[0].data).toMatchObject({
      mappedStatus: 'SHIPPED',
      message: 'Status updated by staff',
      source: 'STAFF',
    });
    // phone falls back to the order snapshot when the account has none
    const shipped = notified(t).filter((n) => n.event === 'ORDER_SHIPPED');
    expect(shipped.map((n) => n.channel)).toEqual(['EMAIL', 'WHATSAPP']);
    expect(t.m.notification.create.mock.calls[1]?.[0].data.recipientAddress).toBe('+919800000000');
  });

  it('status equal to the current one only applies the courier change', async () => {
    const { t, auth } = setup();
    mockShipment(t, [coreRow()]);
    t.m.shipment.findFirst.mockResolvedValue(null);
    const res = await patch(t, auth, { status: 'READY_TO_SHIP', courier: 'Ekart' });
    expect(res.status).toBe(200);
    expect(t.m.shipment.update).toHaveBeenCalledTimes(1);
    expect(t.m.shipmentTrackingEvent.create).not.toHaveBeenCalled();
  });

  it('shipment changed meanwhile → 409 CONFLICT inside the transaction', async () => {
    const { t, auth } = setup();
    mockShipment(t, [coreRow(), coreRow({ status: 'SHIPPED', shippedAt: NOW })]);
    const res = await patch(t, auth, { status: 'CANCELLED' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('cancelling a provider booking cancels with the adapter first; plain couriers are not called', async () => {
    const { t, auth, provider } = setup();
    mockShipment(t, [coreRow({ provider: 'mock:MockExpress', awbNumber: 'MOCK0000000042' })]);
    t.m.order.findUnique.mockResolvedValue(orderForAdvance());
    const res = await patch(t, auth, { status: 'CANCELLED', note: 'Customer cancelled' });
    expect(res.status).toBe(200);
    expect(provider.cancelled).toEqual(['MOCK0000000042']);
    expect(t.m.shipment.update.mock.calls[0]?.[0].data).toEqual({ status: 'CANCELLED' });
    expect(t.m.shipmentTrackingEvent.create.mock.calls[0]?.[0].data.message).toBe(
      'Customer cancelled',
    );
    expect(t.m.orderItem.update).not.toHaveBeenCalled();
    expect(t.m.notification.create).not.toHaveBeenCalled();

    const other = setup();
    mockShipment(other.t, [coreRow({ status: 'PENDING', awbNumber: null })]);
    other.t.m.order.findUnique.mockResolvedValue(orderForAdvance());
    expect((await patch(other.t, other.auth, { status: 'CANCELLED' })).status).toBe(200);
    expect(other.provider.cancelled).toEqual([]);
  });

  it('OUT_FOR_DELIVERY on a COD order notifies with codAmount; DELIVERED stamps deliveredAt', async () => {
    const { t, auth } = setup();
    const core = coreRow({ status: 'SHIPPED', shippedAt: NOW });
    mockShipment(t, [{ ...core, order: { ...core.order, paymentMethod: 'COD' } }]);
    t.m.order.findUnique.mockResolvedValue(orderForAdvance());
    const ofd = await patch(t, auth, { status: 'OUT_FOR_DELIVERY' });
    expect(ofd.status).toBe(200);
    expect(t.m.shipment.update.mock.calls[0]?.[0].data).toEqual({ status: 'OUT_FOR_DELIVERY' });
    const events = notified(t);
    expect(events.map((e) => e.event)).toEqual([
      'ORDER_OUT_FOR_DELIVERY',
      'ORDER_OUT_FOR_DELIVERY',
    ]);
    const payload = t.m.notification.create.mock.calls[0]?.[0].data.payload;
    expect(payload.variables).toMatchObject({ codAmount: '2499.00', courier: 'BlueDart' });
    // DF-03 (§4.11): COD out-for-delivery uses the COD template variant on both channels.
    for (const call of t.m.notification.create.mock.calls) {
      expect(call[0].data.payload.variant).toBe('COD');
    }

    const d = setup();
    mockShipment(d.t, [coreRow({ status: 'OUT_FOR_DELIVERY', shippedAt: NOW })]);
    d.t.m.order.findUnique.mockResolvedValue(orderForAdvance());
    expect((await patch(d.t, d.auth, { status: 'DELIVERED' })).status).toBe(200);
    expect(d.t.m.shipment.update.mock.calls[0]?.[0].data).toEqual({
      status: 'DELIVERED',
      deliveredAt: NOW,
    });
    expect(d.t.m.notification.create).not.toHaveBeenCalled();
  });

  it('first dispatch straight to OUT_FOR_DELIVERY queues both ORDER_SHIPPED and OFD (online: no codAmount)', async () => {
    const { t, auth } = setup();
    mockShipment(t, [coreRow()]);
    t.m.order.findUnique.mockResolvedValue(orderForAdvance());
    const res = await patch(t, auth, { status: 'OUT_FOR_DELIVERY' });
    expect(res.status).toBe(200);
    expect(notified(t).map((e) => e.event)).toEqual([
      'ORDER_SHIPPED',
      'ORDER_SHIPPED',
      'ORDER_OUT_FOR_DELIVERY',
      'ORDER_OUT_FOR_DELIVERY',
    ]);
    const ofd = t.m.notification.create.mock.calls[2]?.[0].data.payload.variables;
    expect(ofd).not.toHaveProperty('codAmount');
    expect(t.m.notification.create.mock.calls[2]?.[0].data.payload).not.toHaveProperty('variant');
    expect(t.m.orderItem.update).toHaveBeenCalledTimes(1);
  });
});

describe('shipments — manual tracking events', () => {
  const postEvent = (t: T, auth: Record<string, string>, body: Record<string, unknown>) =>
    request(t.app)
      .post(`/api/v1/admin/shipments/${SHIPMENT_ID}/tracking-events`)
      .set(auth)
      .send({ description: 'Update', occurredAt: '2026-11-19T06:00:00.000Z', ...body });

  it('invalid event for the shipment state → 409; unknown shipment → 404', async () => {
    const { t, auth } = setup();
    mockShipment(t, [coreRow({ status: 'DELIVERED', shippedAt: NOW })]);
    const res = await postEvent(t, auth, { status: 'IN_TRANSIT' });
    expect(res.status).toBe(409);
    expect(res.body.error.details[0].meta.allowed).toEqual([]);

    t.m.shipment.findUnique.mockResolvedValue(null);
    expect((await postEvent(t, auth, { status: 'IN_TRANSIT' })).status).toBe(404);
  });

  it('same-status event is recorded without a status change (location defaults to null)', async () => {
    const { t, auth } = setup();
    mockShipment(t, [coreRow({ status: 'IN_TRANSIT', shippedAt: NOW })]);
    t.m.shipmentTrackingEvent.findUnique.mockResolvedValue(null);
    t.m.shipmentTrackingEvent.findFirst.mockResolvedValue(null);
    const res = await postEvent(t, auth, { status: 'IN_TRANSIT' });
    expect(res.status).toBe(201);
    expect(t.m.shipmentTrackingEvent.create.mock.calls[0]?.[0].data).toMatchObject({
      mappedStatus: 'IN_TRANSIT',
      location: null,
      providerStatus: null,
      source: 'STAFF',
    });
    expect(t.m.shipment.update).not.toHaveBeenCalled();
  });

  it('an event older than the latest one is stored but does not move the status', async () => {
    const { t, auth } = setup();
    mockShipment(t, [coreRow({ status: 'SHIPPED', shippedAt: NOW })]);
    t.m.shipmentTrackingEvent.findUnique.mockResolvedValue(null);
    t.m.shipmentTrackingEvent.findFirst.mockResolvedValue({ eventAt: NOW });
    const res = await postEvent(t, auth, {
      status: 'IN_TRANSIT',
      occurredAt: '2026-11-19T05:00:00.000Z',
    });
    expect(res.status).toBe(201);
    expect(t.m.shipmentTrackingEvent.create).toHaveBeenCalledTimes(1);
    expect(t.m.shipment.update).not.toHaveBeenCalled();
  });
});

describe('shipments — webhook edge cases', () => {
  const ts = Math.floor(NOW.getTime() / 1000);
  const signed = (body: string) => ({
    'Content-Type': 'application/json',
    'X-Mock-Timestamp': String(ts),
    'X-Mock-Signature': signMockShippingWebhook(body, ts),
  });
  const send = (t: T, body: string, provider = 'mock') =>
    request(t.app).post(`/api/v1/webhooks/shipping/${provider}`).set(signed(body)).send(body);

  it('unmapped provider status is stored (payload kept) without changing the shipment', async () => {
    const { t } = setup();
    const body = JSON.stringify({
      eventId: 'evt_x',
      awb: 'awb123456',
      status: 'weighed_at_hub',
      occurredAt: '2026-11-19T06:00:00.000Z',
    });
    t.m.shipment.findFirst.mockResolvedValue({ id: SHIPMENT_ID });
    mockShipment(t, [coreRow({ status: 'IN_TRANSIT', shippedAt: NOW })]);
    t.m.shipmentTrackingEvent.findUnique.mockResolvedValue(null);
    t.m.shipmentTrackingEvent.findFirst.mockResolvedValue(null);
    const res = await send(t, body, 'MOCK');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ received: true, processed: 1, ignored: 0 });
    expect(t.m.shipment.findFirst.mock.calls[0]?.[0].where).toEqual({ awbNumber: 'AWB123456' });
    expect(t.m.shipmentTrackingEvent.create.mock.calls[0]?.[0].data).toMatchObject({
      mappedStatus: 'IN_TRANSIT',
      providerStatus: 'weighed_at_hub',
      location: null,
      message: null,
      payload: { provider: 'mock', eventId: 'evt_x', status: 'weighed_at_hub' },
    });
    expect(t.m.shipment.update).not.toHaveBeenCalled();
  });

  it('batch with ignored + duplicate + processed events reports counts without duplicate flag', async () => {
    const { t } = setup();
    const at = '2026-11-19T06:00:00.000Z';
    const body = JSON.stringify([
      { eventId: 'e1', awb: 'UNKNOWN1', status: 'in_transit', occurredAt: at },
      { eventId: 'e2', awb: 'AWB123456', status: 'in_transit', occurredAt: at },
      { eventId: 'e3', awb: 'AWB123456', status: 'in_transit', occurredAt: at, message: 'Hub' },
    ]);
    t.m.shipment.findFirst.mockImplementation((args: { where: { awbNumber: string } }) =>
      Promise.resolve(args.where.awbNumber === 'AWB123456' ? { id: SHIPMENT_ID } : null),
    );
    mockShipment(t, [coreRow({ status: 'SHIPPED', shippedAt: NOW })]);
    const dup = dedupeHash('mock', 'e2');
    t.m.shipmentTrackingEvent.findUnique.mockImplementation(
      (args: { where: { shipmentId_dedupeHash: { dedupeHash: string } } }) =>
        Promise.resolve(
          args.where.shipmentId_dedupeHash.dedupeHash === dup ? { id: 'seen' } : null,
        ),
    );
    t.m.shipmentTrackingEvent.findFirst.mockResolvedValue({ eventAt: new Date(at) });
    t.m.order.findUnique.mockResolvedValue(orderForAdvance());
    const res = await send(t, body);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ received: true, processed: 1, ignored: 1 });
    expect(t.m.shipmentTrackingEvent.create).toHaveBeenCalledTimes(1);
    expect(t.m.shipment.update.mock.calls[0]?.[0].data).toEqual({ status: 'IN_TRANSIT' });
  });

  it('empty body → 401; unexpected adapter errors are not mapped to 401/400', async () => {
    const { t } = setup();
    const empty = await request(t.app)
      .post('/api/v1/webhooks/shipping/mock')
      .set(signed(''))
      .send('');
    expect(empty.status).toBe(401);

    class BrokenVerify extends MockShippingProviderAdapter {
      override verifyWebhook(): void {
        throw new Error('boom');
      }
    }
    const broken = setup(new BrokenVerify());
    expect((await send(broken.t, '{"a":1}')).status).toBe(500);

    class BrokenParse extends MockShippingProviderAdapter {
      override parseWebhook(): ShippingWebhookEvent[] {
        throw new TypeError('parser bug');
      }
    }
    const parse = setup(new BrokenParse());
    expect((await send(parse.t, '{"a":1}')).status).toBe(500);
    expect(parse.t.m.shipment.findFirst).not.toHaveBeenCalled();
  });
});

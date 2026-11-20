/**
 * Shipping HTTP — public serviceability/methods, admin methods & shipments, courier webhook.
 * MOCKED DB (tests/helpers/mockDb.ts): verifies contracts, guards, side-effect calls; no SQL runs.
 *
 * Mock webhook contract: `X-Mock-Timestamp` + `X-Mock-Signature: sha256=HMAC(secret, ts.body)`.
 */
import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import {
  MockShippingProviderAdapter,
  createShippingProviderRegistry,
  signMockShippingWebhook,
} from '../../../../src/integrations/shipping/shippingProvider.js';
import {
  createShippingModule,
  shippingModuleWith,
} from '../../../../src/modules/shipping/index.js';
import { buildModuleTestApp } from '../../../helpers/container.js';
import { expectAdminRoutesGuarded } from '../../../helpers/routeTable.js';

const NOW = new Date('2026-11-19T06:30:00.000Z');
const ALL = ['shipping.view', 'shipping.create', 'shipping.update', 'shipping.delete'];
const ORDER_ID = randomUUID();
const ITEM_ID = randomUUID();
const SHIPMENT_ID = randomUUID();

function setup(provider = new MockShippingProviderAdapter()) {
  const factory = shippingModuleWith({ providers: createShippingProviderRegistry([provider]) });
  const t = buildModuleTestApp([factory], { now: NOW });
  t.m.auditLog.create.mockResolvedValue({});
  t.m.notification.findUnique.mockResolvedValue(null);
  return { t, factory, provider };
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
    freeAboveAmount: '4999.00',
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

function orderRow(status = 'PACKED') {
  return {
    id: ORDER_ID,
    orderNumber: 'ORD-261119-00001',
    status,
    shippingMethodId: null,
    paymentMethod: 'ONLINE',
    grandTotal: '2499.00',
    shippingAddressSnapshot: { pincode: '411045' },
    items: [{ id: ITEM_ID, quantity: 2, quantityCancelled: 0 }],
    shipments: [],
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
      customerPhoneSnapshot: null,
      user: { firstName: 'Riya', email: 'riya@example.com', phone: '+919812345678' },
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
        orderItem: { productName: 'Jhumka', variantName: 'Gold', sku: 'EAR-1' },
      },
    ],
    trackingEvents: [],
    order: { id: ORDER_ID, orderNumber: 'ORD-261119-00001', status: 'PACKED' },
    shippingMethod: null,
    ...over,
  };
}

/** `shipment.findUnique` serves the core (select) and detail (include) shapes. */
function mockShipment(
  t: ReturnType<typeof setup>['t'],
  core: object,
  detail: object = detailRow(),
) {
  t.m.shipment.findUnique.mockImplementation((args: { select?: unknown }) =>
    Promise.resolve(args.select === undefined ? detail : core),
  );
}

function orderForAdvance(status: string) {
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

describe('shipping routes — guards & public', () => {
  it('guards every admin route with shipping.* and mounts the webhook router', () => {
    const { t } = setup();
    const module = createShippingModule(t.container);
    const routes = expectAdminRoutesGuarded(module);
    expect(routes.map((r) => `${r.method} ${r.path} ${r.permissions.join(',')}`)).toEqual([
      'GET /shipping/methods shipping.view',
      'POST /shipping/methods shipping.create',
      'GET /shipping/methods/:methodId shipping.view',
      'PATCH /shipping/methods/:methodId shipping.update',
      'DELETE /shipping/methods/:methodId shipping.delete',
      'GET /shipments shipping.view',
      'POST /shipments shipping.create',
      'GET /shipments/:shipmentId shipping.view',
      'PATCH /shipments/:shipmentId shipping.update',
      'POST /shipments/:shipmentId/tracking-events shipping.update',
    ]);
    expect(module.webhookRouter).toBeDefined();
  });

  it('GET /shipping/serviceability validates the pincode and reports COD per setting', async () => {
    const { t } = setup();
    expect(
      (await request(t.app).get('/api/v1/shipping/serviceability?pincode=012345')).status,
    ).toBe(422);
    t.m.setting.findUnique.mockResolvedValue({ value: true });
    const res = await request(t.app).get('/api/v1/shipping/serviceability?pincode=411045');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      pincode: '411045',
      serviceable: true,
      city: null,
      stateCode: '27',
      estimatedDelivery: { minDays: 2, maxDays: 4 },
      codAvailable: true,
    });
  });

  it('provider outage → serviceable null / CHECK_UNAVAILABLE (browsing not blocked)', async () => {
    const { t } = setup(new MockShippingProviderAdapter({ failServiceability: true }));
    const res = await request(t.app).get('/api/v1/shipping/serviceability?pincode=411045');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ serviceable: null, reason: 'CHECK_UNAVAILABLE' });
  });

  it('GET /shipping/methods quotes free shipping above the threshold; unserviceable → []', async () => {
    const { t } = setup();
    t.m.shippingMethod.findMany.mockResolvedValue([
      methodRow(),
      methodRow({ code: 'EXPRESS', name: 'Express', baseCharge: '199.00', freeAboveAmount: null }),
    ]);
    t.m.setting.findUnique.mockResolvedValue(null);
    const res = await request(t.app).get('/api/v1/shipping/methods?cartValue=5000.00');
    expect(res.status).toBe(200);
    expect(
      (res.body.data as { code: string; quote: { payable: string } }[]).map((m) => [
        m.code,
        m.quote.payable,
      ]),
    ).toEqual([
      ['STANDARD', '0.00'],
      ['EXPRESS', '199.00'],
    ]);
    expect(res.body.data[0]).toMatchObject({
      charge: '99.00',
      freeAbove: '4999.00',
      codAvailable: false,
    });

    const none = await request(t.app).get('/api/v1/shipping/methods?pincode=999999');
    expect(none.body.data).toEqual([]);
    expect(none.body.meta).toMatchObject({ serviceable: false });
  });
});

describe('shipping routes — admin methods', () => {
  it('creates a method (audited) and rejects duplicate codes / bad money', async () => {
    const { t } = setup();
    const auth = t.staff({ permissions: ALL }).headers;
    t.m.shippingMethod.findUnique.mockResolvedValue(null);
    t.m.shippingMethod.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve(methodRow(data)),
    );
    const res = await request(t.app)
      .post('/api/v1/admin/shipping/methods')
      .set(auth)
      .send({ code: 'standard', name: 'Standard Delivery', charge: '99', freeAbove: '4999.00' });
    expect(res.status).toBe(201);
    expect(t.m.shippingMethod.create.mock.calls[0]?.[0].data).toMatchObject({
      code: 'STANDARD',
      baseCharge: '99',
      rateType: 'FLAT',
      nameNormalized: 'standard delivery',
    });
    expect(t.m.auditLog.create.mock.calls[0]?.[0].data).toMatchObject({
      action: 'CREATE',
      module: 'shipping',
    });

    t.m.shippingMethod.findUnique.mockResolvedValueOnce(methodRow());
    const dup = await request(t.app)
      .post('/api/v1/admin/shipping/methods')
      .set(auth)
      .send({ code: 'STANDARD', name: 'Other', charge: '10.00' });
    expect(dup.status).toBe(409);
    const bad = await request(t.app)
      .post('/api/v1/admin/shipping/methods')
      .set(auth)
      .send({ code: 'X1', name: 'Bad', charge: 99.5 });
    expect(bad.status).toBe(422);
  });

  it('refuses to delete a method used by orders (409 IN_USE)', async () => {
    const { t } = setup();
    const auth = t.staff({ permissions: ALL }).headers;
    const row = methodRow();
    t.m.shippingMethod.findUnique.mockResolvedValue(row);
    t.m.order.count.mockResolvedValue(4);
    const res = await request(t.app).delete(`/api/v1/admin/shipping/methods/${row.id}`).set(auth);
    expect(res.status).toBe(409);
    expect(res.body.error.details[0].code).toBe('IN_USE');
  });
});

describe('shipping routes — shipments', () => {
  it('creates a shipment for a PACKED order with an SHP number and READY_TO_SHIP', async () => {
    const { t } = setup();
    const auth = t.staff({ permissions: ALL }).headers;
    t.m.order.findUnique.mockResolvedValue(orderRow());
    t.m.shipment.findFirst.mockResolvedValue(null);
    t.m.shipment.findUnique.mockResolvedValue(detailRow());
    const res = await request(t.app)
      .post('/api/v1/admin/shipments')
      .set(auth)
      .send({ orderId: ORDER_ID, courier: 'BlueDart', awb: 'awb123456', packageWeightGrams: 120 });
    expect(res.status).toBe(201);
    const data = t.m.shipment.create.mock.calls[0]?.[0].data;
    expect(data).toMatchObject({
      shipmentNumber: 'SHP-261119-00001',
      status: 'READY_TO_SHIP',
      provider: 'BlueDart',
      awbNumber: 'AWB123456',
    });
    expect(t.m.shipmentItem.createMany.mock.calls[0]?.[0].data).toEqual([
      { shipmentId: data.id, orderItemId: ITEM_ID, quantity: 2 },
    ]);
    expect(res.body.data).toMatchObject({
      shipmentNumber: 'SHP-261119-00001',
      courier: 'BlueDart',
    });
  });

  it('409 when the order is not packed; provider booking is cancelled if the DB write fails', async () => {
    const { t, provider } = setup();
    const auth = t.staff({ permissions: ALL }).headers;
    t.m.order.findUnique.mockResolvedValue(orderRow('CONFIRMED'));
    const early = await request(t.app)
      .post('/api/v1/admin/shipments')
      .set(auth)
      .send({ orderId: ORDER_ID, courier: 'BlueDart', packageWeightGrams: 120 });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('INVALID_STATE_TRANSITION');

    t.m.order.findUnique.mockResolvedValue(orderRow());
    t.m.shipment.findFirst.mockResolvedValue(null);
    t.m.shipment.create.mockRejectedValue(new Error('db down'));
    const failed = await request(t.app)
      .post('/api/v1/admin/shipments')
      .set(auth)
      .send({ orderId: ORDER_ID, createWithProvider: true, packageWeightGrams: 120 });
    expect(failed.status).toBe(500);
    expect(provider.cancelled).toEqual(['MOCK0000000001']);
  });

  it('PATCH SHIPPED without an AWB → 422 AWB_REQUIRED', async () => {
    const { t } = setup();
    const auth = t.staff({ permissions: ALL }).headers;
    mockShipment(t, coreRow({ status: 'PENDING', awbNumber: null }));
    const res = await request(t.app)
      .patch(`/api/v1/admin/shipments/${SHIPMENT_ID}`)
      .set(auth)
      .send({ status: 'SHIPPED' });
    expect(res.status).toBe(422);
    expect(res.body.error.details[0].code).toBe('AWB_REQUIRED');
  });

  it('PATCH SHIPPED moves the order PACKED → SHIPPED, bumps shipped qty and queues ORDER_SHIPPED', async () => {
    const { t } = setup();
    const auth = t.staff({ permissions: ALL }).headers;
    mockShipment(t, coreRow());
    t.m.order.findUnique.mockResolvedValue(orderForAdvance('PACKED'));
    const res = await request(t.app)
      .patch(`/api/v1/admin/shipments/${SHIPMENT_ID}`)
      .set(auth)
      .send({ status: 'SHIPPED', note: 'Handed to courier' });
    expect(res.status).toBe(200);
    expect(t.m.shipment.update.mock.calls[0]?.[0].data).toEqual({
      status: 'SHIPPED',
      shippedAt: NOW,
    });
    expect(t.m.orderItem.update.mock.calls[0]?.[0]).toEqual({
      where: { id: ITEM_ID },
      data: { quantityShipped: { increment: 2 } },
    });
    expect(t.m.order.update.mock.calls[0]?.[0].data).toEqual({ status: 'SHIPPED', shippedAt: NOW });
    expect(t.m.orderStatusHistory.create.mock.calls[0]?.[0].data).toMatchObject({
      fromStatus: 'PACKED',
      toStatus: 'SHIPPED',
      actorType: 'STAFF',
    });
    const events = t.m.notification.create.mock.calls.map(
      (c) => `${c[0].data.event}:${c[0].data.channel}`,
    );
    expect(events).toEqual(['ORDER_SHIPPED:EMAIL', 'ORDER_SHIPPED:WHATSAPP']);
    const actions = t.m.auditLog.create.mock.calls.map(
      (c) => `${c[0].data.module}:${c[0].data.action}`,
    );
    expect(actions).toEqual(['shipping:STATUS_CHANGE', 'orders:STATUS_CHANGE']);
  });

  it('rejects invalid shipment transitions with 409', async () => {
    const { t } = setup();
    const auth = t.staff({ permissions: ALL }).headers;
    mockShipment(t, coreRow({ status: 'DELIVERED' }));
    const res = await request(t.app)
      .patch(`/api/v1/admin/shipments/${SHIPMENT_ID}`)
      .set(auth)
      .send({ status: 'IN_TRANSIT' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('manual tracking events: future time → 422; valid event stored with STAFF source', async () => {
    const { t } = setup();
    const auth = t.staff({ permissions: ALL }).headers;
    const future = await request(t.app)
      .post(`/api/v1/admin/shipments/${SHIPMENT_ID}/tracking-events`)
      .set(auth)
      .send({ status: 'IN_TRANSIT', description: 'x', occurredAt: '2026-11-20T06:30:00.000Z' });
    expect(future.status).toBe(422);

    mockShipment(t, coreRow({ status: 'SHIPPED', shippedAt: NOW }));
    t.m.shipmentTrackingEvent.findUnique.mockResolvedValue(null);
    t.m.shipmentTrackingEvent.findFirst.mockResolvedValue(null);
    t.m.order.findUnique.mockResolvedValue(orderForAdvance('SHIPPED'));
    const res = await request(t.app)
      .post(`/api/v1/admin/shipments/${SHIPMENT_ID}/tracking-events`)
      .set(auth)
      .send({
        status: 'IN_TRANSIT',
        location: 'Mumbai Gateway',
        description: 'In transit',
        occurredAt: '2026-11-19T06:00:00.000Z',
      });
    expect(res.status).toBe(201);
    expect(t.m.shipmentTrackingEvent.create.mock.calls[0]?.[0].data).toMatchObject({
      mappedStatus: 'IN_TRANSIT',
      source: 'STAFF',
      location: 'Mumbai Gateway',
    });
    expect(t.m.shipment.update.mock.calls[0]?.[0].data).toEqual({ status: 'IN_TRANSIT' });
  });
});

describe('shipping webhook /webhooks/shipping/:provider', () => {
  const ts = Math.floor(NOW.getTime() / 1000);
  const payload = JSON.stringify({
    eventId: 'evt_100',
    awb: 'AWB123456',
    status: 'out_for_delivery',
    occurredAt: '2026-11-19T06:00:00.000Z',
    location: 'Pune Hub',
  });
  const post = (
    t: ReturnType<typeof setup>['t'],
    body: string,
    headers: Record<string, string>,
    provider = 'mock',
  ) =>
    request(t.app)
      .post(`/api/v1/webhooks/shipping/${provider}`)
      .set({ 'Content-Type': 'application/json', ...headers })
      .send(body);
  const signed = (body: string) => ({
    'X-Mock-Timestamp': String(ts),
    'X-Mock-Signature': signMockShippingWebhook(body, ts),
  });

  it('accepts a signed event, records it and advances shipment + order', async () => {
    const { t } = setup();
    t.m.shipment.findFirst.mockResolvedValue({ id: SHIPMENT_ID });
    mockShipment(t, coreRow({ status: 'IN_TRANSIT', shippedAt: NOW }));
    t.m.shipmentTrackingEvent.findUnique.mockResolvedValue(null);
    t.m.shipmentTrackingEvent.findFirst.mockResolvedValue(null);
    t.m.order.findUnique.mockResolvedValue(orderForAdvance('SHIPPED'));
    const res = await post(t, payload, signed(payload));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      data: { received: true, processed: 1, ignored: 0 },
    });
    const event = t.m.shipmentTrackingEvent.create.mock.calls[0]?.[0].data;
    expect(event).toMatchObject({
      mappedStatus: 'OUT_FOR_DELIVERY',
      providerStatus: 'out_for_delivery',
      source: 'WEBHOOK',
    });
    expect(event.dedupeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(t.m.order.update.mock.calls[0]?.[0].data).toEqual({ status: 'OUT_FOR_DELIVERY' });
    expect(t.m.auditLog.create.mock.calls[0]?.[0].data).toMatchObject({ actorType: 'WEBHOOK' });
    const events = t.m.notification.create.mock.calls.map((c): unknown => c[0].data.event);
    expect(events).toContain('ORDER_OUT_FOR_DELIVERY');
  });

  it('is idempotent on the provider event id (duplicate → 200 duplicate:true)', async () => {
    const { t } = setup();
    t.m.shipment.findFirst.mockResolvedValue({ id: SHIPMENT_ID });
    mockShipment(t, coreRow({ status: 'OUT_FOR_DELIVERY', shippedAt: NOW }));
    t.m.shipmentTrackingEvent.findUnique.mockResolvedValue({ id: 'already' });
    const res = await post(t, payload, signed(payload));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ received: true, duplicate: true });
    expect(t.m.shipmentTrackingEvent.create).not.toHaveBeenCalled();
  });

  it('rejects bad / stale / missing signatures with 401 before parsing', async () => {
    const { t } = setup();
    const tampered = payload.replace('out_for_delivery', 'delivered');
    const bad = await post(t, tampered, signed(payload));
    expect(bad.status).toBe(401);
    expect(bad.body.error).toEqual({ code: 'UNAUTHENTICATED', message: 'Invalid signature.' });
    const stale = await post(t, payload, {
      'X-Mock-Timestamp': String(ts - 600),
      'X-Mock-Signature': signMockShippingWebhook(payload, ts - 600),
    });
    expect(stale.status).toBe(401);
    expect((await post(t, '{not json', {})).status).toBe(401);
    expect(t.m.shipment.findFirst).not.toHaveBeenCalled();
  });

  it('unknown provider → 404; unknown AWB acknowledged and ignored; signed garbage → 400', async () => {
    const { t } = setup();
    expect((await post(t, payload, signed(payload), 'shiprocket')).status).toBe(404);
    t.m.shipment.findFirst.mockResolvedValue(null);
    const ignored = await post(t, payload, signed(payload));
    expect(ignored.status).toBe(200);
    expect(ignored.body.data).toMatchObject({ processed: 0, ignored: 1 });
    const garbage = '{"eventId":1}';
    expect((await post(t, garbage, signed(garbage))).status).toBe(400);
  });
});

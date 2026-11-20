/**
 * Orders — edge cases through the real Express app. MOCKED DB (tests/helpers/mockDb.ts; no SQL
 * executed) with stubbed inventory/coupon services. Covers list filters/sorting, not-found paths,
 * tracking URLs, status transitions (notifications, COD amount, shippedAt/deliveredAt), the
 * customer cancellation policy messages and the cancellation approve/reject guards.
 */
import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { Decimal } from '../../../../src/lib/money.js';
import type { CouponsService } from '../../../../src/modules/coupons/index.js';
import type { InventoryService } from '../../../../src/modules/inventory/index.js';
import { createOrdersModule, ordersModuleWith } from '../../../../src/modules/orders/index.js';
import { buildModuleTestApp, type ModuleTestApp } from '../../../helpers/container.js';

const NOW = new Date('2026-11-19T06:30:00.000Z');
const ORDER_ID = '5d2c7a10-0000-4a00-8000-000000000001';
const ITEM_ID = '5d2c7a10-0000-4a00-8000-0000000000a1';
const OWNER = '5d2c7a10-0000-4a00-8000-0000000000c1';
const ORDER_NUMBER = 'ORD-261119-00042';
const ALL = ['orders.view', 'orders.update', 'orders.approve'];

function stubs() {
  const empty = { ledger: [], lowStock: [] };
  const inventory = {
    restoreCancellation: vi.fn().mockResolvedValue(empty),
    releaseReservation: vi.fn().mockResolvedValue(empty),
  } as unknown as InventoryService;
  const coupons = {
    release: vi.fn().mockResolvedValue({
      status: 'NO_COUPON',
      changed: false,
      usageId: null,
      couponId: null,
    }),
  } as unknown as CouponsService;
  return { inventory, coupons };
}

interface State {
  status: string;
  paymentStatus: string;
  paymentMethod: string;
  shippedAt: Date | null;
}

function contact(state: State) {
  return {
    id: ORDER_ID,
    orderNumber: ORDER_NUMBER,
    userId: OWNER,
    status: state.status,
    paymentMethod: state.paymentMethod,
    paymentStatus: state.paymentStatus,
    grandTotal: new Decimal('2499.00'),
    refundedTotal: new Decimal('0'),
    couponCodeSnapshot: null,
    customerPhoneSnapshot: null,
    user: { firstName: 'Riya', email: 'riya@example.com', phone: '+919812345678' },
  };
}

function detailRow(state: State) {
  const d = (v: string) => new Decimal(v);
  return {
    ...contact(state),
    currency: 'INR',
    itemCount: 1,
    totalQuantity: 1,
    subtotal: d('2400.00'),
    itemDiscountTotal: d('0'),
    couponDiscountTotal: d('0'),
    shippingCharge: d('99.00'),
    shippingDiscount: d('0'),
    codCharge: d('0'),
    taxableTotal: d('2426.21'),
    cgstTotal: d('36.39'),
    sgstTotal: d('36.40'),
    utgstTotal: d('0'),
    igstTotal: d('0'),
    taxTotal: d('72.79'),
    roundOff: d('0'),
    pricesIncludeTax: true,
    shippingMethodNameSnapshot: 'Standard',
    supplyType: 'INTRA_STATE',
    placeOfSupplyStateCode: '27',
    buyerGstin: null,
    buyerLegalName: null,
    customerNameSnapshot: 'Riya Sharma',
    customerEmailSnapshot: 'riya@example.com',
    billingAddressSnapshot: { fullName: 'Riya Sharma', city: 'Pune', stateCode: '27' },
    shippingAddressSnapshot: { fullName: 'Riya Sharma', city: 'Pune', stateCode: '27' },
    customerNote: null,
    placedAt: NOW,
    confirmedAt: NOW,
    shippedAt: state.shippedAt,
    deliveredAt: null,
    cancellationRequestedAt: null,
    cancelledAt: null,
    cancellationReason: null,
    items: [
      {
        id: ITEM_ID,
        lineNo: 1,
        productId: randomUUID(),
        variantId: randomUUID(),
        productName: 'Meera Jhumka',
        variantName: 'Gold',
        sku: 'EAR-JH-001-G',
        attributesSnapshot: { plating: 'Gold' },
        imageUrl: null,
        hsnCode: '7117',
        quantity: 1,
        mrp: d('2999.00'),
        unitPrice: d('2400.00'),
        promotionDiscount: d('0'),
        couponDiscount: d('0'),
        taxableValue: d('2330.10'),
        taxRate: d('3.00'),
        cgstRate: d('1.50'),
        cgstAmount: d('34.95'),
        sgstRate: d('1.50'),
        sgstAmount: d('34.95'),
        utgstRate: d('0'),
        utgstAmount: d('0'),
        igstRate: d('0'),
        igstAmount: d('0'),
        taxAmount: d('69.90'),
        lineTotal: d('2400.00'),
        quantityShipped: 0,
        quantityCancelled: 0,
        quantityRefunded: 0,
      },
    ],
    statusHistory: [],
    payments: [],
    shipments: [],
    refunds: [],
    invoiceRecords: [],
  };
}

/** Routes `order.findUnique` by the requested select (lock, detail, refund planning, fresh read). */
function mockOrder(t: ModuleTestApp, state: State) {
  t.m.order.findFirst.mockImplementation((args: { where: { userId?: string } }) =>
    Promise.resolve(args.where.userId === OWNER ? { id: ORDER_ID } : null),
  );
  t.m.order.findUnique.mockImplementation((args: { select: Record<string, unknown> }) => {
    const s = args.select;
    if ('statusHistory' in s || 'supplyType' in s) return Promise.resolve(detailRow(state));
    if ('payments' in s) {
      return Promise.resolve({
        ...contact(state),
        items: [
          {
            id: ITEM_ID,
            quantity: 1,
            lineTotal: new Decimal('2400.00'),
            taxAmount: new Decimal('69.90'),
          },
        ],
        payments: [],
      });
    }
    if ('shippedAt' in s && !('id' in s)) {
      return Promise.resolve({ shippedAt: state.shippedAt, confirmedAt: NOW });
    }
    return Promise.resolve(contact(state));
  });
}

function setup(state: Partial<State> = {}, factory = ordersModuleWith(stubs())) {
  const t = buildModuleTestApp([factory], { now: NOW });
  mockOrder(t, {
    status: 'CONFIRMED',
    paymentStatus: 'CAPTURED',
    paymentMethod: 'ONLINE',
    shippedAt: null,
    ...state,
  });
  t.m.notification.findUnique.mockResolvedValue(null);
  t.m.invoiceRecord.findFirst.mockResolvedValue(null);
  t.m.refund.findMany.mockResolvedValue([]);
  t.m.setting.findMany.mockResolvedValue([]);
  return {
    t,
    admin: t.staff({ permissions: ALL }).headers,
    owner: t.customer({ userId: OWNER }).headers,
  };
}

/** Every notification.create payload as JSON, for loose content assertions. */
function notifications(t: ModuleTestApp): { event: unknown; json: string }[] {
  return t.m.notification.create.mock.calls.map((c) => ({
    event: (c[0] as { data: { event: unknown } }).data.event,
    json: JSON.stringify(c[0]),
  }));
}

// ------------------------------------------------------------------------------------- lists
describe('GET /admin/orders — filters & sorting (default module wiring)', () => {
  it('without filters uses an empty where and newest-first order', async () => {
    const { t, admin } = setup({}, createOrdersModule);
    t.m.order.findMany.mockResolvedValue([]);
    t.m.order.count.mockResolvedValue(0);
    const res = await request(t.app).get('/api/v1/admin/orders').set(admin);
    expect(res.status).toBe(200);
    const args = t.m.order.findMany.mock.calls[0]?.[0];
    expect(args.where).toEqual({});
    expect(args.orderBy).toEqual({ placedAt: 'desc' });
  });

  it('combines every filter into one AND list', async () => {
    const { t, admin } = setup({}, createOrdersModule);
    t.m.order.findMany.mockResolvedValue([]);
    t.m.order.count.mockResolvedValue(0);
    const res = await request(t.app).get('/api/v1/admin/orders').set(admin).query({
      status: 'CONFIRMED,PROCESSING',
      paymentStatus: 'CAPTURED',
      paymentMethod: 'COD',
      from: '2026-11-01',
      to: '2026-11-19',
      minTotal: '100.00',
      maxTotal: '5000.00',
      q: 'AWB123',
      sort: 'placedAt',
    });
    expect(res.status).toBe(200);
    const args = t.m.order.findMany.mock.calls[0]?.[0];
    expect(args.orderBy).toEqual({ placedAt: 'asc' });
    const and = args.where.AND as Record<string, unknown>[];
    expect(and).toHaveLength(8);
    expect(and[0]).toEqual({ status: { in: ['CONFIRMED', 'PROCESSING'] } });
    expect(and[1]).toEqual({ paymentStatus: 'CAPTURED' });
    expect(and[2]).toEqual({ paymentMethod: 'COD' });
    expect(and[3]).toEqual({ placedAt: { gte: expect.any(Date) } });
    expect(and[4]).toEqual({ placedAt: { lt: expect.any(Date) } });
    expect(String((and[5] as { grandTotal: { gte: unknown } }).grandTotal.gte)).toBe('100');
    expect(String((and[6] as { grandTotal: { lte: unknown } }).grandTotal.lte)).toBe('5000');
    expect(and[7]).toMatchObject({
      OR: expect.arrayContaining([{ shipments: { some: { awbNumber: 'AWB123' } } }]),
    });
    // The same where is used for the total.
    expect(t.m.order.count.mock.calls[0]?.[0].where).toEqual(args.where);
  });

  it('FR-ORD-006: q also matches the order-item SKU snapshot', async () => {
    const { t, admin } = setup({}, createOrdersModule);
    t.m.order.findMany.mockResolvedValue([]);
    t.m.order.count.mockResolvedValue(0);
    const res = await request(t.app)
      .get('/api/v1/admin/orders')
      .set(admin)
      .query({ q: 'EAR-MEERA' });
    expect(res.status).toBe(200);
    const where = t.m.order.findMany.mock.calls[0]?.[0].where as {
      AND: { OR: Record<string, unknown>[] }[];
    };
    expect(where.AND).toHaveLength(1);
    expect(where.AND[0]?.OR).toEqual([
      { orderNumber: { contains: 'EAR-MEERA' } },
      { customerEmailSnapshot: { contains: 'EAR-MEERA' } },
      { customerPhoneSnapshot: { contains: 'EAR-MEERA' } },
      { shipments: { some: { awbNumber: 'EAR-MEERA' } } },
      { items: { some: { sku: { contains: 'EAR-MEERA' } } } },
    ]);
    expect(t.m.order.count.mock.calls[0]?.[0].where).toEqual(where);
  });

  it('sort=-grandTotal orders by grand total descending', async () => {
    const { t, admin } = setup();
    t.m.order.findMany.mockResolvedValue([]);
    t.m.order.count.mockResolvedValue(0);
    await request(t.app).get('/api/v1/admin/orders').set(admin).query({ sort: '-grandTotal' });
    expect(t.m.order.findMany.mock.calls[0]?.[0].orderBy).toEqual({ grandTotal: 'desc' });
  });
});

describe('GET /me/orders — filters', () => {
  it.each([
    [{ status: 'SHIPPED,DELIVERED', from: '2026-11-01', to: '2026-11-19' }, ['gte', 'lt']],
    [{ from: '2026-11-01' }, ['gte']],
    [{ to: '2026-11-19' }, ['lt']],
  ])('builds the placedAt range for %o', async (query, keys) => {
    const { t, owner } = setup();
    t.m.order.findMany.mockResolvedValue([]);
    t.m.order.count.mockResolvedValue(0);
    const res = await request(t.app).get('/api/v1/me/orders').set(owner).query(query);
    expect(res.status).toBe(200);
    const where = t.m.order.findMany.mock.calls[0]?.[0].where;
    expect(where.userId).toBe(OWNER);
    expect(Object.keys(where.placedAt as object).sort()).toEqual([...keys].sort());
    if ('status' in query) expect(where.status).toEqual({ in: ['SHIPPED', 'DELIVERED'] });
    else expect(where).not.toHaveProperty('status');
  });
});

// ------------------------------------------------------------------------------------- not found
describe('not-found paths', () => {
  it('admin detail, status change and invoice 404 for an unknown order', async () => {
    const { t, admin } = setup();
    t.m.order.findUnique.mockResolvedValue(null);
    const id = randomUUID();
    const detail = await request(t.app).get(`/api/v1/admin/orders/${id}`).set(admin);
    const status = await request(t.app)
      .post(`/api/v1/admin/orders/${id}/status`)
      .set(admin)
      .send({ status: 'PROCESSING' });
    const invoice = await request(t.app).get(`/api/v1/admin/orders/${id}/invoice`).set(admin);
    expect([detail.status, status.status, invoice.status]).toEqual([404, 404, 404]);
    expect(t.m.order.update).not.toHaveBeenCalled();
  });

  it('tracking 404s when the owned order vanishes between lookups', async () => {
    const { t, owner } = setup();
    t.m.order.findUnique.mockResolvedValue(null);
    const res = await request(t.app).get(`/api/v1/me/orders/${ORDER_NUMBER}/tracking`).set(owner);
    expect(res.status).toBe(404);
  });
});

// ------------------------------------------------------------------------------------- tracking
describe('GET /me/orders/:orderNumber/tracking', () => {
  it('builds tracking URLs from the booking adapter and leaves AWB-less shipments without one', async () => {
    const { t, owner } = setup({ status: 'SHIPPED' });
    const at = new Date('2026-11-18T10:00:00.000Z');
    t.m.order.findUnique.mockResolvedValue({
      orderNumber: ORDER_NUMBER,
      status: 'SHIPPED',
      shipments: [
        {
          shipmentNumber: 'SHP-1',
          status: 'IN_TRANSIT',
          provider: 'mock:BlueDart',
          awbNumber: 'AWB 1',
          trackingEvents: [
            { mappedStatus: 'IN_TRANSIT', location: 'Pune', message: 'Departed', eventAt: at },
          ],
        },
        {
          shipmentNumber: 'SHP-2',
          status: 'PENDING',
          provider: null,
          awbNumber: null,
          trackingEvents: [],
        },
      ],
    });
    const res = await request(t.app).get(`/api/v1/me/orders/${ORDER_NUMBER}/tracking`).set(owner);
    expect(res.status).toBe(200);
    expect(res.body.data.shipments).toEqual([
      {
        shipmentNumber: 'SHP-1',
        status: 'IN_TRANSIT',
        courier: 'BlueDart',
        awb: 'AWB 1',
        trackingUrl: 'https://tracking.example.com/mock/AWB%201',
        estimatedDelivery: null,
        events: [
          {
            status: 'IN_TRANSIT',
            location: 'Pune',
            at: at.toISOString(),
            description: 'Departed',
          },
        ],
      },
      {
        shipmentNumber: 'SHP-2',
        status: 'PENDING',
        courier: null,
        awb: null,
        trackingUrl: null,
        estimatedDelivery: null,
        events: [],
      },
    ]);
  });
});

// ------------------------------------------------------------------------------------- status
describe('POST /admin/orders/:orderId/status — transitions', () => {
  const url = `/api/v1/admin/orders/${ORDER_ID}/status`;

  it('PROCESSING → PACKED: history row without note, no customer notification', async () => {
    const { t, admin } = setup({ status: 'PROCESSING' });
    const res = await request(t.app).post(url).set(admin).send({ status: 'PACKED' });
    expect(res.status).toBe(200);
    expect(t.m.order.update.mock.calls[0]?.[0].data).toEqual({ status: 'PACKED' });
    expect(t.m.orderStatusHistory.create.mock.calls[0]?.[0].data).toMatchObject({
      fromStatus: 'PROCESSING',
      toStatus: 'PACKED',
      note: null,
      isCustomerVisible: true,
    });
    expect(t.m.shipment.findFirst).not.toHaveBeenCalled();
    expect(t.m.notification.create).not.toHaveBeenCalled();
  });

  it('CONFIRMED → PROCESSING notifies ORDER_PROCESSING', async () => {
    const { t, admin } = setup();
    const res = await request(t.app)
      .post(url)
      .set(admin)
      .send({ status: 'PROCESSING', note: 'Picked' });
    expect(res.status).toBe(200);
    // One row per channel (email + WhatsApp), all for the same event.
    const events = new Set(notifications(t).map((n) => n.event));
    expect([...events]).toEqual(['ORDER_PROCESSING']);
  });

  it('SHIPPED → OUT_FOR_DELIVERY for COD uses the chosen shipment and announces the COD amount', async () => {
    const { t, admin } = setup({ status: 'SHIPPED', paymentMethod: 'COD', shippedAt: NOW });
    const shipmentId = randomUUID();
    t.m.shipment.findFirst.mockResolvedValue({
      id: shipmentId,
      shipmentNumber: 'SHP-261119-00001',
      awbNumber: 'AWB9',
      provider: 'mock:Delhivery',
    });
    const res = await request(t.app)
      .post(url)
      .set(admin)
      .send({ status: 'OUT_FOR_DELIVERY', shipmentId });
    expect(res.status).toBe(200);
    expect(t.m.shipment.findFirst.mock.calls[0]?.[0].where).toMatchObject({
      orderId: ORDER_ID,
      id: shipmentId,
    });
    expect(t.m.order.update.mock.calls[0]?.[0].data).toEqual({ status: 'OUT_FOR_DELIVERY' });
    const [sent] = notifications(t);
    expect(sent?.event).toBe('ORDER_OUT_FOR_DELIVERY');
    expect(sent?.json).toContain('"codAmount":"2499.00"');
    expect(sent?.json).toContain('"courier":"Delhivery"');
    expect(sent?.json).toContain('https://tracking.example.com/mock/AWB9');
  });

  it('OUT_FOR_DELIVERY without a live shipment (prepaid) sends no shipment or COD details', async () => {
    const { t, admin } = setup({ status: 'SHIPPED', shippedAt: NOW });
    t.m.shipment.findFirst.mockResolvedValue(null);
    const res = await request(t.app).post(url).set(admin).send({ status: 'OUT_FOR_DELIVERY' });
    expect(res.status).toBe(200);
    const [sent] = notifications(t);
    expect(sent?.event).toBe('ORDER_OUT_FOR_DELIVERY');
    expect(sent?.json).not.toContain('codAmount');
    expect(sent?.json).not.toContain('shipmentNumber');
  });

  it('OUT_FOR_DELIVERY → DELIVERED stamps deliveredAt and notifies with it', async () => {
    const { t, admin } = setup({ status: 'OUT_FOR_DELIVERY', shippedAt: NOW });
    const res = await request(t.app).post(url).set(admin).send({ status: 'DELIVERED' });
    expect(res.status).toBe(200);
    expect(t.m.order.update.mock.calls[0]?.[0].data).toEqual({
      status: 'DELIVERED',
      deliveredAt: NOW,
    });
    const [sent] = notifications(t);
    expect(sent?.event).toBe('ORDER_DELIVERED');
    expect(sent?.json).toContain(`"deliveredAt":"${NOW.toISOString()}"`);
  });

  it('PACKED → SHIPPED keeps an existing shippedAt (no re-stamp)', async () => {
    const earlier = new Date('2026-11-18T00:00:00.000Z');
    const { t, admin } = setup({ status: 'PACKED', shippedAt: earlier });
    t.m.shipment.findFirst.mockResolvedValue({
      id: randomUUID(),
      shipmentNumber: 'SHP-1',
      awbNumber: 'AWB1',
      provider: 'Ekart',
    });
    const res = await request(t.app).post(url).set(admin).send({ status: 'SHIPPED' });
    expect(res.status).toBe(200);
    expect(t.m.order.update.mock.calls[0]?.[0].data).toEqual({ status: 'SHIPPED' });
  });
});

// ------------------------------------------------------------------------------------- cancellations
describe('customer cancellation policy', () => {
  const cancel = (t: ModuleTestApp, headers: Record<string, string>, body: object) =>
    request(t.app).post(`/api/v1/me/orders/${ORDER_NUMBER}/cancel`).set(headers).send(body);

  it.each([
    ['SHIPPED', 'This order has already been packed and can no longer be cancelled online.'],
    ['DELIVERED', 'This order cannot be cancelled online. Please contact support.'],
    ['PENDING_PAYMENT', 'This order cannot be cancelled online. Please contact support.'],
  ])('%s → 409 with the matching guidance', async (status, message) => {
    const { t, owner } = setup({ status });
    const res = await cancel(t, owner, { reasonCode: 'CHANGED_MIND' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain(message);
    expect(t.m.order.update).not.toHaveBeenCalled();
  });

  it('a repeated request while CANCELLATION_REQUESTED returns the current state', async () => {
    const { t, owner } = setup({ status: 'CANCELLATION_REQUESTED' });
    const res = await cancel(t, owner, { reasonCode: 'CHANGED_MIND' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      orderNumber: ORDER_NUMBER,
      previousStatus: 'CANCELLATION_REQUESTED',
      status: 'CANCELLATION_REQUESTED',
    });
  });

  it('a PROCESSING request without comment records the reason code alone', async () => {
    const { t, owner } = setup({ status: 'PROCESSING' });
    const res = await cancel(t, owner, { reasonCode: 'DELIVERY_TOO_LATE' });
    expect(res.status).toBe(200);
    expect(t.m.order.update.mock.calls[0]?.[0].data).toMatchObject({
      status: 'CANCELLATION_REQUESTED',
      cancellationReason: 'DELIVERY_TOO_LATE',
    });
    const requested = notifications(t).find((n) => n.event === 'CANCELLATION_REQUESTED');
    expect(requested?.json).toContain('"reason":"DELIVERY_TOO_LATE"');
  });
});

describe('admin cancellation guards', () => {
  it('cancel while a customer request is pending → 409 pointing to approve/reject', async () => {
    const { t, admin } = setup({ status: 'CANCELLATION_REQUESTED' });
    const res = await request(t.app)
      .post(`/api/v1/admin/orders/${ORDER_ID}/cancel`)
      .set(admin)
      .send({ reasonCode: 'OTHER', comment: 'Duplicate' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe(
      'Approve or reject the pending cancellation request instead.',
    );
  });

  it('reject without a pending request → 409', async () => {
    const { t, admin } = setup({ status: 'PROCESSING' });
    const res = await request(t.app)
      .post(`/api/v1/admin/orders/${ORDER_ID}/cancellation/reject`)
      .set(admin)
      .send({ reason: 'Nothing to reject' });
    expect(res.status).toBe(409);
    expect(res.body.error.details[0].meta).toEqual({
      currentStatus: 'PROCESSING',
      allowedFrom: ['CANCELLATION_REQUESTED'],
    });
    expect(t.m.order.update).not.toHaveBeenCalled();
  });

  it('approving a pending request cancels the order (no refund when not initiated)', async () => {
    const { t, admin } = setup({ status: 'CANCELLATION_REQUESTED', paymentStatus: 'PENDING' });
    const res = await request(t.app)
      .post(`/api/v1/admin/orders/${ORDER_ID}/cancellation/approve`)
      .set(admin)
      .send({ comment: 'Approved', refund: { initiate: false } });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      previousStatus: 'CANCELLATION_REQUESTED',
      status: 'CANCELLED',
      refund: null,
    });
    expect(t.m.refund.create).not.toHaveBeenCalled();
  });
});

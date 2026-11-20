/**
 * Orders through the real Express app — API_DOCUMENTATION.md §3.10, §4.7.
 * MOCKED DB (tests/helpers/mockDb.ts) with stubbed inventory/coupon services: verifies guards,
 * ownership (IDOR → 404), cancellation policy, state-machine errors, invoice issuance and PDF
 * downloads; no SQL is executed.
 */
import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { Decimal } from '../../../../src/lib/money.js';
import type { CouponsService } from '../../../../src/modules/coupons/index.js';
import type { InventoryService } from '../../../../src/modules/inventory/index.js';
import { ordersModuleWith } from '../../../../src/modules/orders/index.js';
import { buildModuleTestApp, type ModuleTestApp } from '../../../helpers/container.js';
import { expectAdminRoutesGuarded } from '../../../helpers/routeTable.js';

const NOW = new Date('2026-11-19T06:30:00.000Z');
const ORDER_ID = '5d2c7a10-0000-4a00-8000-000000000001';
const ITEM_ID = '5d2c7a10-0000-4a00-8000-0000000000a1';
const OWNER = '5d2c7a10-0000-4a00-8000-0000000000c1';
const ORDER_NUMBER = 'ORD-261119-00042';
const ALL = ['orders.view', 'orders.update', 'orders.approve'];

function stubs() {
  const empty = { ledger: [], lowStock: [] };
  const restore = vi.fn().mockResolvedValue({
    ledger: [
      {
        id: 'l',
        variantId: 'v',
        type: 'CANCELLATION_RESTORE',
        onHandDelta: 1,
        reservedDelta: 0,
        onHandBefore: 0,
        onHandAfter: 1,
        reservedAfter: 0,
      },
    ],
    lowStock: [],
  });
  const releaseCoupon = vi.fn().mockResolvedValue({
    status: 'NO_COUPON',
    changed: false,
    usageId: null,
    couponId: null,
  });
  const inventory = {
    restoreCancellation: restore,
    releaseReservation: vi.fn().mockResolvedValue(empty),
  } as unknown as InventoryService;
  const coupons = { release: releaseCoupon } as unknown as CouponsService;
  return { inventory, coupons, spies: { restore, releaseCoupon } };
}

interface State {
  status: string;
  paymentStatus: string;
  paymentMethod: string;
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
  return {
    ...contact(state),
    currency: 'INR',
    itemCount: 1,
    totalQuantity: 1,
    subtotal: new Decimal('2400.00'),
    itemDiscountTotal: new Decimal('0'),
    couponDiscountTotal: new Decimal('0'),
    shippingCharge: new Decimal('99.00'),
    shippingDiscount: new Decimal('0'),
    codCharge: new Decimal('0'),
    taxableTotal: new Decimal('2426.21'),
    cgstTotal: new Decimal('36.39'),
    sgstTotal: new Decimal('36.40'),
    utgstTotal: new Decimal('0'),
    igstTotal: new Decimal('0'),
    taxTotal: new Decimal('72.79'),
    roundOff: new Decimal('0'),
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
    shippedAt: null,
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
        imageUrl: 'https://img.example/a.jpg',
        hsnCode: '7117',
        quantity: 1,
        mrp: new Decimal('2999.00'),
        unitPrice: new Decimal('2400.00'),
        promotionDiscount: new Decimal('0'),
        couponDiscount: new Decimal('0'),
        taxableValue: new Decimal('2330.10'),
        taxRate: new Decimal('3.00'),
        cgstRate: new Decimal('1.50'),
        cgstAmount: new Decimal('34.95'),
        sgstRate: new Decimal('1.50'),
        sgstAmount: new Decimal('34.95'),
        utgstRate: new Decimal('0'),
        utgstAmount: new Decimal('0'),
        igstRate: new Decimal('0'),
        igstAmount: new Decimal('0'),
        taxAmount: new Decimal('69.90'),
        lineTotal: new Decimal('2400.00'),
        quantityShipped: 0,
        quantityCancelled: 0,
        quantityRefunded: 0,
      },
    ],
    statusHistory: [
      {
        id: randomUUID(),
        eventType: 'STATUS_CHANGE',
        fromStatus: 'PENDING_PAYMENT',
        toStatus: 'CONFIRMED',
        note: null,
        isCustomerVisible: true,
        actorType: 'SYSTEM',
        actorUserId: null,
        createdAt: NOW,
      },
      {
        id: randomUUID(),
        eventType: 'NOTE',
        fromStatus: 'CONFIRMED',
        toStatus: 'CONFIRMED',
        note: 'Internal: VIP customer',
        isCustomerVisible: false,
        actorType: 'STAFF',
        actorUserId: randomUUID(),
        createdAt: NOW,
      },
    ],
    payments: [
      {
        id: randomUUID(),
        attemptNo: 1,
        paymentMethod: 'ONLINE',
        status: 'CAPTURED',
        provider: 'mock',
        providerPaymentId: 'pay_1',
        amount: new Decimal('2499.00'),
        amountRefunded: new Decimal('0'),
        capturedAt: NOW,
        failedAt: null,
        createdAt: NOW,
        transactions: [],
      },
    ],
    shipments: [],
    refunds: [],
    invoiceRecords: [],
  };
}

/** Routes `order.findUnique` by the requested select (lock, detail, refund planning, contact). */
function mockOrder(t: ModuleTestApp, state: State) {
  t.m.order.findFirst.mockImplementation((args: { where: { userId?: string } }) =>
    Promise.resolve(args.where.userId === OWNER ? { id: ORDER_ID } : null),
  );
  t.m.order.findUnique.mockImplementation((args: { select: Record<string, unknown> }) => {
    const s = args.select;
    // Order detail, or the tax snapshot read by invoice issuance.
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
        payments:
          state.paymentStatus === 'CAPTURED'
            ? [{ id: 'pay-row', amount: new Decimal('2499.00') }]
            : [],
      });
    }
    if ('shipments' in s) {
      return Promise.resolve({ orderNumber: ORDER_NUMBER, status: state.status, shipments: [] });
    }
    if ('shippedAt' in s && !('id' in s))
      return Promise.resolve({ shippedAt: null, confirmedAt: NOW });
    return Promise.resolve(contact(state));
  });
}

function setup(state: Partial<State> = {}) {
  const deps = stubs();
  const t = buildModuleTestApp([ordersModuleWith(deps)], { now: NOW });
  const full: State = {
    status: 'CONFIRMED',
    paymentStatus: 'CAPTURED',
    paymentMethod: 'ONLINE',
    ...state,
  };
  mockOrder(t, full);
  t.m.notification.findUnique.mockResolvedValue(null);
  t.m.invoiceRecord.findFirst.mockResolvedValue(null);
  t.m.refund.findMany.mockResolvedValue([]);
  t.m.setting.findMany.mockResolvedValue([]);
  return { t, deps, owner: t.customer({ userId: OWNER }).headers };
}

describe('orders routes — guards & ownership', () => {
  it('guards every admin route (cancel needs orders.update + orders.approve)', () => {
    const { t } = setup();
    const module = ordersModuleWith(stubs())(t.container);
    const routes = expectAdminRoutesGuarded(module);
    expect(routes.map((r) => `${r.method} ${r.path} ${r.permissions.join('+')}`)).toEqual([
      'GET /orders orders.view',
      'GET /orders/:orderId orders.view',
      'POST /orders/:orderId/status orders.update',
      'POST /orders/:orderId/cancel orders.update+orders.approve',
      'POST /orders/:orderId/cancellation/approve orders.approve',
      'POST /orders/:orderId/cancellation/reject orders.approve',
      'POST /orders/:orderId/notes orders.update',
      'GET /orders/:orderId/invoice orders.view',
    ]);
  });

  it('requires a storefront token and a staff permission', async () => {
    const { t } = setup();
    expect((await request(t.app).get('/api/v1/me/orders')).status).toBe(401);
    const staff = t.staff({ permissions: ['orders.update'] }).headers;
    const res = await request(t.app)
      .post(`/api/v1/admin/orders/${ORDER_ID}/cancel`)
      .set(staff)
      .send({ reasonCode: 'OUT_OF_STOCK', comment: 'Damaged' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PERMISSION_DENIED');
  });

  it("another customer's order is 404 on every customer route (IDOR)", async () => {
    const { t } = setup();
    const other = t.customer().headers;
    const base = `/api/v1/me/orders/${ORDER_NUMBER}`;
    const responses = await Promise.all([
      request(t.app).get(base).set(other),
      request(t.app).get(`${base}/tracking`).set(other),
      request(t.app).get(`${base}/invoice`).set(other),
      request(t.app).post(`${base}/cancel`).set(other).send({ reasonCode: 'CHANGED_MIND' }),
    ]);
    expect(responses.map((r) => r.status)).toEqual([404, 404, 404, 404]);
    expect(t.m.order.update).not.toHaveBeenCalled();
  });
});

describe('customer orders', () => {
  it('lists own orders with cancel actions', async () => {
    const { t, owner } = setup();
    t.m.order.findMany.mockResolvedValue([
      {
        orderNumber: ORDER_NUMBER,
        status: 'CONFIRMED',
        paymentStatus: 'CAPTURED',
        placedAt: NOW,
        grandTotal: new Decimal('2499'),
        itemCount: 1,
        items: [{ imageUrl: 'https://img.example/a.jpg' }, { imageUrl: null }],
      },
    ]);
    t.m.order.count.mockResolvedValue(1);
    const res = await request(t.app).get('/api/v1/me/orders?limit=10').set(owner);
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({
      grandTotal: '2499.00',
      thumbnails: ['https://img.example/a.jpg'],
      actions: { canCancel: true, canRequestCancellation: false },
    });
    expect(t.m.order.findMany.mock.calls[0]?.[0].where.userId).toBe(OWNER);
    expect((await request(t.app).get('/api/v1/me/orders?limit=51').set(owner)).status).toBe(422);
  });

  it('detail hides internal notes and provider ids', async () => {
    const { t, owner } = setup();
    const res = await request(t.app).get(`/api/v1/me/orders/${ORDER_NUMBER}`).set(owner);
    expect(res.status).toBe(200);
    expect(res.body.data.statusHistory).toEqual([
      { status: 'CONFIRMED', at: NOW.toISOString(), note: null },
    ]);
    expect(JSON.stringify(res.body.data)).not.toContain('VIP');
    expect(JSON.stringify(res.body.data)).not.toContain('pay_1');
    expect(res.body.data.totals.grandTotal).toBe('2499.00');
  });

  it('self-cancel of a CONFIRMED prepaid order → CANCELLED + auto-approved refund (R-16)', async () => {
    const { t, owner, deps } = setup();
    t.m.refund.findUnique.mockImplementation((args: { select: Record<string, unknown> }) => {
      if ('payment' in args.select) {
        return Promise.resolve({
          id: 'rf',
          status: 'APPROVED',
          method: 'ORIGINAL_PAYMENT_METHOD',
          amount: new Decimal('2499.00'),
          reasonCode: 'ORDER_CANCELLED',
          payment: { id: 'pay-row', providerPaymentId: 'pay_1' },
        });
      }
      if ('items' in args.select) {
        return Promise.resolve({
          id: 'rf',
          refundNumber: 'RFD-261119-00001',
          status: 'PROCESSING',
          method: 'ORIGINAL_PAYMENT_METHOD',
          amount: new Decimal('2499.00'),
          orderId: ORDER_ID,
          paymentId: 'pay-row',
          items: [{ orderItemId: ITEM_ID, quantity: 1 }],
        });
      }
      return Promise.resolve({ status: 'COMPLETED' });
    });
    t.m.payment.findUnique.mockResolvedValue({
      amount: new Decimal('2499.00'),
      amountRefunded: new Decimal('0'),
    });
    const res = await request(t.app)
      .post(`/api/v1/me/orders/${ORDER_NUMBER}/cancel`)
      .set(owner)
      .send({ reasonCode: 'CHANGED_MIND' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      orderNumber: ORDER_NUMBER,
      previousStatus: 'CONFIRMED',
      status: 'CANCELLED',
      stock: { restored: true, transactionType: 'CANCELLATION_RESTORE' },
      coupon: null,
      refund: { refundNumber: 'RFD-261119-00001', status: 'COMPLETED', amount: '2499.00' },
      creditNote: null,
    });
    expect((t.m.$queryRaw.mock.calls[0]?.[0] as string[]).join('?')).toContain('FOR UPDATE');
    expect(deps.spies.releaseCoupon).toHaveBeenCalledWith(
      expect.anything(),
      ORDER_ID,
      'ORDER_CANCELLED_BEFORE_SHIPMENT',
    );
    expect(t.m.refund.create.mock.calls[0]?.[0].data).toMatchObject({ status: 'APPROVED' });
    expect(t.m.paymentTransaction.create.mock.calls[0]?.[0].data).toMatchObject({
      type: 'REFUND',
      providerStatus: 'COMPLETED',
    });
  });

  it('PROCESSING → cancellation request; PACKED → 409; CANCELLED → 200 idempotent', async () => {
    const processing = setup({ status: 'PROCESSING' });
    const req = await request(processing.t.app)
      .post(`/api/v1/me/orders/${ORDER_NUMBER}/cancel`)
      .set(processing.owner)
      .send({ reasonCode: 'OTHER', comment: 'Ordered twice' });
    expect(req.status).toBe(200);
    expect(req.body.data).toMatchObject({ status: 'CANCELLATION_REQUESTED' });
    expect(processing.t.m.order.update.mock.calls[0]?.[0].data.status).toBe(
      'CANCELLATION_REQUESTED',
    );
    const events = processing.t.m.notification.create.mock.calls.map(
      (c): unknown => c[0].data.event,
    );
    expect(events).toContain('CANCELLATION_REQUESTED');
    expect(processing.deps.spies.restore).not.toHaveBeenCalled();

    const packed = setup({ status: 'PACKED' });
    const denied = await request(packed.t.app)
      .post(`/api/v1/me/orders/${ORDER_NUMBER}/cancel`)
      .set(packed.owner)
      .send({ reasonCode: 'CHANGED_MIND' });
    expect(denied.status).toBe(409);
    expect(denied.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect(denied.body.error.details[0].meta).toEqual({
      currentStatus: 'PACKED',
      allowedFrom: ['CONFIRMED', 'PROCESSING'],
    });

    const done = setup({ status: 'CANCELLED' });
    const again = await request(done.t.app)
      .post(`/api/v1/me/orders/${ORDER_NUMBER}/cancel`)
      .set(done.owner)
      .send({ reasonCode: 'CHANGED_MIND' });
    expect(again.status).toBe(200);
    expect(again.body.data.status).toBe('CANCELLED');
    expect(done.t.m.order.update).not.toHaveBeenCalled();
  });

  it('validates the cancel body (comment required for OTHER)', async () => {
    const { t, owner } = setup();
    const res = await request(t.app)
      .post(`/api/v1/me/orders/${ORDER_NUMBER}/cancel`)
      .set(owner)
      .send({ reasonCode: 'OTHER' });
    expect(res.status).toBe(422);
    expect(res.body.error.details[0].field).toBe('comment');
  });

  it('invoice download: 404 before issue, PDF once issued', async () => {
    const { t, owner } = setup({ status: 'SHIPPED' });
    const missing = await request(t.app)
      .get(`/api/v1/me/orders/${ORDER_NUMBER}/invoice`)
      .set(owner);
    expect(missing.status).toBe(404);
    expect(missing.body.error.details[0].code).toBe('INVOICE_NOT_AVAILABLE');

    t.m.invoiceRecord.findFirst.mockResolvedValue(invoiceDocRow());
    const res = await request(t.app)
      .get(`/api/v1/me/orders/${ORDER_NUMBER}/invoice?type=TAX_INVOICE`)
      .set(owner)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => {
          cb(null, Buffer.concat(chunks));
        });
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe('attachment; filename="INV-2627-000001.pdf"');
    expect((res.body as Buffer).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('tracking returns shipments of the owned order', async () => {
    const { t, owner } = setup({ status: 'SHIPPED' });
    const res = await request(t.app).get(`/api/v1/me/orders/${ORDER_NUMBER}/tracking`).set(owner);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      orderNumber: ORDER_NUMBER,
      orderStatus: 'SHIPPED',
      shipments: [],
    });
  });
});

function invoiceDocRow() {
  return {
    id: randomUUID(),
    invoiceType: 'TAX_INVOICE',
    invoiceNumber: 'INV/2627/000001',
    invoiceDate: new Date('2026-11-19T00:00:00.000Z'),
    sellerGstin: '27ABCDE1234F1Z5',
    sellerStateCode: '27',
    buyerGstin: null,
    placeOfSupplyStateCode: '27',
    supplyType: 'INTRA_STATE',
    taxableTotal: new Decimal('2426.21'),
    taxTotal: new Decimal('72.79'),
    grandTotal: new Decimal('2499.00'),
    createdAt: NOW,
    sellerState: { name: 'Maharashtra' },
    posState: { name: 'Maharashtra' },
    originalInvoice: null,
    refund: null,
    taxTransactions: [
      {
        orderItemId: ITEM_ID,
        lineType: 'ITEM',
        component: 'CGST',
        hsnCode: '7117',
        rate: new Decimal('3'),
        taxableValue: new Decimal('2330.10'),
        amount: new Decimal('34.95'),
      },
      {
        orderItemId: ITEM_ID,
        lineType: 'ITEM',
        component: 'SGST',
        hsnCode: '7117',
        rate: new Decimal('3'),
        taxableValue: new Decimal('2330.10'),
        amount: new Decimal('34.95'),
      },
    ],
    order: {
      orderNumber: ORDER_NUMBER,
      placedAt: NOW,
      paymentMethod: 'ONLINE',
      roundOff: new Decimal('0'),
      customerNameSnapshot: 'Riya Sharma',
      billingAddressSnapshot: { fullName: 'Riya Sharma', line1: '12 MG Road', city: 'Pune' },
      shippingAddressSnapshot: { fullName: 'Riya Sharma', line1: '12 MG Road', city: 'Pune' },
      buyerLegalName: null,
      items: [
        {
          id: ITEM_ID,
          lineNo: 1,
          productName: 'Meera Jhumka',
          variantName: 'Gold',
          sku: 'EAR-JH-001-G',
          quantity: 1,
        },
      ],
    },
  };
}

describe('admin orders', () => {
  it('status: non-canonical transition → 409 with allowed[]', async () => {
    const { t } = setup({ status: 'CONFIRMED' });
    const res = await request(t.app)
      .post(`/api/v1/admin/orders/${ORDER_ID}/status`)
      .set(t.staff({ permissions: ALL }).headers)
      .send({ status: 'PACKED' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect(res.body.error.details[0].meta.allowed).toEqual([
      'PROCESSING',
      'CANCELLATION_REQUESTED',
      'CANCELLED',
    ]);
  });

  it('status SHIPPED needs a shipment with an AWB, then issues the invoice', async () => {
    const { t } = setup({ status: 'PACKED' });
    const auth = t.staff({ permissions: ALL }).headers;
    t.m.shipment.findFirst.mockResolvedValueOnce(null);
    const noAwb = await request(t.app)
      .post(`/api/v1/admin/orders/${ORDER_ID}/status`)
      .set(auth)
      .send({ status: 'SHIPPED' });
    expect(noAwb.status).toBe(422);
    expect(noAwb.body.error.details[0].code).toBe('AWB_REQUIRED');

    t.m.shipment.findFirst.mockResolvedValueOnce({
      id: randomUUID(),
      shipmentNumber: 'SHP-261119-00001',
      awbNumber: 'AWB123',
      provider: 'MockExpress',
    });
    // Invoice issuance reads the tax snapshot (items with tax fields) of the same order.
    const res = await request(t.app)
      .post(`/api/v1/admin/orders/${ORDER_ID}/status`)
      .set(auth)
      .send({ status: 'SHIPPED', note: 'Handed over' });
    expect(res.status).toBe(200);
    expect(t.m.order.update.mock.calls[0]?.[0].data).toEqual({ status: 'SHIPPED', shippedAt: NOW });
    expect(t.m.invoiceRecord.create.mock.calls[0]?.[0].data).toMatchObject({
      invoiceType: 'TAX_INVOICE',
      invoiceNumber: 'INV/2627/000001',
    });
    const events = t.m.notification.create.mock.calls.map((c): unknown => c[0].data.event);
    expect(events).toEqual(expect.arrayContaining(['ORDER_SHIPPED', 'INVOICE_AVAILABLE']));
    // Order status change, then the invoice issuance in the same transaction (invoice.issued).
    expect(t.m.auditLog.create.mock.calls.map((c): unknown => c[0].data.action)).toEqual([
      'STATUS_CHANGE',
      'CREATE',
    ]);
    expect(t.m.auditLog.create.mock.calls[1]?.[0].data).toMatchObject({
      module: 'invoices',
      entityType: 'InvoiceRecord',
      actorType: 'STAFF',
    });
  });

  it('admin cancel of a paid PACKED order → refund REQUESTED (maker-checker applies later)', async () => {
    const { t, deps } = setup({ status: 'PACKED' });
    const res = await request(t.app)
      .post(`/api/v1/admin/orders/${ORDER_ID}/cancel`)
      .set(t.staff({ permissions: ALL }).headers)
      .send({ reasonCode: 'OUT_OF_STOCK', comment: 'Stone damaged during QC' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      previousStatus: 'PACKED',
      status: 'CANCELLED',
      refund: { status: 'REQUESTED', amount: '2499.00' },
    });
    expect(deps.spies.restore).toHaveBeenCalled();
    expect(t.m.paymentTransaction.create).not.toHaveBeenCalled();
  });

  it('admin cancel from SHIPPED → 409; approve without a request → 409', async () => {
    const { t } = setup({ status: 'SHIPPED' });
    const auth = t.staff({ permissions: ALL }).headers;
    const cancel = await request(t.app)
      .post(`/api/v1/admin/orders/${ORDER_ID}/cancel`)
      .set(auth)
      .send({ reasonCode: 'OTHER', comment: 'Too late' });
    expect(cancel.status).toBe(409);
    const approve = await request(t.app)
      .post(`/api/v1/admin/orders/${ORDER_ID}/cancellation/approve`)
      .set(auth)
      .send({});
    expect(approve.status).toBe(409);
    expect(approve.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('admin cancel with orders.update alone is denied, audited, and changes nothing (D-58)', async () => {
    const { t } = setup();
    const res = await request(t.app)
      .post(`/api/v1/admin/orders/${ORDER_ID}/cancel`)
      .set(t.staff({ permissions: ['orders.view', 'orders.update'] }).headers)
      .send({ reasonCode: 'CUSTOMER_REQUEST', comment: 'Customer asked by phone' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PERMISSION_DENIED');
    expect(t.m.order.update).not.toHaveBeenCalled();
    expect(t.m.orderStatusHistory.create).not.toHaveBeenCalled();
    const denied = t.m.auditLog.create.mock.calls.map(
      (c): unknown => (c[0] as { data: { action: string } }).data.action,
    );
    expect(denied).toContain('PERMISSION_DENIED');
  });

  it('reject cancellation → back to PROCESSING and CANCELLATION_REJECTED', async () => {
    const { t } = setup({ status: 'CANCELLATION_REQUESTED' });
    const res = await request(t.app)
      .post(`/api/v1/admin/orders/${ORDER_ID}/cancellation/reject`)
      .set(t.staff({ permissions: ['orders.approve'] }).headers)
      .send({ reason: 'Already packed for dispatch' });
    expect(res.status).toBe(200);
    expect(t.m.order.update.mock.calls[0]?.[0].data).toEqual({ status: 'PROCESSING' });
    const events = t.m.notification.create.mock.calls.map((c): unknown => c[0].data.event);
    expect(events).toContain('CANCELLATION_REJECTED');
  });

  it('notes are internal history rows; detail lists them with allowedTransitions', async () => {
    const { t } = setup();
    const auth = t.staff({ permissions: ALL }).headers;
    const res = await request(t.app)
      .post(`/api/v1/admin/orders/${ORDER_ID}/notes`)
      .set(auth)
      .send({ note: 'Customer called' });
    expect(res.status).toBe(201);
    expect(t.m.orderStatusHistory.create.mock.calls[0]?.[0].data).toMatchObject({
      eventType: 'NOTE',
      isCustomerVisible: false,
    });
    const detail = await request(t.app).get(`/api/v1/admin/orders/${ORDER_ID}`).set(auth);
    expect(detail.status).toBe(200);
    expect(detail.body.data.notes[0].note).toBe('Internal: VIP customer');
    expect(detail.body.data.allowedTransitions).toEqual([
      'PROCESSING',
      'CANCELLATION_REQUESTED',
      'CANCELLED',
    ]);
  });

  it('admin invoice download streams the PDF and audits PRINT', async () => {
    const { t } = setup({ status: 'SHIPPED' });
    t.m.invoiceRecord.findFirst.mockResolvedValue(invoiceDocRow());
    const res = await request(t.app)
      .get(`/api/v1/admin/orders/${ORDER_ID}/invoice`)
      .set(t.staff({ permissions: ['orders.view'] }).headers);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(t.m.auditLog.create.mock.calls[0]?.[0].data).toMatchObject({
      action: 'PRINT',
      module: 'orders',
    });
  });
});

describe('Phase 4 catalogue gaps — tax snapshot vs later rate change', () => {
  it('TC-044: after a rate change, order detail and the invoice keep the snapshotted tax', async () => {
    const { t } = setup({ status: 'PACKED' });
    const auth = t.staff({ permissions: ALL }).headers;
    // The masters now say 18 % for the same HSN (a later rate change). Nothing may read them.
    const newRate = {
      id: randomUUID(),
      name: 'GST 18%',
      ratePercent: new Decimal('18.00'),
      cgstRate: new Decimal('9.00'),
      sgstRate: new Decimal('9.00'),
      igstRate: new Decimal('18.00'),
      isActive: true,
    };
    t.m.taxRate.findMany.mockResolvedValue([newRate]);
    t.m.taxRate.findFirst.mockResolvedValue(newRate);
    t.m.taxRate.findUnique.mockResolvedValue(newRate);
    t.m.productTaxAssignment.findMany.mockResolvedValue([
      { id: randomUUID(), hsnCode: '7117', taxRateId: newRate.id, taxRate: newRate },
    ]);
    t.m.productTaxAssignment.findFirst.mockResolvedValue({
      id: randomUUID(),
      hsnCode: '7117',
      taxRateId: newRate.id,
      taxRate: newRate,
    });

    const detail = await request(t.app).get(`/api/v1/admin/orders/${ORDER_ID}`).set(auth);
    expect(detail.status).toBe(200);
    expect(detail.body.data.totals).toMatchObject({
      taxableTotal: '2426.21',
      cgstTotal: '36.39',
      sgstTotal: '36.40',
      taxTotal: '72.79',
      grandTotal: '2499.00',
    });
    expect(detail.body.data.items[0].tax).toMatchObject({
      ratePercent: '3.00',
      cgst: { rate: '1.50', amount: '34.95' },
      sgst: { rate: '1.50', amount: '34.95' },
      taxAmount: '69.90',
    });

    // Invoice issuance on SHIPPED builds the ledger from the order snapshot, not the masters.
    t.m.shipment.findFirst.mockResolvedValueOnce({
      id: randomUUID(),
      shipmentNumber: 'SHP-261119-00001',
      awbNumber: 'AWB123',
      provider: 'MockExpress',
    });
    const shipped = await request(t.app)
      .post(`/api/v1/admin/orders/${ORDER_ID}/status`)
      .set(auth)
      .send({ status: 'SHIPPED' });
    expect(shipped.status).toBe(200);
    const ledger = t.m.taxTransaction.createMany.mock.calls[0]?.[0].data as {
      lineType: string;
      component: string;
      rate: Decimal;
      amount: Decimal;
    }[];
    const itemRows = ledger.filter((r) => r.lineType === 'ITEM');
    expect(itemRows.map((r) => [r.component, new Decimal(r.amount).toFixed(2)])).toEqual([
      ['CGST', '34.95'],
      ['SGST', '34.95'],
    ]);
    expect(itemRows.every((r) => new Decimal(r.rate).toFixed(2) === '3.00')).toBe(true);
    expect(ledger.some((r) => new Decimal(r.rate).toFixed(2) === '18.00')).toBe(false);
    const invoice = t.m.invoiceRecord.create.mock.calls[0]?.[0].data as {
      taxTotal: Decimal;
    };
    expect(new Decimal(invoice.taxTotal).toFixed(2)).toBe('72.79');

    // Neither read path consulted the current tax masters, and the order row was not rewritten.
    for (const fn of [
      t.m.taxRate.findMany,
      t.m.taxRate.findFirst,
      t.m.taxRate.findUnique,
      t.m.productTaxAssignment.findMany,
      t.m.productTaxAssignment.findFirst,
    ]) {
      expect(fn).not.toHaveBeenCalled();
    }
    for (const call of t.m.order.update.mock.calls) {
      const data = (call[0] as { data: Record<string, unknown> }).data;
      for (const key of ['taxTotal', 'taxableTotal', 'cgstTotal', 'sgstTotal', 'igstTotal']) {
        expect(data).not.toHaveProperty(key);
      }
    }
    expect(t.m.orderItem.update).not.toHaveBeenCalled();
  });
});

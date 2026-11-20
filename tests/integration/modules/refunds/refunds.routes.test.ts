/**
 * Admin refunds through the real Express app — API_DOCUMENTATION.md §4.11, R-13/R-15/R-16/R-18.
 * MOCKED DB (tests/helpers/mockDb.ts): verifies guards, re-auth + Idempotency-Key, maker-checker,
 * state errors and the post-commit gateway step; no SQL is executed.
 */
import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { requestHash } from '../../../../src/core/middleware/idempotency.js';
import { Decimal } from '../../../../src/lib/money.js';
import { createRefundsModule } from '../../../../src/modules/refunds/index.js';
import { buildModuleTestApp, type ModuleTestApp } from '../../../helpers/container.js';
import { expectAdminRoutesGuarded } from '../../../helpers/routeTable.js';

const NOW = new Date('2026-11-19T06:30:00.000Z');
const REFUND_ID = '6e3d8b20-0000-4b00-8000-000000000001';
const ORDER_ID = '6e3d8b20-0000-4b00-8000-0000000000b1';
const MAKER = '6e3d8b20-0000-4b00-8000-0000000000c1';
const ITEM_ID = '6e3d8b20-0000-4b00-8000-0000000000a1';
const ALL = ['refunds.view', 'refunds.create', 'refunds.update', 'refunds.approve'];

const idemKey = (): string => randomUUID();

const orderContact = {
  id: ORDER_ID,
  orderNumber: 'ORD-261119-00042',
  userId: randomUUID(),
  grandTotal: new Decimal('2499.00'),
  paymentMethod: 'ONLINE',
  customerPhoneSnapshot: null,
  user: { firstName: 'Riya', email: 'riya@example.com', phone: null },
};

function detail(status: string, over: Record<string, unknown> = {}) {
  return {
    id: REFUND_ID,
    refundNumber: 'RFD-261119-00001',
    orderId: ORDER_ID,
    paymentId: 'pay-row',
    status,
    method: 'ORIGINAL_PAYMENT_METHOD',
    reasonCode: 'OTHER',
    reasonText: 'Goodwill',
    itemsAmount: new Decimal('2400.00'),
    shippingAmount: new Decimal('99.00'),
    amount: new Decimal('2499.00'),
    taxableValue: new Decimal('2330.10'),
    taxAmount: new Decimal('69.90'),
    restock: false,
    requestedByType: 'STAFF',
    requestedById: MAKER,
    approvedById: null,
    approvedAt: null,
    rejectedById: null,
    rejectedAt: null,
    rejectionReason: null,
    providerRefundId: null,
    payoutReference: null,
    processingAt: null,
    completedAt: null,
    failedAt: null,
    failureReason: null,
    retryCount: 0,
    createdAt: NOW,
    order: { orderNumber: 'ORD-261119-00042' },
    items: [
      {
        orderItemId: ITEM_ID,
        quantity: 1,
        amount: new Decimal('2400.00'),
        taxableValue: new Decimal('2330.10'),
        taxAmount: new Decimal('69.90'),
        orderItem: { sku: 'EAR-JH-001-G', productName: 'Meera Jhumka', variantName: 'Gold' },
      },
    ],
    invoiceRecords: [],
    ...over,
  };
}

/** Routes `refund.findUnique` by select shape (lock head, locked row, gateway, completion, DTO). */
function mockRefund(
  t: ModuleTestApp,
  state: {
    status: string;
    method?: string;
    requestedById?: string | null;
    requestedByType?: string;
  },
) {
  const method = state.method ?? 'ORIGINAL_PAYMENT_METHOD';
  t.m.refund.findUnique.mockImplementation((args: { select: Record<string, unknown> }) => {
    const s = args.select;
    const keys = Object.keys(s);
    if (keys.length === 1 && 'orderId' in s) return Promise.resolve({ orderId: ORDER_ID });
    if ('order' in s && 'retryCount' in s && !('invoiceRecords' in s)) {
      return Promise.resolve({
        id: REFUND_ID,
        refundNumber: 'RFD-261119-00001',
        orderId: ORDER_ID,
        status: state.status,
        method,
        amount: new Decimal('2499.00'),
        shippingAmount: new Decimal('99.00'),
        retryCount: 0,
        requestedByType: state.requestedByType ?? 'STAFF',
        requestedById: state.requestedById === undefined ? MAKER : state.requestedById,
        items: [{ orderItemId: ITEM_ID, quantity: 1 }],
        order: orderContact,
      });
    }
    if ('payment' in s) {
      return Promise.resolve({
        id: REFUND_ID,
        status: 'APPROVED',
        method,
        amount: new Decimal('2499.00'),
        reasonCode: 'OTHER',
        payment: { id: 'pay-row', providerPaymentId: 'pay_1' },
      });
    }
    if ('invoiceRecords' in s) return Promise.resolve(detail(state.status, { method }));
    // markRefundCompleted
    return Promise.resolve({
      id: REFUND_ID,
      refundNumber: 'RFD-261119-00001',
      status: 'PROCESSING',
      method,
      amount: new Decimal('2499.00'),
      orderId: ORDER_ID,
      paymentId: 'pay-row',
      items: [{ orderItemId: ITEM_ID, quantity: 1 }],
    });
  });
}

function setup(state: Parameters<typeof mockRefund>[1] = { status: 'REQUESTED' }) {
  const t = buildModuleTestApp([createRefundsModule], { now: NOW });
  mockRefund(t, state);
  t.m.idempotencyKey.create.mockResolvedValue({ id: 'idem-row' });
  t.m.notification.findUnique.mockResolvedValue(null);
  t.m.invoiceRecord.findFirst.mockResolvedValue(null);
  t.m.payment.findUnique.mockResolvedValue({
    amount: new Decimal('2499.00'),
    amountRefunded: new Decimal('0'),
  });
  t.m.order.findUnique.mockResolvedValue({ ...orderContact, refundedTotal: new Decimal('0') });
  return t;
}

const approve = (t: ModuleTestApp, headers: Record<string, string>, body: object = {}) =>
  request(t.app)
    .post(`/api/v1/admin/refunds/${REFUND_ID}/approve`)
    .set(headers)
    .set('Idempotency-Key', idemKey())
    .send(body);

describe('refunds routes — guards', () => {
  it('declares permissions and re-auth on approve/retry/complete', () => {
    const t = setup();
    const module = createRefundsModule(t.container);
    const routes = expectAdminRoutesGuarded(module, ['POST /refunds/:refundId/reject']);
    expect(
      routes.map((r) => `${r.method} ${r.path} ${r.permissions.join('+')}${r.reauth ? ' R' : ''}`),
    ).toEqual([
      'GET /refunds refunds.view',
      'GET /refunds/:refundId refunds.view',
      'POST /refunds refunds.create',
      'POST /refunds/:refundId/approve refunds.approve R',
      'POST /refunds/:refundId/reject refunds.approve',
      'POST /refunds/:refundId/retry refunds.update R',
      'POST /refunds/:refundId/complete refunds.update R',
    ]);
  });

  it('approve without recent re-auth → 403 REAUTH_REQUIRED; without Idempotency-Key → 400', async () => {
    const t = setup();
    const noReauth = await approve(t, t.staff({ permissions: ALL }).headers);
    expect(noReauth.status).toBe(403);
    expect(noReauth.body.error.code).toBe('REAUTH_REQUIRED');

    const res = await request(t.app)
      .post(`/api/v1/admin/refunds/${REFUND_ID}/approve`)
      .set(t.staff({ permissions: ALL, reauthenticated: true }).headers)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(t.m.refund.update).not.toHaveBeenCalled();
  });

  it('POST /admin/refunds requires an Idempotency-Key and refunds.create', async () => {
    const t = setup();
    const body = { orderId: randomUUID(), reason: 'Damaged on arrival' };
    const missing = await request(t.app)
      .post('/api/v1/admin/refunds')
      .set(t.staff({ permissions: ALL }).headers)
      .send(body);
    expect(missing.status).toBe(400);
    const denied = await request(t.app)
      .post('/api/v1/admin/refunds')
      .set(t.staff({ permissions: ['refunds.view'] }).headers)
      .set('Idempotency-Key', idemKey())
      .send(body);
    expect(denied.status).toBe(403);
  });
});

describe('refund maker-checker (R-16 / OQ-64)', () => {
  it('requester cannot approve their own refund → 403 SELF_APPROVAL', async () => {
    const t = setup();
    const res = await approve(
      t,
      t.staff({ userId: MAKER, permissions: ALL, reauthenticated: true }).headers,
    );
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.details[0].code).toBe('SELF_APPROVAL');
    expect(t.m.refund.update).not.toHaveBeenCalled();
  });

  it('Superadmin may self-approve only with a justification note', async () => {
    const t = setup();
    const su = t.staff({ userId: MAKER, isSuperadmin: true, reauthenticated: true }).headers;
    const noNote = await approve(t, su);
    expect(noNote.status).toBe(422);
    expect(noNote.body.error.details[0].code).toBe('JUSTIFICATION_REQUIRED');
    const ok = await approve(t, su, { note: 'Two-person team, owner approval' });
    expect(ok.status).toBe(200);
  });

  it('a different approver: APPROVED → PROCESSING → gateway → audit REFUND_APPROVE', async () => {
    const t = setup();
    const checker = t.staff({ permissions: ALL, reauthenticated: true });
    const res = await approve(t, checker.headers, { note: 'Verified with customer' });
    expect(res.status).toBe(200);
    const updates = t.m.refund.update.mock.calls.map((c): unknown => c[0].data.status);
    expect(updates).toEqual(['APPROVED', 'PROCESSING', 'COMPLETED']);
    expect(t.m.refund.update.mock.calls[0]?.[0].data).toMatchObject({
      approvedById: checker.ctx.userId,
      approvedAt: NOW,
    });
    const audit = t.m.auditLog.create.mock.calls.map((c): unknown => c[0].data);
    expect(audit[0]).toMatchObject({ action: 'REFUND_APPROVE', module: 'refunds' });
    const events = t.m.notification.create.mock.calls.map((c): unknown => c[0].data.event);
    expect(events).toEqual(expect.arrayContaining(['REFUND_INITIATED', 'REFUND_COMPLETED']));
    expect(t.m.paymentTransaction.create.mock.calls[0]?.[0].data).toMatchObject({
      type: 'REFUND',
      refundId: REFUND_ID,
    });
  });

  it('a SYSTEM-made refund (admin cancel) can be approved by any checker', async () => {
    const t = setup({ status: 'REQUESTED', requestedByType: 'SYSTEM', requestedById: null });
    const res = await approve(
      t,
      t.staff({ userId: MAKER, permissions: ALL, reauthenticated: true }).headers,
    );
    expect(res.status).toBe(200);
  });

  it('approving a non-REQUESTED refund → 409 INVALID_STATE_TRANSITION', async () => {
    const t = setup({ status: 'COMPLETED' });
    const res = await approve(t, t.staff({ permissions: ALL, reauthenticated: true }).headers);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect(res.body.error.details[0].meta.currentStatus).toBe('COMPLETED');
  });

  it('replays the stored response for a repeated Idempotency-Key', async () => {
    const t = setup();
    const duplicate = Object.assign(new Error('dup'), { code: 'P2002', clientVersion: '7.10.1' });
    t.m.idempotencyKey.create.mockRejectedValueOnce(duplicate);
    const key = idemKey();
    t.m.idempotencyKey.findFirst.mockResolvedValueOnce({
      requestHash: requestHash('POST', `/api/v1/admin/refunds/${REFUND_ID}/approve`, {}),
      status: 'COMPLETED',
      responseRef: { status: 200, body: { success: true, data: { replayed: true } } },
    });
    const res = await request(t.app)
      .post(`/api/v1/admin/refunds/${REFUND_ID}/approve`)
      .set(t.staff({ permissions: ALL, reauthenticated: true }).headers)
      .set('Idempotency-Key', key)
      .send({});
    expect(res.status).toBe(200);
    expect(res.headers['idempotent-replayed']).toBe('true');
    expect(t.m.refund.update).not.toHaveBeenCalled();
  });
});

describe('reject, retry, complete', () => {
  it('reject → REJECTED with REFUND_REJECTED notification', async () => {
    const t = setup();
    const res = await request(t.app)
      .post(`/api/v1/admin/refunds/${REFUND_ID}/reject`)
      .set(t.staff({ permissions: ALL }).headers)
      .send({ reason: 'Duplicate request' });
    expect(res.status).toBe(200);
    expect(t.m.refund.update.mock.calls[0]?.[0].data).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'Duplicate request',
    });
    const events = t.m.notification.create.mock.calls.map((c): unknown => c[0].data.event);
    expect(events).toContain('REFUND_REJECTED');
  });

  it('retry only from FAILED', async () => {
    const t = setup({ status: 'REQUESTED' });
    const res = await request(t.app)
      .post(`/api/v1/admin/refunds/${REFUND_ID}/retry`)
      .set(t.staff({ permissions: ALL, reauthenticated: true }).headers)
      .set('Idempotency-Key', idemKey())
      .send({});
    expect(res.status).toBe(409);
  });

  it('complete (R-13): BANK_TRANSFER APPROVED → COMPLETED with the UTR', async () => {
    const t = setup({ status: 'APPROVED', method: 'BANK_TRANSFER' });
    const res = await request(t.app)
      .post(`/api/v1/admin/refunds/${REFUND_ID}/complete`)
      .set(t.staff({ permissions: ALL, reauthenticated: true }).headers)
      .set('Idempotency-Key', idemKey())
      .send({ utr: 'UTR0001234', transferredAt: '2026-11-19T05:00:00.000Z' });
    expect(res.status).toBe(200);
    expect(t.m.refund.update.mock.calls[0]?.[0].data).toMatchObject({
      status: 'COMPLETED',
      payoutReference: 'UTR0001234',
    });
    expect(t.m.order.update.mock.calls[0]?.[0].data.paymentStatus).toBe('REFUNDED');
    expect(t.m.auditLog.create.mock.calls[0]?.[0].data).toMatchObject({ action: 'STATUS_CHANGE' });

    const future = await request(t.app)
      .post(`/api/v1/admin/refunds/${REFUND_ID}/complete`)
      .set(t.staff({ permissions: ALL, reauthenticated: true }).headers)
      .set('Idempotency-Key', idemKey())
      .send({ utr: 'UTR0001234', transferredAt: '2026-11-20T05:00:00.000Z' });
    expect(future.status).toBe(422);
  });

  it('create: STORE_CREDIT is rejected (OQ-13) and bankDetails are not accepted (OQ-63)', async () => {
    const t = setup();
    const headers = t.staff({ permissions: ALL }).headers;
    const bank = await request(t.app)
      .post('/api/v1/admin/refunds')
      .set(headers)
      .set('Idempotency-Key', idemKey())
      .send({
        orderId: randomUUID(),
        reason: 'COD refund',
        method: 'BANK_TRANSFER',
        bankDetails: { accountName: 'X', accountNumber: '123', ifsc: 'HDFC0000001' },
      });
    expect(bank.status).toBe(422);
    t.m.order.findUnique.mockResolvedValue({
      id: ORDER_ID,
      status: 'DELIVERED',
      paymentMethod: 'ONLINE',
      paymentStatus: 'CAPTURED',
      grandTotal: new Decimal('2499.00'),
      items: [],
      payments: [{ id: 'pay-row', amount: new Decimal('2499.00') }],
    });
    t.m.refund.findMany.mockResolvedValue([]);
    const credit = await request(t.app)
      .post('/api/v1/admin/refunds')
      .set(headers)
      .set('Idempotency-Key', idemKey())
      .send({ orderId: ORDER_ID, reason: 'Goodwill', method: 'STORE_CREDIT' });
    expect(credit.status).toBe(422);
    expect(credit.body.error.details[0].code).toBe('METHOD_NOT_SUPPORTED');
  });

  it('create: 201 REQUESTED with server-computed amount and audit CREATE', async () => {
    const t = setup();
    t.m.order.findUnique.mockResolvedValue({
      id: ORDER_ID,
      status: 'DELIVERED',
      paymentMethod: 'ONLINE',
      paymentStatus: 'CAPTURED',
      grandTotal: new Decimal('2499.00'),
      items: [
        {
          id: ITEM_ID,
          quantity: 1,
          lineTotal: new Decimal('2400.00'),
          taxAmount: new Decimal('69.90'),
        },
      ],
      payments: [{ id: 'pay-row', amount: new Decimal('2499.00') }],
    });
    t.m.refund.findMany.mockResolvedValue([]);
    const res = await request(t.app)
      .post('/api/v1/admin/refunds')
      .set(t.staff({ permissions: ALL }).headers)
      .set('Idempotency-Key', idemKey())
      .send({
        orderId: ORDER_ID,
        reason: 'Damaged',
        items: [{ orderItemId: ITEM_ID, quantity: 1 }],
        amount: '2400.00',
      });
    expect(res.status).toBe(201);
    expect(t.m.refund.create.mock.calls[0]?.[0].data).toMatchObject({
      status: 'REQUESTED',
      requestedByType: 'STAFF',
    });
    expect(t.m.auditLog.create.mock.calls[0]?.[0].data).toMatchObject({ action: 'CREATE' });
  });

  it('list and detail map money as strings', async () => {
    const t = setup();
    t.m.refund.findMany.mockResolvedValue([
      {
        id: REFUND_ID,
        refundNumber: 'RFD-261119-00001',
        orderId: ORDER_ID,
        status: 'REQUESTED',
        method: 'ORIGINAL_PAYMENT_METHOD',
        amount: new Decimal('2499'),
        reasonCode: 'OTHER',
        requestedByType: 'STAFF',
        createdAt: NOW,
        completedAt: null,
        order: { orderNumber: 'ORD-261119-00042' },
      },
    ]);
    t.m.refund.count.mockResolvedValue(1);
    const headers = t.staff({ permissions: ['refunds.view'] }).headers;
    const list = await request(t.app)
      .get('/api/v1/admin/refunds?status=REQUESTED,FAILED')
      .set(headers);
    expect(list.status).toBe(200);
    expect(list.body.data[0].amount).toBe('2499.00');
    const one = await request(t.app).get(`/api/v1/admin/refunds/${REFUND_ID}`).set(headers);
    expect(one.status).toBe(200);
    expect(one.body.data).toMatchObject({ shippingRefund: '99.00', creditNote: null });
  });
});

describe('Phase 4 catalogue gaps — credit note on refund approval', () => {
  it('TC-046: approving a refund on an invoiced order issues a CREDIT_NOTE with negative tax rows', async () => {
    const t = setup();
    const INVOICE_ID = '6e3d8b20-0000-4b00-8000-0000000000d1';
    const row = (lineType: string, component: string, taxable: string, amount: string) => ({
      orderItemId: lineType === 'ITEM' ? ITEM_ID : null,
      lineType,
      component,
      hsnCode: lineType === 'ITEM' ? '7117' : '9965',
      rate: lineType === 'ITEM' ? new Decimal('3.00') : new Decimal('5.00'),
      taxableValue: new Decimal(taxable),
      amount: new Decimal(amount),
    });
    t.m.invoiceRecord.findFirst.mockImplementation((args: { where: Record<string, unknown> }) => {
      if (args.where.invoiceType === 'TAX_INVOICE') {
        return Promise.resolve({
          id: INVOICE_ID,
          sellerGstin: '27ABCDE1234F1Z5',
          sellerStateCode: '27',
          buyerGstin: null,
          placeOfSupplyStateCode: '27',
          supplyType: 'INTRA_STATE',
          taxTransactions: [
            row('ITEM', 'CGST', '2330.10', '34.95'),
            row('ITEM', 'SGST', '2330.10', '34.95'),
            row('SHIPPING', 'CGST', '94.29', '2.36'),
            row('SHIPPING', 'SGST', '94.29', '2.35'),
          ],
        });
      }
      return Promise.resolve(null); // no credit note yet for this refund
    });
    t.m.invoiceRecord.findMany.mockResolvedValue([]);
    t.m.orderItem.findMany.mockResolvedValue([{ id: ITEM_ID, quantity: 1 }]);

    const checker = t.staff({ permissions: ALL, reauthenticated: true });
    const res = await approve(t, checker.headers, { note: 'Verified with customer' });
    expect(res.status).toBe(200);

    expect(t.m.invoiceRecord.create).toHaveBeenCalledTimes(1);
    const cn = t.m.invoiceRecord.create.mock.calls[0]?.[0].data as Record<string, unknown> & {
      taxableTotal: Decimal;
      taxTotal: Decimal;
      grandTotal: Decimal;
    };
    expect(cn).toMatchObject({
      invoiceType: 'CREDIT_NOTE',
      invoiceNumber: 'CN/2627/000001',
      orderId: ORDER_ID,
      refundId: REFUND_ID,
      originalInvoiceId: INVOICE_ID,
      supplyType: 'INTRA_STATE',
    });
    expect([cn.taxableTotal.toFixed(2), cn.taxTotal.toFixed(2), cn.grandTotal.toFixed(2)]).toEqual([
      '2424.39',
      '74.61',
      '2499.00',
    ]);
    const ledger = t.m.taxTransaction.createMany.mock.calls[0]?.[0].data as {
      documentType: string;
      refundId: string;
      taxableValue: Decimal;
      amount: Decimal;
    }[];
    expect(ledger).toHaveLength(4);
    for (const r of ledger) {
      expect(r).toMatchObject({ documentType: 'CREDIT_NOTE', refundId: REFUND_ID });
      expect(r.taxableValue.isNegative()).toBe(true);
      expect(r.amount.isNegative()).toBe(true);
    }
    const approveAudit = t.m.auditLog.create.mock.calls
      .map((c) => (c[0] as { data: Record<string, unknown> }).data)
      .find((d) => d.action === 'REFUND_APPROVE') as
      { newValues: { _event: { metadata: Record<string, unknown> } } } | undefined;
    expect(approveAudit?.newValues._event.metadata).toMatchObject({ creditNote: 'CN/2627/000001' });
  });
});

/**
 * Payments routes through the real Express app — API_DOCUMENTATION.md §3.9 (verify, retry-payment),
 * §4.11 (admin), §5 (webhook). MOCKED DB (tests/helpers/mockDb.ts) driven by an in-memory world
 * (./world.ts) so verify / webhook / retry observe each other's writes; no SQL is executed.
 *
 * Mock gateway contract (src/integrations/payments/paymentProvider.ts): client signature =
 * HMAC(key secret, `${providerOrderId}|${providerPaymentId}`); webhook signature =
 * `sha256=` HMAC(webhook secret, `${timestamp}.${rawBody}`) in `x-mock-signature` + `x-mock-timestamp`.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { Prisma } from '../../../../src/generated/prisma/client.js';
import {
  MockPaymentProviderAdapter,
  signMockPaymentCallback,
  signMockPaymentWebhook,
} from '../../../../src/integrations/payments/paymentProvider.js';
import { createPaymentsModule } from '../../../../src/modules/payments/index.js';
import { buildModuleTestApp } from '../../../helpers/container.js';
import { expectAdminRoutesGuarded } from '../../../helpers/routeTable.js';
import { IDS } from '../checkout/fixtures.js';
import {
  ORDER_NUMBER,
  PLACED_AT,
  PROVIDER_ORDER_ID,
  buildWorld,
  type WorldOptions,
} from './world.js';

const NOW = new Date('2026-11-13T09:50:00.000Z');
let keySeq = 0;
const idem = () => `pay-idem-key-${String(++keySeq).padStart(8, '0')}`;

function setup(world: WorldOptions = {}, now: Date = NOW) {
  const gateway = new MockPaymentProviderAdapter();
  const t = buildModuleTestApp([createPaymentsModule], {
    now,
    overrides: { providers: { payment: gateway } },
  });
  const customer = t.customer({ userId: IDS.user });
  const w = buildWorld(t.m, world);
  return { t, gateway, w, auth: customer.headers };
}

const verifyBody = (paymentId = 'pay_ok_001', over: Record<string, unknown> = {}) => ({
  orderNumber: ORDER_NUMBER,
  providerOrderId: PROVIDER_ORDER_ID,
  providerPaymentId: paymentId,
  providerSignature: signMockPaymentCallback(PROVIDER_ORDER_ID, paymentId),
  ...over,
});

function webhook(
  t: ReturnType<typeof setup>['t'],
  payload: unknown,
  opts: { sign?: string; ts?: number } = {},
) {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const ts = opts.ts ?? Math.floor(t.now.value.getTime() / 1000);
  return request(t.app)
    .post('/api/v1/webhooks/payments/mock')
    .set('Content-Type', 'application/json')
    .set('x-mock-timestamp', String(ts))
    .set('x-mock-signature', opts.sign ?? signMockPaymentWebhook(raw, ts))
    .send(raw);
}

const capturedEvent = (eventId = 'evt_1', paymentId = 'pay_ok_001', amountMinor = 349600) => ({
  eventId,
  event: 'payment.captured',
  providerOrderId: PROVIDER_ORDER_ID,
  providerPaymentId: paymentId,
  amountMinor,
  currency: 'INR',
  method: 'upi',
});

describe('POST /payments/verify', () => {
  it('requires an Idempotency-Key', async () => {
    const { t, auth } = setup();
    const res = await request(t.app).post('/api/v1/payments/verify').set(auth).send(verifyBody());
    expect(res.status).toBe(400);
  });

  it('answers 404 for an order of another customer (ownership)', async () => {
    const { t, auth } = setup();
    t.m.order.findFirst.mockResolvedValue(null);
    const res = await request(t.app)
      .post('/api/v1/payments/verify')
      .set(auth)
      .set('Idempotency-Key', idem())
      .send(verifyBody());
    expect(res.status).toBe(404);
    expect(t.m.order.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orderNumber: ORDER_NUMBER, userId: IDS.user } }),
    );
  });

  it('rejects a forged signature with 422 SIGNATURE_INVALID and logs the attempt', async () => {
    const { t, auth, w } = setup();
    const res = await request(t.app)
      .post('/api/v1/payments/verify')
      .set(auth)
      .set('Idempotency-Key', idem())
      .send(verifyBody('pay_ok_001', { providerSignature: 'deadbeef' }));
    expect(res.status).toBe(422);
    expect(res.body.error.details[0].code).toBe('SIGNATURE_INVALID');
    expect(t.m.paymentTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'AUTHORIZE',
        errorCode: 'SIGNATURE_INVALID',
        signatureVerified: false,
      }),
    });
    expect(w.order.status).toBe('PENDING_PAYMENT');
  });

  it('captures after a server-side gateway fetch: stock committed, coupon redeemed, order CONFIRMED', async () => {
    const { t, auth, w } = setup({ couponId: IDS.coupon });
    t.m.couponUsage.findUnique.mockResolvedValue({
      id: 'cu-1',
      couponId: IDS.coupon,
      status: 'RESERVED',
    });
    const res = await request(t.app)
      .post('/api/v1/payments/verify')
      .set(auth)
      .set('Idempotency-Key', idem())
      .send(verifyBody());
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      orderNumber: ORDER_NUMBER,
      orderStatus: 'CONFIRMED',
      paymentStatus: 'CAPTURED',
      paidAmount: '3496.00',
      paidAt: NOW.toISOString(),
      nextAction: 'SHOW_CONFIRMATION',
    });
    expect(w.payments[0]).toMatchObject({ status: 'CAPTURED', providerPaymentId: 'pay_ok_001' });
    expect(w.reservations.every((r) => r.status === 'COMMITTED')).toBe(true);
    const ledger = (
      t.m.inventoryTransaction.createMany.mock.calls[0]?.[0] as { data: { type: string }[] }
    ).data;
    expect(ledger.map((e) => e.type)).toEqual(['ORDER_DEDUCTION', 'ORDER_DEDUCTION']);
    expect(t.m.couponUsage.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'REDEEMED' }) }),
    );
    expect(t.m.orderStatusHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        fromStatus: 'PENDING_PAYMENT',
        toStatus: 'CONFIRMED',
        actorType: 'CUSTOMER',
      }),
    });
    const events = t.m.notification.create.mock.calls.map(
      (c) => (c[0] as { data: { event: string } }).data.event,
    );
    expect(events).toEqual(expect.arrayContaining(['PAYMENT_SUCCEEDED', 'ORDER_CONFIRMED']));
  });

  it('is a no-op when the webhook captured first (race) — and the webhook is a no-op after verify', async () => {
    const { t, auth, w } = setup();
    const hook = await webhook(t, capturedEvent());
    expect(hook.status).toBe(200);
    expect(w.order.status).toBe('CONFIRMED');
    const commits = t.m.inventoryTransaction.createMany.mock.calls.length;

    const res = await request(t.app)
      .post('/api/v1/payments/verify')
      .set(auth)
      .set('Idempotency-Key', idem())
      .send(verifyBody());
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ orderStatus: 'CONFIRMED', paymentStatus: 'CAPTURED' });

    const again = await webhook(t, capturedEvent('evt_2'));
    expect(again.status).toBe(200);
    expect(t.m.inventoryTransaction.createMany.mock.calls.length).toBe(commits);
    expect(t.m.orderStatusHistory.create).toHaveBeenCalledTimes(1);
  });

  it('reports a gateway failure: PAYMENT_FAILED + RETRY_PAYMENT with retryAllowedUntil', async () => {
    const { t, auth, w } = setup();
    const res = await request(t.app)
      .post('/api/v1/payments/verify')
      .set(auth)
      .set('Idempotency-Key', idem())
      .send(verifyBody('mock_fail_001'));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      orderStatus: 'PAYMENT_FAILED',
      paymentStatus: 'FAILED',
      nextAction: 'RETRY_PAYMENT',
      retryAllowedUntil: '2026-11-13T10:46:03.120Z',
    });
    expect(w.payments[0]?.status).toBe('FAILED');
    // Reservations are kept until the TTL for a retry.
    expect(w.reservations.every((r) => r.status === 'ACTIVE')).toBe(true);
  });

  it('asks the client to poll while the gateway still reports PENDING', async () => {
    const { t, auth } = setup();
    const res = await request(t.app)
      .post('/api/v1/payments/verify')
      .set(auth)
      .set('Idempotency-Key', idem())
      .send(verifyBody('mock_pending_001'));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ paymentStatus: 'PENDING', nextAction: 'POLL_ORDER' });
  });

  it('never confirms when the gateway amount differs from the order (422 AMOUNT_MISMATCH)', async () => {
    const { t, auth, w, gateway } = setup();
    gateway.simulatePayment('pay_ok_001', { amountMinor: 100 });
    const res = await request(t.app)
      .post('/api/v1/payments/verify')
      .set(auth)
      .set('Idempotency-Key', idem())
      .send(verifyBody());
    expect(res.status).toBe(422);
    expect(res.body.error.details[0].code).toBe('AMOUNT_MISMATCH');
    expect(w.order.status).toBe('PENDING_PAYMENT');
    expect(w.payments[0]?.status).toBe('PENDING');
  });

  it('answers 409 for a cancelled order', async () => {
    const { t, auth } = setup({ status: 'CANCELLED' });
    const res = await request(t.app)
      .post('/api/v1/payments/verify')
      .set(auth)
      .set('Idempotency-Key', idem())
      .send(verifyBody());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });
});

describe('POST /webhooks/payments/:provider', () => {
  it('rejects a bad signature with 401 and an empty error body (nothing stored)', async () => {
    const { t, w } = setup();
    const res = await webhook(t, capturedEvent(), { sign: 'sha256=00' });
    expect(res.status).toBe(401);
    expect(res.body.error).toEqual({ code: 'UNAUTHENTICATED', message: 'Invalid signature.' });
    expect(t.m.paymentTransaction.create).not.toHaveBeenCalled();
    expect(w.order.status).toBe('PENDING_PAYMENT');
  });

  it('rejects missing headers and stale timestamps with 401', async () => {
    const { t } = setup();
    const missing = await request(t.app)
      .post('/api/v1/webhooks/payments/mock')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(capturedEvent()));
    expect(missing.status).toBe(401);
    const stale = await webhook(t, capturedEvent(), { ts: Math.floor(NOW.getTime() / 1000) - 600 });
    expect(stale.status).toBe(401);
  });

  it('answers 404 for an unknown provider and 400 for a signed but malformed payload', async () => {
    const { t } = setup();
    const unknown = await request(t.app)
      .post('/api/v1/webhooks/payments/razorpay')
      .set('Content-Type', 'application/json')
      .send('{}');
    expect(unknown.status).toBe(404);
    const malformed = await webhook(t, '{"not":"an event"');
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('BAD_REQUEST');
  });

  it('stores the event (redacted raw payload) and applies the capture', async () => {
    const { t, w } = setup();
    const res = await webhook(t, capturedEvent());
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ received: true });
    expect(t.m.paymentTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'WEBHOOK',
        provider: 'mock',
        providerEventId: 'evt_1',
        signatureVerified: true,
        requestPayload: expect.objectContaining({ eventId: 'evt_1', event: 'payment.captured' }),
      }),
    });
    expect(w.order.status).toBe('CONFIRMED');
    expect(t.m.orderStatusHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ toStatus: 'CONFIRMED', actorType: 'WEBHOOK' }),
    });
  });

  it('acknowledges a duplicate provider event id without reprocessing', async () => {
    const { t, w } = setup();
    t.m.paymentTransaction.findFirst.mockResolvedValue({ id: 'seen' });
    const res = await webhook(t, capturedEvent());
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ received: true, duplicate: true });
    expect(w.order.status).toBe('PENDING_PAYMENT');

    // A concurrent duplicate caught by the unique index (P2002) is also a duplicate.
    t.m.paymentTransaction.findFirst.mockResolvedValue(null);
    t.m.paymentTransaction.create.mockRejectedValueOnce(
      Object.assign(new Error('dup'), { code: 'P2002', clientVersion: '7' }),
    );
    const raced = await webhook(t, capturedEvent());
    expect(raced.body.data).toEqual({ received: true, duplicate: true });
  });

  it('marks the payment failed on payment.failed (order → PAYMENT_FAILED)', async () => {
    const { t, w } = setup();
    const res = await webhook(t, {
      eventId: 'evt_f',
      event: 'payment.failed',
      providerOrderId: PROVIDER_ORDER_ID,
      providerPaymentId: 'pay_x',
      errorCode: 'BAD_REQUEST_ERROR',
      errorDescription: 'Card declined',
    });
    expect(res.status).toBe(200);
    expect(w.order.status).toBe('PAYMENT_FAILED');
    expect(w.payments[0]).toMatchObject({ status: 'FAILED', failureCode: 'BAD_REQUEST_ERROR' });
  });

  it('acknowledges events for unknown payments', async () => {
    const { t } = setup();
    t.m.payment.findFirst.mockResolvedValue(null);
    const res = await webhook(t, capturedEvent());
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ received: true, ignored: true });
  });
});

describe('POST /me/orders/:orderNumber/retry-payment', () => {
  const retry = (t: ReturnType<typeof setup>['t'], auth: Record<string, string>) =>
    request(t.app)
      .post(`/api/v1/me/orders/${ORDER_NUMBER}/retry-payment`)
      .set(auth)
      .set('Idempotency-Key', idem())
      .send();

  it('re-reserves stock with a fresh TTL and opens a new gateway session (attempt 2)', async () => {
    const { t, auth, w } = setup({
      status: 'PAYMENT_FAILED',
      paymentStatus: 'FAILED',
      payments: [{ status: 'FAILED' }],
      reservations: [
        { variantId: IDS.v1, quantity: 2, status: 'EXPIRED' },
        { variantId: IDS.v2, quantity: 1, status: 'EXPIRED' },
      ],
      inventory: { [IDS.v1]: [20, 0], [IDS.v2]: [20, 0] },
    });
    const res = await retry(t, auth);
    expect(res.status).toBe(200);
    expect(res.body.data.order).toEqual({
      orderNumber: ORDER_NUMBER,
      status: 'PENDING_PAYMENT',
      reservationExpiresAt: '2026-11-13T10:05:00.000Z',
    });
    expect(res.body.data.payment).toMatchObject({ paymentId: 'pay-2', amount: '3496.00' });
    expect(w.payments[1]).toMatchObject({ attemptNo: 2, provider: 'mock' });
    expect(w.reservations.every((r) => r.status === 'ACTIVE')).toBe(true);
    expect(w.order.status).toBe('PENDING_PAYMENT');
    expect(t.m.orderStatusHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ fromStatus: 'PAYMENT_FAILED', toStatus: 'PENDING_PAYMENT' }),
    });
  });

  it('refuses after the 60-minute window (422 RETRY_WINDOW_EXPIRED)', async () => {
    const { t, auth } = setup(
      { status: 'PAYMENT_FAILED', payments: [{ status: 'FAILED' }] },
      new Date('2026-11-13T10:47:00.000Z'),
    );
    const res = await retry(t, auth);
    expect(res.status).toBe(422);
    expect(res.body.error.details[0].code).toBe('RETRY_WINDOW_EXPIRED');
  });

  it('refuses after 3 attempts (422 RETRY_LIMIT_REACHED)', async () => {
    const { t, auth } = setup({
      status: 'PAYMENT_FAILED',
      payments: [{ status: 'FAILED' }, { status: 'FAILED' }, { status: 'FAILED' }],
    });
    const res = await retry(t, auth);
    expect(res.status).toBe(422);
    expect(res.body.error.details[0].code).toBe('RETRY_LIMIT_REACHED');
  });

  it('answers 409 INSUFFICIENT_STOCK when the stock is gone (order stays PAYMENT_FAILED)', async () => {
    const { t, auth, w } = setup({
      status: 'PAYMENT_FAILED',
      payments: [{ status: 'FAILED' }],
      reservations: [
        { variantId: IDS.v1, quantity: 2, status: 'EXPIRED' },
        { variantId: IDS.v2, quantity: 1, status: 'EXPIRED' },
      ],
      inventory: { [IDS.v1]: [1, 0], [IDS.v2]: [5, 0] },
    });
    const res = await retry(t, auth);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(w.order.status).toBe('PAYMENT_FAILED');
  });

  it('answers 409 for an order that is no longer awaiting payment', async () => {
    const { t, auth } = setup({ status: 'CONFIRMED' });
    const res = await retry(t, auth);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });
});

describe('admin payments', () => {
  it('guards every admin route with payments.view', async () => {
    const { t } = setup();
    const module = createPaymentsModule(t.container);
    const routes = expectAdminRoutesGuarded(module);
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'GET /payments',
      'GET /payments/:paymentId',
    ]);
    const noPerm = t.staff({ permissions: [] });
    const res = await request(t.app).get('/api/v1/admin/payments').set(noPerm.headers);
    expect(res.status).toBe(403);
  });

  it('lists payments and shows transactions without provider payloads', async () => {
    const { t } = setup();
    const staff = t.staff({ permissions: ['payments.view'] });
    t.m.payment.findMany.mockResolvedValue([
      {
        id: IDS.payment,
        attemptNo: 1,
        paymentMethod: 'ONLINE',
        status: 'CAPTURED',
        amount: new Prisma.Decimal('3496'),
        amountRefunded: new Prisma.Decimal('0'),
        provider: 'mock',
        providerPaymentId: 'pay_ok_001',
        capturedAt: NOW,
        createdAt: PLACED_AT,
        order: { id: IDS.order, orderNumber: ORDER_NUMBER },
      },
    ]);
    t.m.payment.count.mockResolvedValue(1);
    const list = await request(t.app)
      .get('/api/v1/admin/payments?status=CAPTURED&from=2026-11-13&to=2026-11-13&q=ORD-261113')
      .set(staff.headers);
    expect(list.status).toBe(200);
    expect(list.body.data[0]).toMatchObject({
      orderNumber: ORDER_NUMBER,
      method: 'ONLINE',
      status: 'CAPTURED',
      amount: '3496.00',
      refundedAmount: '0.00',
      providerPaymentId: 'pay_ok_001',
    });
    expect(list.body.meta).toMatchObject({ page: 1, limit: 25, totalItems: 1 });

    t.m.payment.findUnique.mockResolvedValue({
      id: IDS.payment,
      attemptNo: 1,
      paymentMethod: 'ONLINE',
      status: 'CAPTURED',
      amount: new Prisma.Decimal('3496'),
      amountRefunded: new Prisma.Decimal('0'),
      currency: 'INR',
      provider: 'mock',
      providerOrderId: PROVIDER_ORDER_ID,
      providerPaymentId: 'pay_ok_001',
      instrumentType: 'upi',
      failureCode: null,
      failureReason: null,
      capturedAt: NOW,
      failedAt: null,
      expiresAt: null,
      createdAt: PLACED_AT,
      updatedAt: NOW,
      order: {
        id: IDS.order,
        orderNumber: ORDER_NUMBER,
        status: 'CONFIRMED',
        grandTotal: new Prisma.Decimal('3496'),
      },
      transactions: [
        {
          id: 'tx-1',
          type: 'CAPTURE',
          providerStatus: 'captured',
          amount: new Prisma.Decimal('3496'),
          providerReference: 'pay_ok_001',
          providerEventId: null,
          signatureVerified: true,
          errorCode: null,
          createdAt: NOW,
        },
      ],
    });
    const detail = await request(t.app)
      .get(`/api/v1/admin/payments/${IDS.payment}`)
      .set(staff.headers);
    expect(detail.status).toBe(200);
    expect(detail.body.data.transactions).toEqual([
      expect.objectContaining({
        type: 'CAPTURE',
        status: 'captured',
        amount: '3496.00',
        providerRef: 'pay_ok_001',
      }),
    ]);
    expect(JSON.stringify(detail.body.data)).not.toContain('Payload');

    t.m.payment.findUnique.mockResolvedValue(null);
    const missing = await request(t.app)
      .get(`/api/v1/admin/payments/${IDS.order}`)
      .set(staff.headers);
    expect(missing.status).toBe(404);
  });
});

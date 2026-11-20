/**
 * payment-reconciliation job. MOCKED DB via the in-memory payments world; mock gateway; no SQL runs,
 * no network.
 */
import { describe, expect, it, vi } from 'vitest';

import { Prisma } from '../../../src/generated/prisma/client.js';
import {
  MockPaymentProviderAdapter,
  type PaymentProviderAdapter,
} from '../../../src/integrations/payments/paymentProvider.js';
import { runPaymentReconciliation } from '../../../src/jobs/paymentReconciliation.js';
import { buildModuleTestApp } from '../../helpers/container.js';
import { IDS } from '../../integration/modules/checkout/fixtures.js';
import {
  PROVIDER_ORDER_ID,
  buildWorld,
  type WorldOptions,
} from '../../integration/modules/payments/world.js';

type World = ReturnType<typeof buildWorld>;
type TestApp = ReturnType<typeof buildModuleTestApp>;

/**
 * WP10-3: minimal in-memory refunds store over the MOCKED DB so the real OQ-59 auto-refund path
 * (refunds hook inside the capture transaction → `runRefundJob` after commit → gateway refund →
 * completion) runs end-to-end. Order lines sum to the grand total (3496.00).
 */
function wireRefunds(t: TestApp, w: World) {
  const refunds: Record<string, unknown>[] = [];
  const lines = [
    {
      id: 'oi-1',
      quantity: 2,
      lineTotal: new Prisma.Decimal('2796.00'),
      taxAmount: new Prisma.Decimal('0'),
    },
    {
      id: 'oi-2',
      quantity: 1,
      lineTotal: new Prisma.Decimal('700.00'),
      taxAmount: new Prisma.Decimal('0'),
    },
  ];
  const paid = () =>
    w.payments
      .filter((p) => ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(p.status))
      .map((p) => ({ id: p.id, amount: p.amount, capturedAt: p.capturedAt }));
  const orderImpl = t.m.order.findUnique.getMockImplementation();
  t.m.order.findUnique.mockImplementation(async (args: unknown) => {
    const base = (await orderImpl?.(args)) as Record<string, unknown>;
    return {
      ...base,
      items: lines,
      payments: paid(),
      refundedTotal: new Prisma.Decimal('0'),
      user: { firstName: 'Ananya', email: 'ananya@example.com', phone: null },
    };
  });
  t.m.refund.findMany.mockImplementation(() => Promise.resolve([]));
  t.m.refund.create.mockImplementation((args: { data: Record<string, unknown> }) => {
    refunds.push({ ...args.data });
    return Promise.resolve({ id: args.data.id });
  });
  const view = (r: Record<string, unknown>) => {
    const payment = w.payments.find((p) => p.id === r.paymentId);
    return {
      ...r,
      items: [],
      payment:
        payment === undefined
          ? null
          : { id: payment.id, providerPaymentId: payment.providerPaymentId },
    };
  };
  t.m.refund.findUnique.mockImplementation((args: { where: { id: string } }) => {
    const r = refunds.find((x) => x.id === args.where.id);
    return Promise.resolve(r === undefined ? null : view(r));
  });
  t.m.refund.update.mockImplementation(
    (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const r = refunds.find((x) => x.id === args.where.id);
      if (r !== undefined) Object.assign(r, args.data);
      return Promise.resolve({ id: args.where.id });
    },
  );
  t.m.payment.findUnique.mockImplementation((args: { where: { id: string } }) => {
    const p = w.payments.find((x) => x.id === args.where.id);
    return Promise.resolve(
      p === undefined ? null : { amount: p.amount, amountRefunded: new Prisma.Decimal('0') },
    );
  });
  return { refunds };
}

// 25 minutes after placement: inside the 60-minute retry window, past the 20-minute threshold.
const NOW = new Date('2026-11-13T10:11:03.120Z');

function setup(
  gateway: PaymentProviderAdapter = new MockPaymentProviderAdapter(),
  world: WorldOptions = {},
) {
  const t = buildModuleTestApp([], { now: NOW, overrides: { providers: { payment: gateway } } });
  const w = buildWorld(t.m, world);
  const scan = (rows = w.payments) =>
    t.m.payment.findMany.mockResolvedValueOnce(
      rows.map((p) => ({
        id: p.id,
        orderId: IDS.order,
        status: p.status,
        providerOrderId: p.providerOrderId,
        providerPaymentId: p.providerPaymentId,
      })),
    );
  return { t, w, scan };
}

describe('runPaymentReconciliation', () => {
  it('captures a payment whose callback and webhook were lost, and is idempotent on re-run', async () => {
    const gateway = new MockPaymentProviderAdapter();
    gateway.simulateOrderPayment(PROVIDER_ORDER_ID, 'pay_late_001');
    const { t, w, scan } = setup(gateway);
    const due = w.payments.map((p) => ({ ...p }));
    scan(due);

    const first = await runPaymentReconciliation(t.container);
    expect(first).toMatchObject({ scanned: 1, captured: 1, errors: 0 });
    expect(w.order.status).toBe('CONFIRMED');
    expect(w.payments[0]).toMatchObject({ status: 'CAPTURED', providerPaymentId: 'pay_late_001' });
    expect(t.m.payment.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: {
        provider: 'mock',
        providerOrderId: { not: null },
        OR: [
          { status: 'PENDING', createdAt: { lt: new Date('2026-11-13T09:51:03.120Z') } },
          // RD-10: CANCELLED payments updated in the last 24 h
          { status: 'CANCELLED', updatedAt: { gte: new Date('2026-11-12T10:11:03.120Z') } },
        ],
      },
      orderBy: { id: 'asc' },
      take: 100,
    });
    expect(first.nextCursor).toBeNull(); // short page

    // Same stale row again (e.g. a concurrent run read it before the commit): no second capture.
    scan(due);
    const second = await runPaymentReconciliation(t.container);
    expect(second).toMatchObject({ scanned: 1, captured: 0, alreadySettled: 1 });
    expect(w.payments.filter((p) => p.status === 'CAPTURED')).toHaveLength(1);
  });

  it('fails a payment the gateway reports as failed', async () => {
    const { t, w, scan } = setup(undefined, { payments: [{ providerPaymentId: 'mock_fail_01' }] });
    scan();
    const summary = await runPaymentReconciliation(t.container);
    expect(summary).toMatchObject({ scanned: 1, failed: 1 });
    expect(w.payments[0]?.status).toBe('FAILED');
    expect(w.order.status).toBe('PAYMENT_FAILED');
  });

  it('leaves payments alone when the gateway has nothing or is still processing', async () => {
    const { t, w, scan } = setup(undefined, {
      payments: [{}, { providerPaymentId: 'mock_pending_02' }],
    });
    scan();
    const summary = await runPaymentReconciliation(t.container);
    expect(summary).toMatchObject({ scanned: 2, stillPending: 2, captured: 0, failed: 0 });
    expect(w.payments.map((p) => p.status)).toEqual(['PENDING', 'PENDING']);
    expect(w.order.status).toBe('PENDING_PAYMENT');
  });

  it('does not confirm the order when the gateway amount differs', async () => {
    const gateway = new MockPaymentProviderAdapter();
    gateway.simulateOrderPayment(PROVIDER_ORDER_ID, 'pay_short_001');
    gateway.simulatePayment('pay_short_001', { amountMinor: 100 });
    const { t, w, scan } = setup(gateway);
    scan();
    const summary = await runPaymentReconciliation(t.container);
    expect(summary).toMatchObject({ amountMismatch: 1, captured: 0 });
    expect(w.order.status).toBe('PENDING_PAYMENT');
  });

  it('D2: records an amount mismatch once, not on every run', async () => {
    const gateway = new MockPaymentProviderAdapter();
    gateway.simulateOrderPayment(PROVIDER_ORDER_ID, 'pay_short_001');
    gateway.simulatePayment('pay_short_001', { amountMinor: 100 });
    const { t, w, scan } = setup(gateway);
    const rows: { paymentId: string; providerReference: string; errorCode: string | null }[] = [];
    t.m.paymentTransaction.create.mockImplementation(
      (args: { data: { paymentId: string; providerReference: string; errorCode?: string } }) => {
        rows.push({ ...args.data, errorCode: args.data.errorCode ?? null });
        return Promise.resolve({ id: `txn-${String(rows.length)}` });
      },
    );
    t.m.paymentTransaction.findFirst.mockImplementation(
      (args: { where: { paymentId: string; providerReference: string; errorCode: string } }) =>
        Promise.resolve(
          rows.find(
            (r) =>
              r.paymentId === args.where.paymentId &&
              r.providerReference === args.where.providerReference &&
              r.errorCode === args.where.errorCode,
          ) ?? null,
        ),
    );
    for (let run = 0; run < 3; run += 1) {
      scan();
      expect(await runPaymentReconciliation(t.container)).toMatchObject({ amountMismatch: 1 });
    }
    expect(rows.filter((r) => r.errorCode === 'AMOUNT_MISMATCH')).toHaveLength(1);
    expect(w.payments[0]?.status).toBe('PENDING');
    expect(w.order.status).toBe('PENDING_PAYMENT');
  });

  it('D3: pages through due payments with a cursor so stuck rows cannot starve newer ones', async () => {
    const { t, w, scan } = setup(undefined, { payments: [{}, {}] });
    scan(w.payments.slice(0, 1));
    const page1 = await runPaymentReconciliation(t.container, { limit: 1 });
    expect(page1.nextCursor).toBe(w.payments[0]?.id);
    expect(t.m.payment.findMany.mock.calls[0]?.[0].where.id).toBeUndefined();

    scan(w.payments.slice(1, 2));
    const page2 = await runPaymentReconciliation(t.container, {
      limit: 1,
      after: page1.nextCursor ?? undefined,
    });
    expect(t.m.payment.findMany.mock.calls[1]?.[0].where.id).toEqual({ gt: w.payments[0]?.id });
    expect(page2.nextCursor).toBe(w.payments[1]?.id);

    scan([]);
    const page3 = await runPaymentReconciliation(t.container, {
      limit: 1,
      after: page2.nextCursor ?? undefined,
    });
    expect(page3).toMatchObject({ scanned: 0, nextCursor: null }); // wraps to the start
  });

  it('RD-10: a capture found for a recently CANCELLED payment takes the late-capture path', async () => {
    const gateway = new MockPaymentProviderAdapter();
    gateway.simulateOrderPayment(PROVIDER_ORDER_ID, 'pay_after_expiry');
    // State after reservation-expiry: order PAYMENT_FAILED, payment CANCELLED, reservations EXPIRED.
    const { t, w, scan } = setup(gateway, {
      status: 'PAYMENT_FAILED',
      paymentStatus: 'FAILED',
      payments: [{ status: 'CANCELLED' }],
      reservations: [
        { variantId: IDS.v1, quantity: 2, status: 'EXPIRED' },
        { variantId: IDS.v2, quantity: 1, status: 'EXPIRED' },
      ],
    });
    scan();
    const summary = await runPaymentReconciliation(t.container);
    expect(summary).toMatchObject({ scanned: 1, lateCaptured: 1, captured: 0, errors: 0 });
    expect(w.payments[0]).toMatchObject({
      status: 'CAPTURED',
      providerPaymentId: 'pay_after_expiry',
    });
    expect(w.order.status).toBe('CONFIRMED'); // stock still free → confirmed (OQ-59)
  });

  it('RD-10: a recently CANCELLED payment without a gateway capture is left untouched', async () => {
    const gateway = new MockPaymentProviderAdapter();
    gateway.simulateOrderPayment(PROVIDER_ORDER_ID, 'mock_fail_after');
    const { t, w, scan } = setup(gateway, {
      status: 'PAYMENT_FAILED',
      paymentStatus: 'FAILED',
      payments: [{ status: 'CANCELLED' }],
    });
    scan();
    expect(await runPaymentReconciliation(t.container)).toMatchObject({
      cancelledNoCapture: 1,
      failed: 0,
      lateCaptured: 0,
    });
    expect(w.payments[0]?.status).toBe('CANCELLED');
    expect(w.order.status).toBe('PAYMENT_FAILED');
    expect(t.m.payment.update).not.toHaveBeenCalled();
  });

  it('isolates a gateway failure to one payment and retries it on the next run', async () => {
    const gateway = new MockPaymentProviderAdapter();
    gateway.simulateOrderPayment(PROVIDER_ORDER_ID, 'pay_ok_001');
    const spy = vi
      .spyOn(gateway, 'fetchOrderPayments')
      .mockRejectedValueOnce(new Error('gateway timeout'));
    const { t, w, scan } = setup(gateway, { payments: [{}, {}] });
    scan();
    const first = await runPaymentReconciliation(t.container);
    expect(first).toMatchObject({ scanned: 2, errors: 1, stillPending: 1 });
    expect(w.payments[0]?.status).toBe('PENDING');

    scan(w.payments.slice(0, 1));
    const second = await runPaymentReconciliation(t.container);
    expect(second).toMatchObject({ scanned: 1, captured: 1, errors: 0 });
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('marks payments unverifiable when the adapter cannot list order payments', async () => {
    const gateway = new MockPaymentProviderAdapter();
    Object.defineProperty(gateway, 'fetchOrderPayments', { value: undefined });
    const { t, w, scan } = setup(gateway);
    scan();
    expect(await runPaymentReconciliation(t.container)).toMatchObject({ unverifiable: 1 });
    expect(w.payments[0]?.status).toBe('PENDING');
  });

  it('does nothing with an adapter that cannot fetch payment status', async () => {
    const basic: PaymentProviderAdapter = {
      name: 'basic',
      initiate: () => Promise.reject(new Error('unused')),
      verify: () => Promise.reject(new Error('unused')),
      refund: () => Promise.reject(new Error('unused')),
    };
    const { t } = setup(basic);
    expect(await runPaymentReconciliation(t.container)).toMatchObject({ scanned: 0 });
    expect(t.m.payment.findMany).not.toHaveBeenCalled();
  });

  it('WP-O2: stops between payments when the stop signal is raised (the current one finishes)', async () => {
    const gateway = new MockPaymentProviderAdapter();
    const controller = new AbortController();
    const spy = vi.spyOn(gateway, 'fetchOrderPayments').mockImplementation(() => {
      controller.abort(); // shutdown requested while the first payment is being reconciled
      return Promise.resolve([]);
    });
    const { t, scan } = setup(gateway, { payments: [{}, {}] });
    scan();
    const summary = await runPaymentReconciliation(t.container, { signal: controller.signal });
    expect(summary).toMatchObject({ scanned: 1, stillPending: 1, errors: 0 });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  describe('WP10-3: late capture through reconciliation executes the post-commit refund', () => {
    it('stock-out: PAYMENT_FAILED order without stock → cancelled and refunded via the mock gateway', async () => {
      const gateway = new MockPaymentProviderAdapter();
      gateway.simulateOrderPayment(PROVIDER_ORDER_ID, 'pay_late_nostock');
      const refundSpy = vi.spyOn(gateway, 'refund');
      // State after reservation-expiry; meanwhile the stock was sold elsewhere (v1 needs 2, has 1).
      const { t, w, scan } = setup(gateway, {
        status: 'PAYMENT_FAILED',
        paymentStatus: 'FAILED',
        payments: [{ status: 'CANCELLED' }],
        reservations: [
          { variantId: IDS.v1, quantity: 2, status: 'EXPIRED' },
          { variantId: IDS.v2, quantity: 1, status: 'EXPIRED' },
        ],
        inventory: { [IDS.v1]: [1, 0], [IDS.v2]: [5, 0] },
      });
      const { refunds } = wireRefunds(t, w);
      scan();

      const summary = await runPaymentReconciliation(t.container);
      expect(summary).toMatchObject({ scanned: 1, lateCaptured: 1, captured: 0, errors: 0 });
      expect(w.order).toMatchObject({
        status: 'CANCELLED',
        cancellationReason: 'LATE_CAPTURE_STOCK_UNAVAILABLE',
      });
      // Refund created inside the capture transaction (SYSTEM, auto-approved, full amount) …
      expect(refunds).toHaveLength(1);
      expect(refunds[0]).toMatchObject({
        orderId: IDS.order,
        paymentId: IDS.payment,
        reasonCode: 'LATE_CAPTURE_STOCK_UNAVAILABLE',
        requestedByType: 'SYSTEM',
        method: 'ORIGINAL_PAYMENT_METHOD',
      });
      expect(String(refunds[0]?.amount)).toBe('3496');
      // … and executed AFTER commit through the (mock) gateway, idempotency key = refund id.
      expect(refundSpy).toHaveBeenCalledTimes(1);
      expect(refundSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          providerPaymentId: 'pay_late_nostock',
          amountMinor: 349600,
          currency: 'INR',
          refundId: refunds[0]?.id,
        }),
      );
      expect(refunds[0]?.status).toBe('COMPLETED');
      const commits = t.m.$transaction.mock.invocationCallOrder;
      expect(refundSpy.mock.invocationCallOrder[0]).toBeGreaterThan(commits[0] ?? Infinity);
      expect(w.payments[0]?.status).toBe('REFUNDED');
    });

    it('cancelled order: a capture found by reconciliation is fully refunded via the mock gateway', async () => {
      const gateway = new MockPaymentProviderAdapter();
      gateway.simulateOrderPayment(PROVIDER_ORDER_ID, 'pay_on_cancelled');
      const refundSpy = vi.spyOn(gateway, 'refund');
      const { t, w, scan } = setup(gateway, {
        status: 'CANCELLED',
        paymentStatus: 'FAILED',
        payments: [{ status: 'CANCELLED' }],
      });
      const { refunds } = wireRefunds(t, w);
      scan();

      const summary = await runPaymentReconciliation(t.container);
      expect(summary).toMatchObject({ scanned: 1, lateCaptured: 1, captured: 0, errors: 0 });
      expect(w.order.status).toBe('CANCELLED'); // never re-opened
      expect(refunds).toHaveLength(1);
      expect(refunds[0]).toMatchObject({
        reasonCode: 'CAPTURE_ON_CANCELLED_ORDER',
        requestedByType: 'SYSTEM',
      });
      expect(refundSpy).toHaveBeenCalledTimes(1);
      expect(refundSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          providerPaymentId: 'pay_on_cancelled',
          amountMinor: 349600,
          refundId: refunds[0]?.id,
        }),
      );
      expect(refunds[0]?.status).toBe('COMPLETED');
      expect(w.payments[0]?.status).toBe('REFUNDED');
    });
  });
});

/**
 * payment-reconciliation job. MOCKED DB via the in-memory payments world; mock gateway; no SQL runs,
 * no network.
 */
import { describe, expect, it, vi, type Mock } from 'vitest';

import { withTransaction } from '../../../src/core/db/transaction.js';
import { Prisma } from '../../../src/generated/prisma/client.js';
import {
  MockPaymentProviderAdapter,
  type PaymentProviderAdapter,
  type PaymentRefundResult,
} from '../../../src/integrations/payments/paymentProvider.js';
import { runPaymentReconciliation } from '../../../src/jobs/paymentReconciliation.js';
import { runRefundJob } from '../../../src/modules/payments/payments.refunds.js';
import { prepareGatewayRefund } from '../../../src/modules/refunds/index.js';
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

    // ── Added 2026-11-24: ordering, ledger, provider-failure and duplicate-prevention cases ──────

    const LATE_PAYMENT_ID = 'pay_late_wp103';
    /** State after reservation-expiry; meanwhile the stock was sold elsewhere (v1 needs 2, has 1). */
    const STOCK_OUT: WorldOptions = {
      status: 'PAYMENT_FAILED',
      paymentStatus: 'FAILED',
      payments: [{ status: 'CANCELLED' }],
      reservations: [
        { variantId: IDS.v1, quantity: 2, status: 'EXPIRED' },
        { variantId: IDS.v2, quantity: 1, status: 'EXPIRED' },
      ],
      inventory: { [IDS.v1]: [1, 0], [IDS.v2]: [5, 0] },
    };
    const CANCELLED_ORDER: WorldOptions = {
      status: 'CANCELLED',
      paymentStatus: 'FAILED',
      payments: [{ status: 'CANCELLED' }],
    };
    const PATHS: [string, WorldOptions, string][] = [
      ['stock-out (PAYMENT_FAILED order)', STOCK_OUT, 'LATE_CAPTURE_STOCK_UNAVAILABLE'],
      ['capture on a CANCELLED order', CANCELLED_ORDER, 'CAPTURE_ON_CANCELLED_ORDER'],
    ];
    const RECONCILIATION_ERROR =
      'payment reconciliation failed for one payment (will retry next run)';

    /** `data` of every call to a mocked Prisma write, in call order. */
    const written = (fn: Mock): Record<string, unknown>[] =>
      fn.mock.calls.map((call) => (call[0] as { data: Record<string, unknown> }).data);

    /** A gateway capture (`LATE_PAYMENT_ID`) waiting for the single CANCELLED payment of `world`. */
    function lateCapture(world: WorldOptions) {
      const gateway = new MockPaymentProviderAdapter();
      gateway.simulateOrderPayment(PROVIDER_ORDER_ID, LATE_PAYMENT_ID);
      const refundSpy = vi.spyOn(gateway, 'refund');
      const ctx = setup(gateway, world);
      const { refunds } = wireRefunds(ctx.t, ctx.w);
      const errorLog = vi.spyOn(ctx.t.container.logger, 'error');
      const errorMessages = () => errorLog.mock.calls.map((call) => (call as unknown[])[1]);
      const run = () => runPaymentReconciliation(ctx.t.container);
      return { ...ctx, gateway, refundSpy, refunds, errorLog, errorMessages, run };
    }

    it('WP10-3: a late capture for a deallocated PAYMENT_FAILED order is detected, takes no stock and cancels the order', async () => {
      const c = lateCapture(STOCK_OUT);
      const fetchSpy = vi.spyOn(c.gateway, 'fetchOrderPayments');
      c.scan();

      const summary = await c.run();
      // Detected through the gateway's order-payment listing (no callback / webhook ever arrived).
      expect(fetchSpy).toHaveBeenCalledExactlyOnceWith(PROVIDER_ORDER_ID);
      expect(summary).toMatchObject({
        scanned: 1,
        lateCaptured: 1,
        captured: 0,
        alreadySettled: 0,
        errors: 0,
      });
      // The released stock could not be re-taken: no inventory write, reservations stay EXPIRED.
      expect(c.t.m.inventory.update).not.toHaveBeenCalled();
      expect(c.t.m.inventoryTransaction.createMany).not.toHaveBeenCalled();
      expect(c.w.reservations.map((r) => r.status)).toEqual(['EXPIRED', 'EXPIRED']);
      // PAYMENT_FAILED → CANCELLED by the SYSTEM actor, with the late-capture reason.
      expect(c.w.order).toMatchObject({
        status: 'CANCELLED',
        cancellationReason: 'LATE_CAPTURE_STOCK_UNAVAILABLE',
        cancelledAt: NOW,
      });
      const history = written(c.t.m.orderStatusHistory.create);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        orderId: IDS.order,
        fromStatus: 'PAYMENT_FAILED',
        toStatus: 'CANCELLED',
        actorType: 'SYSTEM',
        createdAt: NOW,
      });
      expect(c.errorMessages()).toEqual([]);
    });

    it.each(PATHS)(
      'WP10-3: %s — the gateway refund runs after the capture transaction commits, outside any transaction',
      async (_path, world) => {
        const c = lateCapture(world);
        let open = 0;
        let committed = 0;
        const runTx = c.t.m.$transaction.getMockImplementation();
        c.t.m.$transaction.mockImplementation(async (...args: unknown[]) => {
          open += 1;
          try {
            const result: unknown = await runTx?.(...args);
            committed += 1; // reached only when the transaction callback resolved (= commit)
            return result;
          } finally {
            open -= 1;
          }
        });
        const atRefund: unknown[] = [];
        c.refundSpy.mockImplementation((input) => {
          atRefund.push({
            open,
            committed,
            payment: c.w.payments[0]?.status,
            order: c.w.order.status,
            refund: c.refunds[0]?.status,
          });
          return MockPaymentProviderAdapter.prototype.refund.call(c.gateway, input);
        });
        c.scan();

        expect(await c.run()).toMatchObject({ scanned: 1, lateCaptured: 1, errors: 0 });
        // When the gateway is called the capture transaction has committed (payment CAPTURED, order
        // CANCELLED, refund PROCESSING) and no transaction is open.
        expect(atRefund).toEqual([
          { open: 0, committed: 1, payment: 'CAPTURED', order: 'CANCELLED', refund: 'PROCESSING' },
        ]);
        // The result is recorded in a SECOND transaction that starts after the gateway call.
        expect(c.t.m.$transaction).toHaveBeenCalledTimes(2);
        expect(committed).toBe(2);
        const [captureTx, resultTx] = c.t.m.$transaction.mock.invocationCallOrder;
        const refundCall = c.refundSpy.mock.invocationCallOrder[0] ?? NaN;
        expect(captureTx).toBeLessThan(refundCall);
        expect(resultTx).toBeGreaterThan(refundCall);
      },
    );

    it.each(PATHS)(
      'WP10-3: %s — ledger: refund APPROVED → PROCESSING → COMPLETED, REFUND transaction row, payment and order totals',
      async (_path, world, reasonCode) => {
        const c = lateCapture(world);
        c.scan();
        expect(await c.run()).toMatchObject({ scanned: 1, lateCaptured: 1, errors: 0 });
        const refundId = String(c.refunds[0]?.id);
        const providerRefundId = `mock_rfnd_${refundId}`;

        // refunds: one row, created APPROVED by SYSTEM for the full amount, with its two lines.
        const created = written(c.t.m.refund.create);
        expect(created).toHaveLength(1);
        expect(created[0]).toMatchObject({
          id: refundId,
          orderId: IDS.order,
          paymentId: IDS.payment,
          status: 'APPROVED',
          method: 'ORIGINAL_PAYMENT_METHOD',
          reasonCode,
          requestedByType: 'SYSTEM',
          requestedById: null,
          approvedAt: NOW,
          createdAt: NOW,
        });
        expect(created[0]?.refundNumber).toMatch(/^RFD-\d{6}-\d{5}$/);
        expect(String(created[0]?.amount)).toBe('3496');
        expect(String(created[0]?.itemsAmount)).toBe('3496');
        expect(String(created[0]?.shippingAmount)).toBe('0');
        expect(c.t.m.refundItem.createMany).toHaveBeenCalledTimes(1);
        const lines = (
          c.t.m.refundItem.createMany.mock.calls[0]?.[0] as { data: Record<string, unknown>[] }
        ).data;
        expect(lines.map((l) => [l.refundId, l.orderItemId, l.quantity, String(l.amount)])).toEqual(
          [
            [refundId, 'oi-1', 2, '2796'],
            [refundId, 'oi-2', 1, '700'],
          ],
        );

        // refunds: APPROVED → PROCESSING (capture transaction) → COMPLETED (after the gateway call).
        expect(written(c.t.m.refund.update)).toEqual([
          { status: 'PROCESSING', processingAt: NOW, failureReason: null },
          { status: 'COMPLETED', completedAt: NOW, failureReason: null, providerRefundId },
        ]);
        expect(c.refunds[0]).toMatchObject({ status: 'COMPLETED', providerRefundId });

        // payment_transactions: the CAPTURE row, then one REFUND row linked to the refund.
        const txns = written(c.t.m.paymentTransaction.create);
        expect(txns.map((d) => d.type)).toEqual(['CAPTURE', 'REFUND']);
        expect(txns[0]).toMatchObject({
          paymentId: IDS.payment,
          provider: 'mock',
          providerReference: LATE_PAYMENT_ID,
          providerStatus: 'captured',
          signatureVerified: true,
          errorCode: null,
          createdAt: NOW,
        });
        expect(String(txns[0]?.amount)).toBe('3496');
        expect(txns[1]).toMatchObject({
          paymentId: IDS.payment,
          refundId,
          provider: 'mock',
          providerReference: providerRefundId,
          providerStatus: 'COMPLETED',
          errorMessage: null,
          createdAt: NOW,
        });
        expect(String(txns[1]?.amount)).toBe('3496');
        // The automatic refund worked, so no staff-review `REFUND_REQUIRED` marker is written.
        expect(txns.some((d) => d.errorCode === 'REFUND_REQUIRED')).toBe(false);

        // payments: CANCELLED → CAPTURED → REFUNDED with the full amount refunded.
        const paymentWrites = written(c.t.m.payment.update);
        expect(paymentWrites.map((d) => d.status)).toEqual(['CAPTURED', 'REFUNDED']);
        expect(paymentWrites[0]).toMatchObject({
          providerPaymentId: LATE_PAYMENT_ID,
          capturedAt: NOW,
        });
        expect(String(paymentWrites[1]?.amountRefunded)).toBe('3496');
        expect(c.w.payments[0]).toMatchObject({
          status: 'REFUNDED',
          providerPaymentId: LATE_PAYMENT_ID,
          capturedAt: NOW,
        });

        // orders: payment status CAPTURED (capture transaction) → REFUNDED, refunded total rolled up.
        const orderWrites = [...written(c.t.m.order.updateMany), ...written(c.t.m.order.update)];
        expect(orderWrites.map((d) => d.paymentStatus)).toEqual(['CAPTURED', 'REFUNDED']);
        expect(String(orderWrites.at(-1)?.refundedTotal)).toBe('3496');
        expect(c.w.order).toMatchObject({ status: 'CANCELLED', paymentStatus: 'REFUNDED' });
        expect(c.errorMessages()).toEqual([]);
      },
    );

    const GATEWAY_FAILURES: [string, () => Promise<PaymentRefundResult>, string, boolean][] = [
      [
        'throws',
        () => Promise.reject(new Error('mock gateway outage')),
        'Gateway call failed.',
        true,
      ],
      [
        'returns FAILED',
        () =>
          Promise.resolve({
            provider: 'mock',
            status: 'FAILED',
            reason: 'Refund declined by the mock gateway.',
          }),
        'Refund declined by the mock gateway.',
        false,
      ],
    ];

    it.each(GATEWAY_FAILURES)(
      'WP10-3: provider failure (gateway refund %s) — refund ends FAILED, the run does not crash and continues with the next payment',
      async (_kind, fail, failureReason, callFailureLogged) => {
        // Two CANCELLED attempts on the order: the first was captured late, the second never paid.
        const c = lateCapture({
          ...STOCK_OUT,
          payments: [{ status: 'CANCELLED' }, { status: 'CANCELLED' }],
        });
        const fetchSpy = vi.spyOn(c.gateway, 'fetchOrderPayments');
        c.refundSpy.mockImplementationOnce(fail);
        c.scan();

        const summary = await c.run();
        // A refund failure is not a reconciliation error; the second payment is still processed.
        expect(summary).toMatchObject({
          scanned: 2,
          lateCaptured: 1,
          cancelledNoCapture: 1,
          errors: 0,
        });
        expect(fetchSpy.mock.calls.map((call) => call[0])).toEqual([
          PROVIDER_ORDER_ID,
          `${PROVIDER_ORDER_ID}-2`,
        ]);
        expect(fetchSpy.mock.invocationCallOrder[1]).toBeGreaterThan(
          c.refundSpy.mock.invocationCallOrder[0] ?? Infinity,
        );

        // The capture and the cancellation stay committed; nothing is rolled up as refunded.
        expect(c.w.order).toMatchObject({
          status: 'CANCELLED',
          paymentStatus: 'CAPTURED',
          cancellationReason: 'LATE_CAPTURE_STOCK_UNAVAILABLE',
        });
        expect(c.w.order).not.toHaveProperty('refundedTotal');
        expect(c.w.payments.map((p) => p.status)).toEqual(['CAPTURED', 'CANCELLED']);
        expect(written(c.t.m.payment.update).map((d) => d.status)).toEqual(['CAPTURED']);

        // refunds: APPROVED → PROCESSING → FAILED (the state the admin retry starts from).
        expect(c.refundSpy).toHaveBeenCalledTimes(1);
        expect(c.refunds).toHaveLength(1);
        const refundId = String(c.refunds[0]?.id);
        expect(written(c.t.m.refund.update)).toEqual([
          { status: 'PROCESSING', processingAt: NOW, failureReason: null },
          { status: 'FAILED', failedAt: NOW, failureReason },
        ]);
        expect(c.refunds[0]).toMatchObject({ status: 'FAILED', failureReason });

        // payment_transactions: the failed attempt is recorded as a REFUND row.
        const txns = written(c.t.m.paymentTransaction.create);
        expect(txns.map((d) => d.type)).toEqual(['CAPTURE', 'REFUND']);
        expect(txns[1]).toMatchObject({
          paymentId: IDS.payment,
          refundId,
          provider: 'mock',
          providerReference: null,
          providerStatus: 'FAILED',
          errorMessage: failureReason,
        });

        // Logging: a thrown gateway call is logged once with the refund id; never a job-level error.
        const failureLogs = c.errorLog.mock.calls.filter(
          (call) => (call as unknown[])[1] === 'gateway refund call failed',
        );
        expect(failureLogs).toHaveLength(callFailureLogged ? 1 : 0);
        if (callFailureLogged) {
          expect(failureLogs[0]?.[0]).toMatchObject({ refundId, err: expect.any(Error) });
        }
        expect(c.errorMessages()).not.toContain(RECONCILIATION_ERROR);
        expect(c.errorMessages()).not.toContain('post-commit refund execution failed');
      },
    );

    it('WP10-3: a FAILED late-capture refund is retryable with the same gateway idempotency key', async () => {
      const c = lateCapture(STOCK_OUT);
      c.refundSpy.mockRejectedValueOnce(new Error('mock gateway outage'));
      c.scan();
      expect(await c.run()).toMatchObject({ scanned: 1, lateCaptured: 1, errors: 0 });
      const refundId = String(c.refunds[0]?.id);
      expect(c.refunds[0]?.status).toBe('FAILED');

      // The retry primitives used by `POST /admin/refunds/:refundId/retry`: FAILED → PROCESSING …
      const job = await withTransaction(c.t.container.db, ({ tx }) =>
        prepareGatewayRefund(tx, refundId, NOW),
      );
      expect(job).toMatchObject({
        refundId,
        paymentId: IDS.payment,
        providerPaymentId: LATE_PAYMENT_ID,
      });
      expect(String(job?.amount)).toBe('3496');
      // … then the gateway call again, now succeeding.
      await runRefundJob(c.t.container, job);

      expect(c.refundSpy).toHaveBeenCalledTimes(2);
      expect(c.refundSpy.mock.calls.map((call) => call[0].refundId)).toEqual([refundId, refundId]);
      expect(c.refunds).toHaveLength(1);
      expect(c.refunds[0]).toMatchObject({ status: 'COMPLETED', failureReason: null });
      expect(c.w.payments[0]?.status).toBe('REFUNDED');
      expect(c.w.order).toMatchObject({ status: 'CANCELLED', paymentStatus: 'REFUNDED' });
    });

    it('WP10-3: a failure while recording the refund result is logged for staff review and does not crash the run', async () => {
      const c = lateCapture(STOCK_OUT);
      // The gateway refund succeeds, but the post-commit ledger write (REFUND row) fails.
      c.t.m.paymentTransaction.create.mockImplementation((args: { data: { type: string } }) =>
        args.data.type === 'REFUND'
          ? Promise.reject(new Error('ledger write failed'))
          : Promise.resolve({ id: 'txn-1' }),
      );
      c.scan();

      const summary = await c.run();
      expect(summary).toMatchObject({ scanned: 1, lateCaptured: 1, errors: 0 });
      expect(c.refundSpy).toHaveBeenCalledTimes(1);
      const refundId = String(c.refunds[0]?.id);
      // The capture transaction is unaffected; the refund stays PROCESSING until staff close it.
      expect(c.w.order.status).toBe('CANCELLED');
      expect(c.w.payments[0]?.status).toBe('CAPTURED');
      expect(c.refunds[0]?.status).toBe('PROCESSING');
      const logged = c.errorLog.mock.calls.filter(
        (call) => (call as unknown[])[1] === 'post-commit refund execution failed',
      );
      expect(logged).toHaveLength(1);
      expect(logged[0]?.[0]).toMatchObject({
        refundId,
        staffReview: true,
        err: expect.any(Error),
      });
      expect(c.errorMessages()).not.toContain(RECONCILIATION_ERROR);
    });

    it.each(PATHS)(
      'WP10-3: %s — duplicate prevention: re-running reconciliation creates no second refund or gateway refund call',
      async (_path, world) => {
        const c = lateCapture(world);
        const stale = c.w.payments.map((p) => ({ ...p })); // the row as read before the first run
        c.scan(stale);
        expect(await c.run()).toMatchObject({ scanned: 1, lateCaptured: 1 });
        expect(c.w.payments[0]?.status).toBe('REFUNDED');
        const ledgerRows = c.t.m.paymentTransaction.create.mock.calls.length;

        // Mechanism 1 — selection: the job only reads PENDING and CANCELLED payments, so the now
        // REFUNDED payment is not selected again.
        const where = (
          c.t.m.payment.findMany.mock.calls[0]?.[0] as { where: { OR: { status: string }[] } }
        ).where;
        const selectable = where.OR.map((branch) => branch.status);
        expect(selectable).toEqual(['PENDING', 'CANCELLED']);
        c.scan(c.w.payments.filter((p) => selectable.includes(p.status)));
        expect(await c.run()).toMatchObject({ scanned: 0, lateCaptured: 0, alreadySettled: 0 });

        // Mechanism 2 — idempotent capture: a stale CANCELLED row (e.g. a concurrent run that read
        // it before the commit) is re-checked under the order lock and found already captured.
        c.scan(stale);
        expect(await c.run()).toMatchObject({
          scanned: 1,
          alreadySettled: 1,
          lateCaptured: 0,
          captured: 0,
          errors: 0,
        });

        expect(c.refunds).toHaveLength(1);
        expect(c.t.m.refund.create).toHaveBeenCalledTimes(1);
        expect(c.refundSpy).toHaveBeenCalledTimes(1);
        expect(c.t.m.paymentTransaction.create).toHaveBeenCalledTimes(ledgerRows);
        expect(c.refunds[0]?.status).toBe('COMPLETED');
        expect(c.w.payments[0]?.status).toBe('REFUNDED');
        expect(c.w.order).toMatchObject({ status: 'CANCELLED', paymentStatus: 'REFUNDED' });
      },
    );

    it('WP10-3: duplicate prevention after a FAILED refund — a re-run neither creates a second refund nor calls the gateway again', async () => {
      const c = lateCapture(STOCK_OUT);
      const stale = c.w.payments.map((p) => ({ ...p }));
      c.refundSpy.mockRejectedValueOnce(new Error('mock gateway outage'));
      c.scan(stale);
      expect(await c.run()).toMatchObject({ scanned: 1, lateCaptured: 1, errors: 0 });
      expect(c.w.payments[0]?.status).toBe('CAPTURED'); // captured, refund FAILED

      c.scan(stale);
      expect(await c.run()).toMatchObject({
        scanned: 1,
        alreadySettled: 1,
        lateCaptured: 0,
        errors: 0,
      });
      // Reconciliation does not retry the refund by itself (that is the admin retry) and never
      // opens a second refund for the same capture.
      expect(c.refunds).toHaveLength(1);
      expect(c.t.m.refund.create).toHaveBeenCalledTimes(1);
      expect(c.refundSpy).toHaveBeenCalledTimes(1);
      expect(c.refunds[0]?.status).toBe('FAILED');
      expect(c.w.payments[0]?.status).toBe('CAPTURED');
    });
  });
});

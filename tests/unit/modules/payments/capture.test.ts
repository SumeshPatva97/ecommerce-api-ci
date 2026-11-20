/**
 * Payment capture domain service + mock gateway contract (unit). MOCKED DB via the in-memory world
 * of tests/integration/modules/payments/world.ts — no SQL runs.
 * Covers OQ-59 late capture (stock free → confirm; stock gone → cancel + auto-refund hook) and the
 * signature contract of the mock provider.
 */
import { describe, expect, it, vi } from 'vitest';

import type { TxClient } from '../../../../src/core/db/transaction.js';
import {
  MockPaymentProviderAdapter,
  PaymentWebhookPayloadError,
  PaymentWebhookSignatureError,
  isVerifiablePaymentProvider,
  signMockPaymentCallback,
  signMockPaymentWebhook,
} from '../../../../src/integrations/payments/paymentProvider.js';
import { Prisma } from '../../../../src/generated/prisma/client.js';
import {
  captureDepsFor,
  capturePayment,
  failPayment,
  transitionOrder,
  type CaptureInput,
} from '../../../../src/modules/payments/index.js';
import { buildModuleTestApp } from '../../../helpers/container.js';
import { IDS } from '../../../integration/modules/checkout/fixtures.js';
import {
  PROVIDER_ORDER_ID,
  buildWorld,
  type WorldOptions,
} from '../../../integration/modules/payments/world.js';

const NOW = new Date('2026-11-13T10:20:00.000Z');

function setup(world: WorldOptions, hook = vi.fn().mockResolvedValue(null)) {
  const t = buildModuleTestApp([], { now: NOW });
  const w = buildWorld(t.m, world);
  const deps = captureDepsFor(t.container, { lateCaptureRefund: hook });
  const tx = t.container.db as unknown as TxClient;
  return { t, w, deps, tx, hook };
}

const input: CaptureInput = {
  orderId: IDS.order,
  providerOrderId: PROVIDER_ORDER_ID,
  providerPaymentId: 'pay_late',
  amountMinor: 349600,
  currency: 'INR',
  method: 'upi',
  provider: 'mock',
  source: 'WEBHOOK',
  actor: { type: 'WEBHOOK' },
};

describe('mock payment provider contract', () => {
  const gw = new MockPaymentProviderAdapter();

  it('verifies the client callback signature in constant time', () => {
    const sig = signMockPaymentCallback('ord', 'pay');
    expect(
      gw.verifyClientSignature({
        providerOrderId: 'ord',
        providerPaymentId: 'pay',
        signature: sig,
      }),
    ).toBe(true);
    expect(
      gw.verifyClientSignature({
        providerOrderId: 'ord',
        providerPaymentId: 'pay2',
        signature: sig,
      }),
    ).toBe(false);
    expect(
      gw.verifyClientSignature({
        providerOrderId: 'ord',
        providerPaymentId: 'pay',
        signature: 'x',
      }),
    ).toBe(false);
    expect(isVerifiablePaymentProvider(gw)).toBe(true);
  });

  it('records the server amount in the provider order id and reports it on fetch', async () => {
    const created = await gw.initiate({
      orderId: 'o1',
      amountMinor: 349600,
      currency: 'INR',
      idempotencyKey: 'p1',
    });
    expect(created.providerOrderId).toMatch(/_349600$/);
    const state = await gw.fetchPayment({
      providerOrderId: created.providerOrderId,
      providerPaymentId: 'pay_1',
    });
    expect(state).toMatchObject({ status: 'CAPTURED', amountMinor: 349600, currency: 'INR' });
    expect(
      (
        await gw.fetchPayment({
          providerOrderId: created.providerOrderId,
          providerPaymentId: 'mock_fail_1',
        })
      ).status,
    ).toBe('FAILED');
  });

  it('verifies webhook signatures over the raw body before parsing', () => {
    const now = new Date('2026-11-13T10:00:00.000Z');
    const ts = Math.floor(now.getTime() / 1000);
    const raw = Buffer.from('{"eventId":"e1","event":"payment.captured","amountMinor":5}');
    expect(() => {
      gw.verifyWebhook(
        raw,
        { 'x-mock-timestamp': String(ts), 'x-mock-signature': signMockPaymentWebhook(raw, ts) },
        now,
      );
    }).not.toThrow();
    expect(() => {
      gw.verifyWebhook(
        Buffer.from(`${raw.toString()} `),
        { 'x-mock-timestamp': String(ts), 'x-mock-signature': signMockPaymentWebhook(raw, ts) },
        now,
      );
    }).toThrow(PaymentWebhookSignatureError);
    expect(gw.parseWebhook(raw)).toMatchObject({
      eventId: 'e1',
      type: 'PAYMENT_CAPTURED',
      amountMinor: 5,
    });
    expect(() => gw.parseWebhook(Buffer.from('[]'))).toThrow(PaymentWebhookPayloadError);
    expect(() =>
      gw.parseWebhook(Buffer.from('{"eventId":"e","event":"x","amountMinor":-1}')),
    ).toThrow(PaymentWebhookPayloadError);
  });

  it('keeps the refund() contract used by the refunds module', async () => {
    const r = await gw.refund({
      providerPaymentId: 'p',
      amountMinor: 100,
      currency: 'INR',
      refundId: 'rf1',
    });
    expect(r).toEqual({ provider: 'mock', providerRefundId: 'mock_rfnd_rf1', status: 'COMPLETED' });
  });
});

describe('capturePayment', () => {
  it('confirms a late capture when the released stock is still free (OQ-59)', async () => {
    const { w, deps, tx, t } = setup({
      status: 'PAYMENT_FAILED',
      paymentStatus: 'CANCELLED',
      payments: [{ status: 'CANCELLED' }],
      reservations: [
        { variantId: IDS.v1, quantity: 2, status: 'EXPIRED' },
        { variantId: IDS.v2, quantity: 1, status: 'EXPIRED' },
      ],
      inventory: { [IDS.v1]: [5, 0], [IDS.v2]: [5, 0] },
    });
    const result = await capturePayment(deps, tx, input);
    expect(result.outcome).toBe('CAPTURED');
    expect(w.order.status).toBe('CONFIRMED');
    const ledger = t.m.inventoryTransaction.createMany.mock.calls.flatMap(
      (c) => (c[0] as { data: { type: string; onHandDelta: number }[] }).data,
    );
    expect(ledger).toEqual([
      expect.objectContaining({ type: 'ORDER_DEDUCTION', onHandDelta: -2 }),
      expect.objectContaining({ type: 'ORDER_DEDUCTION', onHandDelta: -1 }),
    ]);
    const edges = t.m.orderStatusHistory.create.mock.calls.map(
      (c) =>
        `${(c[0] as { data: { fromStatus: string } }).data.fromStatus}→${(c[0] as { data: { toStatus: string } }).data.toStatus}`,
    );
    expect(edges).toEqual(['PAYMENT_FAILED→PENDING_PAYMENT', 'PENDING_PAYMENT→CONFIRMED']);
  });

  it('cancels and requests a full refund when the stock is gone (OQ-59)', async () => {
    const job = {
      refundId: 'rf',
      paymentId: IDS.payment,
      providerPaymentId: 'pay_late',
      amount: new Prisma.Decimal(3496),
      reason: 'x',
    };
    const { w, deps, tx, hook } = setup(
      {
        status: 'PAYMENT_FAILED',
        payments: [{ status: 'CANCELLED' }],
        reservations: [{ variantId: IDS.v1, quantity: 2, status: 'EXPIRED' }],
        inventory: { [IDS.v1]: [1, 0], [IDS.v2]: [5, 0] },
      },
      vi.fn().mockResolvedValue(job),
    );
    const result = await capturePayment(deps, tx, input);
    expect(result).toMatchObject({
      outcome: 'LATE_CAPTURE_CANCELLED',
      refundRequired: true,
      refundJob: job,
    });
    expect(w.order).toMatchObject({
      status: 'CANCELLED',
      paymentStatus: 'CAPTURED',
      cancellationReason: 'LATE_CAPTURE_STOCK_UNAVAILABLE',
    });
    expect(w.payments[0]?.status).toBe('CAPTURED');
    expect(hook).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ orderId: IDS.order, reasonCode: 'LATE_CAPTURE_STOCK_UNAVAILABLE' }),
    );
  });

  it('records a staff-review refund requirement when no refund hook is wired', async () => {
    const t = buildModuleTestApp([], { now: NOW });
    const w = buildWorld(t.m, { status: 'CANCELLED', payments: [{ status: 'PENDING' }] });
    const deps = captureDepsFor(t.container, { lateCaptureRefund: null });
    const result = await capturePayment(deps, t.container.db, input);
    expect(result.outcome).toBe('CAPTURED_ON_CANCELLED_ORDER');
    expect(w.order.status).toBe('CANCELLED');
    expect(t.m.paymentTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'REFUND', errorCode: 'REFUND_REQUIRED' }),
    });
  });

  it('is idempotent: a second capture of the same payment is a no-op', async () => {
    const { deps, tx, t } = setup({});
    expect((await capturePayment(deps, tx, input)).outcome).toBe('CAPTURED');
    const writes = t.m.orderStatusHistory.create.mock.calls.length;
    expect((await capturePayment(deps, tx, input)).outcome).toBe('ALREADY_CAPTURED');
    expect(t.m.orderStatusHistory.create.mock.calls.length).toBe(writes);
    expect(
      t.m.$queryRaw.mock.calls.some(
        (c) => Array.isArray(c[0]) && c[0].join('').includes('FROM orders'),
      ),
    ).toBe(true);
  });

  it('ignores a failure after capture and a repeated failure', async () => {
    const { deps, tx, w } = setup({ payments: [{ status: 'CAPTURED' }] });
    const failure = {
      orderId: IDS.order,
      providerOrderId: PROVIDER_ORDER_ID,
      errorCode: 'X',
      errorDescription: null,
      provider: 'mock',
      source: 'WEBHOOK' as const,
      actor: { type: 'WEBHOOK' as const },
    };
    expect((await failPayment(deps, tx, failure)).outcome).toBe('ALREADY_CAPTURED');
    const [first] = w.payments;
    if (first !== undefined) first.status = 'FAILED';
    expect((await failPayment(deps, tx, failure)).outcome).toBe('ALREADY_FAILED');
  });
});

describe('transitionOrder', () => {
  it('refuses edges the canonical state machine does not allow', async () => {
    const { tx } = setup({});
    await expect(
      transitionOrder(tx, {
        orderId: IDS.order,
        from: 'PENDING_PAYMENT',
        to: 'CANCELLED',
        actor: { type: 'SYSTEM' },
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
  });
});

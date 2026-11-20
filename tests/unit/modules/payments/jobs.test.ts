/**
 * Reservation-expiry and unpaid-order-cancel jobs (exported functions, not scheduled).
 * MOCKED DB via the in-memory world (tests/integration/modules/payments/world.ts); no SQL runs.
 */
import { describe, expect, it } from 'vitest';

import { runReservationExpiry } from '../../../../src/jobs/reservationExpiry.js';
import { runUnpaidOrderCancel } from '../../../../src/jobs/unpaidOrderCancel.js';
import { buildModuleTestApp } from '../../../helpers/container.js';
import { IDS } from '../../../integration/modules/checkout/fixtures.js';
import { buildWorld, type WorldOptions } from '../../../integration/modules/payments/world.js';

function setup(now: Date, world: WorldOptions = {}) {
  const t = buildModuleTestApp([], { now });
  const w = buildWorld(t.m, world);
  t.m.stockReservation.findMany.mockImplementationOnce(() =>
    Promise.resolve([{ orderId: IDS.order }]),
  );
  return { t, w };
}

describe('runReservationExpiry', () => {
  it('releases expired reservations, coupon usage and moves the order to PAYMENT_FAILED', async () => {
    const { t, w } = setup(new Date('2026-11-13T10:02:00.000Z'), { couponId: IDS.coupon });
    t.m.couponUsage.findUnique.mockResolvedValue({
      id: 'cu',
      couponId: IDS.coupon,
      status: 'RESERVED',
    });
    t.m.coupon.findUnique.mockResolvedValue({ status: 'ACTIVE', deletedAt: null, expiresAt: null });
    const summary = await runReservationExpiry(t.container);
    expect(summary).toEqual({ scanned: 1, expired: 1, skippedCaptured: 0, failed: 0 });
    expect(w.reservations.map((r) => r.status)).toEqual(['EXPIRED', 'EXPIRED']);
    expect(w.order.status).toBe('PAYMENT_FAILED');
    expect(w.payments[0]?.status).toBe('CANCELLED');
    expect(t.m.couponUsage.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'RELEASED' }) }),
    );
    const ledger = (
      t.m.inventoryTransaction.createMany.mock.calls[0]?.[0] as { data: { type: string }[] }
    ).data;
    expect(ledger.map((e) => e.type)).toEqual(['RESERVATION_RELEASE', 'RESERVATION_RELEASE']);
    expect(t.m.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ event: 'PAYMENT_FAILED' }),
    });
  });

  it('skips orders whose payment was captured in the meantime', async () => {
    const { t, w } = setup(new Date('2026-11-13T10:02:00.000Z'), {
      payments: [{ status: 'CAPTURED' }],
    });
    const summary = await runReservationExpiry(t.container);
    expect(summary.skippedCaptured).toBe(1);
    expect(w.reservations.every((r) => r.status === 'ACTIVE')).toBe(true);
    expect(w.order.status).toBe('PENDING_PAYMENT');
  });
});

describe('runUnpaidOrderCancel', () => {
  it('cancels a PAYMENT_FAILED order once the 60-minute window closed (OQ-58)', async () => {
    const { t, w } = setup(new Date('2026-11-13T10:47:00.000Z'), {
      status: 'PAYMENT_FAILED',
      paymentStatus: 'FAILED',
      payments: [{ status: 'FAILED' }],
      reservations: [{ variantId: IDS.v1, quantity: 2, status: 'EXPIRED' }],
    });
    t.m.order.findMany.mockResolvedValueOnce([{ id: IDS.order }]).mockResolvedValueOnce([]);
    const summary = await runUnpaidOrderCancel(t.container);
    expect(summary).toEqual({ scanned: 1, cancelled: 1, skipped: 0, failed: 0 });
    expect(w.order).toMatchObject({
      status: 'CANCELLED',
      paymentStatus: 'FAILED',
      cancellationReason: 'PAYMENT_NOT_COMPLETED',
    });
    expect(t.m.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ event: 'ORDER_CANCELLED' }),
    });
  });

  it('cancels early after 3 failed attempts, and leaves a capture-in-flight alone', async () => {
    const { t, w } = setup(new Date('2026-11-13T10:00:00.000Z'), {
      status: 'PAYMENT_FAILED',
      payments: [{ status: 'FAILED' }, { status: 'FAILED' }, { status: 'FAILED' }],
      reservations: [{ variantId: IDS.v1, quantity: 2, status: 'EXPIRED' }],
    });
    t.m.order.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: IDS.order, payments: w.payments.map((p) => ({ status: p.status })) },
      ]);
    expect((await runUnpaidOrderCancel(t.container)).cancelled).toBe(1);
    expect(w.order.status).toBe('CANCELLED');

    const other = setup(new Date('2026-11-13T10:50:00.000Z'), {
      reservations: [
        { variantId: IDS.v1, quantity: 2, expiresAt: new Date('2026-11-13T10:55:00.000Z') },
      ],
    });
    other.t.m.order.findMany.mockResolvedValueOnce([{ id: IDS.order }]).mockResolvedValueOnce([]);
    expect((await runUnpaidOrderCancel(other.t.container)).skipped).toBe(1);
    expect(other.w.order.status).toBe('PENDING_PAYMENT');
  });

  it('moves a PENDING_PAYMENT order through PAYMENT_FAILED to CANCELLED (state machine)', async () => {
    const { t, w } = setup(new Date('2026-11-13T11:00:00.000Z'), {
      reservations: [{ variantId: IDS.v1, quantity: 2, status: 'EXPIRED' }],
    });
    t.m.order.findMany.mockResolvedValueOnce([{ id: IDS.order }]).mockResolvedValueOnce([]);
    await runUnpaidOrderCancel(t.container);
    const edges = t.m.orderStatusHistory.create.mock.calls.map(
      (c) => (c[0] as { data: { toStatus: string } }).data.toStatus,
    );
    expect(edges).toEqual(['PAYMENT_FAILED', 'CANCELLED']);
    expect(w.order.paymentStatus).toBe('CANCELLED');
  });
});

/**
 * Coupon rules (pure) and the checkout usage lifecycle (`reserveUsage` / `redeem` / `release`,
 * DATABASE_DESIGN §17). MOCKED DB (tests/helpers/mockDb.ts) — no SQL is executed; the tests assert
 * the lock, the counter updates and the state transitions.
 */
import { describe, expect, it } from 'vitest';

import type { AppContainer } from '../../../../src/container.js';
import { Decimal } from '../../../../src/lib/money.js';
import { createAuditService } from '../../../../src/modules/audit/audit.service.js';
import {
  couponRuleIssues,
  couponValidity,
  releaseDecision,
  remainingUses,
} from '../../../../src/modules/coupons/coupons.rules.js';
import { createCouponsService } from '../../../../src/modules/coupons/index.js';
import { createMockDb } from '../../../helpers/mockDb.js';

const NOW = new Date('2026-11-19T06:30:00.000Z');
const COUPON = 'c0000000-0000-4000-8000-000000000001';
const USER = 'c0000000-0000-4000-8000-000000000002';
const ORDER = 'c0000000-0000-4000-8000-000000000003';

function build() {
  const { db, m } = createMockDb();
  const silent = { error: () => undefined } as unknown as Parameters<typeof createAuditService>[0];
  const container = {
    db,
    clock: () => NOW,
    audit: createAuditService(silent, () => NOW),
  } as unknown as AppContainer;
  return { m, service: createCouponsService(container), tx: db };
}

function snapshotRow(over: Record<string, unknown> = {}) {
  return {
    id: COUPON,
    code: 'WELCOME10',
    description: null,
    status: 'ACTIVE',
    deletedAt: null,
    discountType: 'PERCENTAGE',
    discountValue: new Decimal(10),
    maxDiscountAmount: new Decimal(300),
    minOrderValue: null,
    startsAt: new Date('2026-11-01T00:00:00.000Z'),
    expiresAt: new Date('2026-12-01T00:00:00.000Z'),
    usageLimitEnabled: true,
    usageLimit: 100,
    usedCount: 5,
    perCustomerLimit: 1,
    isFirstOrderOnly: false,
    isCombinableWithPromotions: true,
    applicabilities: [],
    ...over,
  };
}

describe('coupon rules (pure)', () => {
  const base = {
    discountType: 'PERCENTAGE' as const,
    discountValue: '10',
    usageLimitEnabled: false,
  };

  it('accepts a valid coupon and reports each rule', () => {
    expect(couponRuleIssues(base)).toEqual([]);
    expect(couponRuleIssues({ ...base, discountValue: '0' })[0]?.field).toBe('discountValue');
    expect(couponRuleIssues({ ...base, discountType: 'FIXED_AMOUNT', discountValue: '0' })).toEqual(
      [{ field: 'discountValue', message: 'Must be greater than 0.' }],
    );
    expect(couponRuleIssues({ ...base, maxDiscountAmount: '0' })).toEqual([
      { field: 'maxDiscountAmount', message: 'Must be greater than 0.' },
    ]);
    expect(couponRuleIssues({ ...base, maxDiscountAmount: null })).toEqual([]);
    expect(
      couponRuleIssues({
        ...base,
        startsAt: NOW,
        expiresAt: null,
        usageLimitEnabled: true,
        usageLimit: 3,
      }),
    ).toEqual([]);
  });

  it('derives validity and remaining uses', () => {
    const c = { status: 'ACTIVE', startsAt: null, expiresAt: null };
    expect(couponValidity(c, NOW)).toBe('ACTIVE');
    expect(couponValidity({ ...c, status: 'INACTIVE' }, NOW)).toBe('INACTIVE');
    expect(couponValidity({ ...c, expiresAt: NOW }, NOW)).toBe('EXPIRED');
    expect(couponValidity({ ...c, startsAt: new Date('2026-12-01T00:00:00Z') }, NOW)).toBe(
      'SCHEDULED',
    );
    expect(remainingUses({ usageLimitEnabled: false, usageLimit: null, usedCount: 3 })).toBeNull();
    expect(remainingUses({ usageLimitEnabled: true, usageLimit: 2, usedCount: 3 })).toBe(0);
  });

  it('decides releases per OQ-15', () => {
    expect(releaseDecision('RELEASED', 'PAYMENT_FAILED', true)).toBe('NOOP');
    expect(releaseDecision('RESERVED', 'RESERVATION_EXPIRED', false)).toBe('RELEASE');
    expect(releaseDecision('REDEEMED', 'ORDER_CANCELLED_BEFORE_SHIPMENT', true)).toBe('RELEASE');
    expect(releaseDecision('REDEEMED', 'ORDER_CANCELLED_BEFORE_SHIPMENT', false)).toBe('KEEP');
    expect(releaseDecision('REDEEMED', 'PAYMENT_FAILED', true)).toBe('KEEP');
  });
});

describe('CouponsService.reserveUsage', () => {
  it('locks the coupon, increments used_count and records a RESERVED usage', async () => {
    const { m, service, tx } = build();
    m.coupon.findUnique.mockResolvedValue(snapshotRow());
    m.couponUsage.findUnique.mockResolvedValue(null);
    m.couponUsage.count.mockResolvedValue(0);
    m.order.count.mockResolvedValue(0);
    const result = await service.reserveUsage(tx, COUPON, USER, ORDER, new Decimal('300.00'));
    expect(result).toMatchObject({ status: 'RESERVED', changed: true, couponId: COUPON });
    expect(m.$queryRaw).toHaveBeenCalledTimes(1);
    expect(m.coupon.update.mock.calls[0]?.[0].data).toEqual({ usedCount: { increment: 1 } });
    expect(m.couponUsage.create.mock.calls[0]?.[0].data).toMatchObject({
      couponId: COUPON,
      userId: USER,
      orderId: ORDER,
      status: 'RESERVED',
      reservedAt: NOW,
    });
    // previous-order count excludes the order being placed
    expect(m.order.count.mock.calls[0]?.[0].where.id).toEqual({ not: ORDER });
  });

  it('fails with COUPON_INVALID when the global or per-customer limit is reached', async () => {
    const { m, service, tx } = build();
    m.coupon.findUnique.mockResolvedValue(snapshotRow({ usedCount: 100 }));
    m.couponUsage.findUnique.mockResolvedValue(null);
    m.couponUsage.count.mockResolvedValue(0);
    m.order.count.mockResolvedValue(0);
    await expect(
      service.reserveUsage(tx, COUPON, USER, ORDER, new Decimal(1)),
    ).rejects.toMatchObject({
      code: 'COUPON_INVALID',
      details: [{ code: 'COUPON_USAGE_LIMIT_REACHED' }],
    });
    m.coupon.findUnique.mockResolvedValue(snapshotRow());
    m.couponUsage.count.mockResolvedValue(1);
    await expect(
      service.reserveUsage(tx, COUPON, USER, ORDER, new Decimal(1)),
    ).rejects.toMatchObject({ details: [{ code: 'COUPON_CUSTOMER_LIMIT_REACHED' }] });
    m.coupon.findUnique.mockResolvedValue(null);
    await expect(
      service.reserveUsage(tx, COUPON, USER, ORDER, new Decimal(1)),
    ).rejects.toMatchObject({ details: [{ code: 'COUPON_NOT_FOUND' }] });
    expect(m.coupon.update).not.toHaveBeenCalled();
  });

  it('is idempotent per order and re-reserves a released usage (retry-payment)', async () => {
    const { m, service, tx } = build();
    m.coupon.findUnique.mockResolvedValue(snapshotRow());
    m.couponUsage.findUnique.mockResolvedValue({ id: 'u1', couponId: COUPON, status: 'RESERVED' });
    expect(await service.reserveUsage(tx, COUPON, USER, ORDER, new Decimal(1))).toMatchObject({
      status: 'RESERVED',
      changed: false,
    });
    m.couponUsage.findUnique.mockResolvedValue({ id: 'u1', couponId: COUPON, status: 'RELEASED' });
    m.couponUsage.count.mockResolvedValue(0);
    m.order.count.mockResolvedValue(0);
    expect(await service.reserveUsage(tx, COUPON, USER, ORDER, new Decimal(1))).toMatchObject({
      status: 'RESERVED',
      changed: true,
      usageId: 'u1',
    });
    expect(m.couponUsage.update.mock.calls[0]?.[0].data).toMatchObject({
      status: 'RESERVED',
      releasedAt: null,
    });
    m.couponUsage.findUnique.mockResolvedValue({ id: 'u2', couponId: 'other', status: 'RESERVED' });
    await expect(
      service.reserveUsage(tx, COUPON, USER, ORDER, new Decimal(1)),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('CouponsService.redeem / release', () => {
  it('redeems a reservation once', async () => {
    const { m, service, tx } = build();
    m.couponUsage.findUnique.mockResolvedValue(null);
    expect((await service.redeem(tx, ORDER)).status).toBe('NO_COUPON');
    m.couponUsage.findUnique.mockResolvedValue({ id: 'u1', couponId: COUPON, status: 'RESERVED' });
    expect(await service.redeem(tx, ORDER)).toMatchObject({ status: 'REDEEMED', changed: true });
    expect(m.couponUsage.update.mock.calls[0]?.[0].data).toEqual({
      status: 'REDEEMED',
      redeemedAt: NOW,
    });
    m.couponUsage.findUnique.mockResolvedValue({ id: 'u1', couponId: COUPON, status: 'REDEEMED' });
    expect(await service.redeem(tx, ORDER)).toMatchObject({ status: 'REDEEMED', changed: false });
    m.couponUsage.findUnique.mockResolvedValue({ id: 'u1', couponId: COUPON, status: 'RELEASED' });
    await expect(service.redeem(tx, ORDER)).rejects.toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
    });
  });

  it('releases a reservation and decrements used_count (guarded > 0)', async () => {
    const { m, service, tx } = build();
    m.couponUsage.findUnique.mockResolvedValue({ id: 'u1', couponId: COUPON, status: 'RESERVED' });
    m.coupon.findUnique.mockResolvedValue({ status: 'ACTIVE', deletedAt: null, expiresAt: null });
    expect(await service.release(tx, ORDER, 'PAYMENT_FAILED')).toMatchObject({
      status: 'RELEASED',
      changed: true,
    });
    expect(m.$queryRaw).toHaveBeenCalledTimes(1);
    expect(m.coupon.updateMany.mock.calls[0]?.[0]).toEqual({
      where: { id: COUPON, usedCount: { gt: 0 } },
      data: { usedCount: { decrement: 1 } },
    });
  });

  it('keeps a redeemed usage unless cancelled before shipment while still valid', async () => {
    const { m, service, tx } = build();
    m.couponUsage.findUnique.mockResolvedValue({ id: 'u1', couponId: COUPON, status: 'REDEEMED' });
    m.coupon.findUnique.mockResolvedValue({
      status: 'ACTIVE',
      deletedAt: null,
      expiresAt: new Date('2026-11-01T00:00:00.000Z'),
    });
    expect(await service.release(tx, ORDER, 'ORDER_CANCELLED_BEFORE_SHIPMENT')).toMatchObject({
      status: 'REDEEMED',
      changed: false,
    });
    m.coupon.findUnique.mockResolvedValue(null);
    expect((await service.release(tx, ORDER, 'ORDER_CANCELLED_BEFORE_SHIPMENT')).changed).toBe(
      false,
    );
    m.coupon.findUnique.mockResolvedValue({
      status: 'ACTIVE',
      deletedAt: null,
      expiresAt: new Date('2026-12-01T00:00:00.000Z'),
    });
    expect(await service.release(tx, ORDER, 'ORDER_CANCELLED_BEFORE_SHIPMENT')).toMatchObject({
      status: 'RELEASED',
      changed: true,
    });
    m.couponUsage.findUnique.mockResolvedValue({ id: 'u1', couponId: COUPON, status: 'RELEASED' });
    expect((await service.release(tx, ORDER, 'PAYMENT_FAILED')).changed).toBe(false);
    m.couponUsage.findUnique.mockResolvedValue(null);
    expect((await service.release(tx, ORDER, 'PAYMENT_FAILED')).status).toBe('NO_COUPON');
  });
});

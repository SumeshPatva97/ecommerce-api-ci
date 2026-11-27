/**
 * promotion-activation, best-seller-refresh and rating-aggregate jobs. MOCKED DB; no SQL runs.
 */
import { describe, expect, it, vi } from 'vitest';

import { Prisma } from '../../../src/generated/prisma/client.js';
import {
  BEST_SELLER_WINDOW_SETTING_KEY,
  runBestSellerRefresh,
  runRatingAggregate,
} from '../../../src/jobs/catalogAggregates.js';
import { runPromotionActivation } from '../../../src/jobs/promotionActivation.js';
import { buildModuleTestApp } from '../../helpers/container.js';
import { sqlOf } from '../../integration/modules/checkout/fixtures.js';

const NOW = new Date('2026-11-20T06:30:00.000Z');
const before = (min: number) => new Date(NOW.getTime() - min * 60_000);
const after = (min: number) => new Date(NOW.getTime() + min * 60_000);

describe('runPromotionActivation', () => {
  function setup(rows: object[]) {
    const t = buildModuleTestApp([], { now: NOW });
    t.m.promotion.findMany.mockResolvedValue(rows);
    t.m.promotion.updateMany.mockResolvedValue({ count: 1 });
    t.m.auditLog.create.mockResolvedValue({});
    return t;
  }

  it('activates started and expires ended promotions with a SYSTEM audit row each', async () => {
    const t = setup([
      { id: 'p1', name: 'Diwali', status: 'SCHEDULED', startsAt: before(5), endsAt: after(60) },
      { id: 'p2', name: 'Monsoon', status: 'ACTIVE', startsAt: before(500), endsAt: before(1) },
      { id: 'p3', name: 'Flash', status: 'SCHEDULED', startsAt: before(9), endsAt: before(2) },
    ]);
    const summary = await runPromotionActivation(t.container);
    expect(summary).toEqual({ scanned: 3, activated: 1, expired: 2, skipped: 0, errors: 0 });
    // D1: the compare-and-set includes the dates that were read.
    expect(t.m.promotion.updateMany.mock.calls.map((c): unknown => c[0])).toEqual([
      {
        where: {
          id: 'p1',
          status: 'SCHEDULED',
          startsAt: before(5),
          endsAt: after(60),
          deletedAt: null,
        },
        data: { status: 'ACTIVE' },
      },
      {
        where: {
          id: 'p2',
          status: 'ACTIVE',
          startsAt: before(500),
          endsAt: before(1),
          deletedAt: null,
        },
        data: { status: 'EXPIRED' },
      },
      {
        where: {
          id: 'p3',
          status: 'SCHEDULED',
          startsAt: before(9),
          endsAt: before(2),
          deletedAt: null,
        },
        data: { status: 'EXPIRED' },
      },
    ]);
    const audits = t.m.auditLog.create.mock.calls.map(
      (c) => (c[0] as { data: { action: string; actorType: string; module: string } }).data,
    );
    expect(audits).toHaveLength(3);
    expect(audits.every((a) => a.action === 'STATUS_CHANGE' && a.actorType === 'SYSTEM')).toBe(
      true,
    );
    const where = t.m.promotion.findMany.mock.calls[0]?.[0].where;
    expect(where.deletedAt).toBeNull();
  });

  it('is race-safe: a lost compare-and-set writes no audit row; nothing due → no writes', async () => {
    const t = setup([
      { id: 'p1', name: 'Diwali', status: 'SCHEDULED', startsAt: before(5), endsAt: null },
    ]);
    t.m.promotion.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await runPromotionActivation(t.container)).toMatchObject({ skipped: 1, activated: 0 });
    expect(t.m.auditLog.create).not.toHaveBeenCalled();

    t.m.promotion.findMany.mockResolvedValueOnce([]);
    expect(await runPromotionActivation(t.container)).toMatchObject({ scanned: 0 });
    expect(t.m.promotion.updateMany).toHaveBeenCalledTimes(1);
  });

  it('D1: an admin date edit between read and write makes the update a no-op (no stale EXPIRED)', async () => {
    // Row read with an ended endsAt; meanwhile an admin moved endsAt into the future, so the
    // database row no longer matches the read dates and the compare-and-set hits nothing.
    const stored = { status: 'ACTIVE', startsAt: before(500), endsAt: after(600) };
    const t = setup([
      { id: 'p2', name: 'Monsoon', status: 'ACTIVE', startsAt: before(500), endsAt: before(1) },
    ]);
    t.m.promotion.updateMany.mockImplementation(
      (args: { where: { status: string; startsAt: Date; endsAt: Date } }) =>
        Promise.resolve({
          count:
            args.where.status === stored.status &&
            args.where.startsAt.getTime() === stored.startsAt.getTime() &&
            args.where.endsAt.getTime() === stored.endsAt.getTime()
              ? 1
              : 0,
        }),
    );
    expect(await runPromotionActivation(t.container)).toMatchObject({ expired: 0, skipped: 1 });
    expect(t.m.auditLog.create).not.toHaveBeenCalled();
  });

  it('isolates a failing update to one promotion', async () => {
    const t = setup([
      { id: 'p1', name: 'A', status: 'SCHEDULED', startsAt: before(1), endsAt: null },
      { id: 'p2', name: 'B', status: 'SCHEDULED', startsAt: before(1), endsAt: null },
    ]);
    t.m.promotion.updateMany.mockRejectedValueOnce(new Error('lock wait timeout'));
    expect(await runPromotionActivation(t.container)).toMatchObject({ errors: 1, activated: 1 });
  });
});

describe('runBestSellerRefresh', () => {
  it('sets 90-day net units, resets products that stopped selling, and skips unchanged ones', async () => {
    const t = buildModuleTestApp([], { now: NOW });
    t.m.orderItem.groupBy.mockResolvedValue([
      { productId: 'a', _sum: { quantity: 10, quantityCancelled: 2 } },
      { productId: 'b', _sum: { quantity: 3, quantityCancelled: 0 } },
    ]);
    t.m.product.findMany.mockResolvedValue([
      { id: 'a', totalSold: 5 },
      { id: 'b', totalSold: 3 },
      { id: 'c', totalSold: 7 },
    ]);
    const summary = await runBestSellerRefresh(t.container);
    expect(summary).toEqual({ products: 3, updated: 2, errors: 0 });
    expect(t.m.product.update.mock.calls.map((c): unknown[] => [c[0].where.id, c[0].data])).toEqual(
      [
        ['a', { totalSold: 8 }],
        ['c', { totalSold: 0 }],
      ],
    );
    expect(t.m.orderItem.groupBy.mock.calls[0]?.[0].where).toEqual({
      order: {
        confirmedAt: { gte: new Date('2026-08-22T06:30:00.000Z'), lt: NOW },
        status: { notIn: ['PENDING_PAYMENT', 'PAYMENT_FAILED', 'CANCELLED'] },
      },
    });
  });

  it('WP10-2: one failing product update is logged and counted; the others still update', async () => {
    const t = buildModuleTestApp([], { now: NOW });
    const logError = vi.spyOn(t.container.logger, 'error');
    t.m.orderItem.groupBy.mockResolvedValue([
      { productId: 'a', _sum: { quantity: 4, quantityCancelled: 0 } },
      { productId: 'b', _sum: { quantity: 5, quantityCancelled: 0 } },
      { productId: 'c', _sum: { quantity: 6, quantityCancelled: 0 } },
    ]);
    t.m.product.findMany.mockResolvedValue([
      { id: 'a', totalSold: 0 },
      { id: 'b', totalSold: 0 },
      { id: 'c', totalSold: 0 },
    ]);
    t.m.product.update.mockImplementation((args: { where: { id: string } }) =>
      args.where.id === 'b'
        ? Promise.reject(new Error('lock wait timeout'))
        : Promise.resolve({ id: args.where.id }),
    );
    const summary = await runBestSellerRefresh(t.container);
    expect(summary).toEqual({ products: 3, updated: 2, errors: 1 });
    expect(t.m.product.update.mock.calls.map((c): unknown => c[0].where.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(logError).toHaveBeenCalledTimes(1);
    const [fields] = logError.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(fields.productId).toBe('b');
    expect((fields.err as Error).message).toBe('lock wait timeout');
  });

  it('WP10-2: product A fails, product B succeeds → { products: 2, updated: 1, errors: 1 }', async () => {
    const t = buildModuleTestApp([], { now: NOW });
    t.m.orderItem.groupBy.mockResolvedValue([
      { productId: 'a', _sum: { quantity: 4, quantityCancelled: 0 } },
      { productId: 'b', _sum: { quantity: 5, quantityCancelled: 0 } },
    ]);
    t.m.product.findMany.mockResolvedValue([
      { id: 'a', totalSold: 0 },
      { id: 'b', totalSold: 0 },
    ]);
    t.m.product.update.mockImplementation((args: { where: { id: string } }) =>
      args.where.id === 'a'
        ? Promise.reject(new Error('write failed'))
        : Promise.resolve({ id: args.where.id }),
    );
    // The FIRST product fails: the run still reaches and writes the second one.
    await expect(runBestSellerRefresh(t.container)).resolves.toEqual({
      products: 2,
      updated: 1,
      errors: 1,
    });
    expect(t.m.product.update.mock.calls.map((c): unknown => c[0].where.id)).toEqual(['a', 'b']);
  });

  it('WP10-2: a failure outside the per-product loop still fails the whole run (job-level handling intact)', async () => {
    const t = buildModuleTestApp([], { now: NOW });
    const logError = vi.spyOn(t.container.logger, 'error');
    t.m.orderItem.groupBy.mockRejectedValue(new Error('aggregate query failed'));
    await expect(runBestSellerRefresh(t.container)).rejects.toThrow('aggregate query failed');

    t.m.orderItem.groupBy.mockResolvedValue([]);
    t.m.product.findMany.mockRejectedValue(new Error('product read failed'));
    await expect(runBestSellerRefresh(t.container)).rejects.toThrow('product read failed');

    // Not swallowed and not counted as a per-product error; nothing was written.
    expect(t.m.product.update).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
  });

  it('WP10-5: honours catalog.best_seller_window_days when it is valid', async () => {
    const t = buildModuleTestApp([], { now: NOW });
    t.m.setting.findUnique.mockResolvedValue({ value: 30 });
    t.m.orderItem.groupBy.mockResolvedValue([]);
    t.m.product.findMany.mockResolvedValue([]);
    await runBestSellerRefresh(t.container);
    expect(t.m.setting.findUnique.mock.calls[0]?.[0].where).toEqual({
      settingKey: BEST_SELLER_WINDOW_SETTING_KEY,
    });
    expect(BEST_SELLER_WINDOW_SETTING_KEY).toBe('catalog.best_seller_window_days');
    expect(t.m.orderItem.groupBy.mock.calls[0]?.[0].where.order.confirmedAt).toEqual({
      gte: new Date('2026-10-21T06:30:00.000Z'),
      lt: NOW,
    });
  });

  it.each([
    ['missing row', undefined],
    ['zero', { value: 0 }],
    ['above 730', { value: 731 }],
    ['non-integer', { value: 12.5 }],
    ['string', { value: '30' }],
    ['null value', { value: null }],
    ['negative', { value: -30 }],
    ['NaN', { value: Number.NaN }],
    ['boolean', { value: true }],
    ['object', { value: { days: 30 } }],
    ['array', { value: [30] }],
  ])('WP10-5: falls back to 90 days when the setting is %s', async (_label, row) => {
    const t = buildModuleTestApp([], { now: NOW });
    t.m.setting.findUnique.mockResolvedValue(row);
    t.m.orderItem.groupBy.mockResolvedValue([]);
    t.m.product.findMany.mockResolvedValue([]);
    await runBestSellerRefresh(t.container);
    expect(t.m.orderItem.groupBy.mock.calls[0]?.[0].where.order.confirmedAt.gte).toEqual(
      new Date('2026-08-22T06:30:00.000Z'),
    );
  });

  it('WP10-5: accepts the bounds 1 and 730', async () => {
    for (const [days, gte] of [
      [1, '2026-11-19T06:30:00.000Z'],
      [730, '2024-11-20T06:30:00.000Z'],
    ] as const) {
      const t = buildModuleTestApp([], { now: NOW });
      t.m.setting.findUnique.mockResolvedValue({ value: days });
      t.m.orderItem.groupBy.mockResolvedValue([]);
      t.m.product.findMany.mockResolvedValue([]);
      await runBestSellerRefresh(t.container);
      expect(t.m.orderItem.groupBy.mock.calls[0]?.[0].where.order.confirmedAt.gte).toEqual(
        new Date(gte),
      );
    }
  });
});

describe('runRatingAggregate', () => {
  it('recomputes from APPROVED reviews (2 dp half-up) and is a no-op when already correct', async () => {
    const t = buildModuleTestApp([], { now: NOW });
    t.m.review.groupBy.mockResolvedValue([
      { productId: 'a', _avg: { rating: 4.666666 }, _count: { _all: 3 } },
      { productId: 'b', _avg: { rating: 5 }, _count: { _all: 1 } },
    ]);
    t.m.product.findMany.mockResolvedValue([
      { id: 'a', avgRating: new Prisma.Decimal('4.50'), reviewCount: 2 },
      { id: 'b', avgRating: new Prisma.Decimal('5.00'), reviewCount: 1 },
      { id: 'c', avgRating: new Prisma.Decimal('3.00'), reviewCount: 1 },
    ]);
    // Inside the locked transaction the aggregate is re-read: product "a" got a 4th review approved
    // after the snapshot, so the fresh value (4.75 / 4) is written, never the stale 4.67 / 3.
    const fresh: Record<string, { _avg: { rating: number | null }; _count: { _all: number } }> = {
      a: { _avg: { rating: 4.75 }, _count: { _all: 4 } },
      c: { _avg: { rating: null }, _count: { _all: 0 } },
    };
    t.m.review.aggregate.mockImplementation((args: { where: { productId: string } }) =>
      Promise.resolve(fresh[args.where.productId]),
    );
    expect(await runRatingAggregate(t.container)).toEqual({ products: 3, updated: 2, errors: 0 });
    const writes = t.m.product.update.mock.calls.map((c): unknown[] => [
      c[0].where.id,
      String(c[0].data.avgRating),
      c[0].data.reviewCount,
    ]);
    expect(writes).toEqual([
      ['a', '4.75', 4],
      ['c', '0', 0],
    ]);
    expect(t.m.review.groupBy.mock.calls[0]?.[0].where).toEqual({
      status: 'APPROVED',
      deletedAt: null,
    });
  });

  it('D5: locks the product row, then aggregates, then writes, all in one transaction', async () => {
    const t = buildModuleTestApp([], { now: NOW });
    t.m.review.groupBy.mockResolvedValue([
      { productId: 'a', _avg: { rating: 4 }, _count: { _all: 1 } },
    ]);
    t.m.product.findMany.mockResolvedValue([
      { id: 'a', avgRating: new Prisma.Decimal('0'), reviewCount: 0 },
    ]);
    t.m.review.aggregate.mockResolvedValue({ _avg: { rating: 4 }, _count: { _all: 1 } });
    await runRatingAggregate(t.container);
    const lockCall = t.m.$queryRaw.mock.calls.find((c) => sqlOf(c[0]).includes('FOR UPDATE'));
    expect(sqlOf(lockCall?.[0])).toContain('FROM products WHERE id = ? FOR UPDATE');
    expect(lockCall?.[1]).toBe('a');
    const order = [
      t.m.$queryRaw.mock.invocationCallOrder[0] ?? 0,
      t.m.review.aggregate.mock.invocationCallOrder[0] ?? 0,
      t.m.product.update.mock.invocationCallOrder[0] ?? 0,
    ];
    expect(order).toEqual([...order].sort((x, y) => x - y));
    expect(t.m.$transaction).toHaveBeenCalledTimes(1);
  });

  it('WP10-2: one failing product transaction is logged and counted; the others still recompute', async () => {
    const t = buildModuleTestApp([], { now: NOW });
    const logError = vi.spyOn(t.container.logger, 'error');
    t.m.review.groupBy.mockResolvedValue([
      { productId: 'a', _avg: { rating: 4 }, _count: { _all: 1 } },
      { productId: 'b', _avg: { rating: 3 }, _count: { _all: 1 } },
      { productId: 'c', _avg: { rating: 5 }, _count: { _all: 1 } },
    ]);
    t.m.product.findMany.mockResolvedValue([
      { id: 'a', avgRating: new Prisma.Decimal('0'), reviewCount: 0 },
      { id: 'b', avgRating: new Prisma.Decimal('0'), reviewCount: 0 },
      { id: 'c', avgRating: new Prisma.Decimal('0'), reviewCount: 0 },
    ]);
    t.m.review.aggregate.mockResolvedValue({ _avg: { rating: 4 }, _count: { _all: 1 } });
    // The transaction for product "b" fails: it aborts, the run continues.
    t.m.$queryRaw.mockImplementation((_sql: unknown, id: unknown) =>
      id === 'b' ? Promise.reject(new Error('row lock failed')) : Promise.resolve([]),
    );
    expect(await runRatingAggregate(t.container)).toEqual({ products: 3, updated: 2, errors: 1 });
    expect(t.m.product.update.mock.calls.map((c): unknown => c[0].where.id)).toEqual(['a', 'c']);
    expect(logError).toHaveBeenCalledTimes(1);
    const [fields] = logError.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(fields.productId).toBe('b');
    expect((fields.err as Error).message).toBe('row lock failed');
  });

  it('WP10-2: product A fails, product B succeeds → { products: 2, updated: 1, errors: 1 }', async () => {
    const t = buildModuleTestApp([], { now: NOW });
    t.m.review.groupBy.mockResolvedValue([
      { productId: 'a', _avg: { rating: 4 }, _count: { _all: 1 } },
      { productId: 'b', _avg: { rating: 3 }, _count: { _all: 1 } },
    ]);
    t.m.product.findMany.mockResolvedValue([
      { id: 'a', avgRating: new Prisma.Decimal('0'), reviewCount: 0 },
      { id: 'b', avgRating: new Prisma.Decimal('0'), reviewCount: 0 },
    ]);
    t.m.review.aggregate.mockResolvedValue({ _avg: { rating: 3 }, _count: { _all: 1 } });
    t.m.$queryRaw.mockImplementation((_sql: unknown, id: unknown) =>
      id === 'a' ? Promise.reject(new Error('row lock failed')) : Promise.resolve([]),
    );
    await expect(runRatingAggregate(t.container)).resolves.toEqual({
      products: 2,
      updated: 1,
      errors: 1,
    });
    expect(t.m.product.update.mock.calls.map((c): unknown => c[0].where.id)).toEqual(['b']);
  });

  it('WP10-2: a failure outside the per-product loop still fails the whole run (job-level handling intact)', async () => {
    const t = buildModuleTestApp([], { now: NOW });
    const logError = vi.spyOn(t.container.logger, 'error');
    t.m.review.groupBy.mockRejectedValue(new Error('aggregate query failed'));
    await expect(runRatingAggregate(t.container)).rejects.toThrow('aggregate query failed');

    t.m.review.groupBy.mockResolvedValue([]);
    t.m.product.findMany.mockRejectedValue(new Error('product read failed'));
    await expect(runRatingAggregate(t.container)).rejects.toThrow('product read failed');

    expect(t.m.product.update).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
  });
});

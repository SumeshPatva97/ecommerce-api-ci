/**
 * Reports — pure units (registry, buckets, ranges, masking, derived metrics). No DB.
 */
import { describe, expect, it } from 'vitest';

import { AppError } from '../../../../src/core/errors/AppError.js';
import { Decimal } from '../../../../src/lib/money.js';
import {
  buildBuckets,
  changePercent,
  comparisonRange,
  defaultGroupBy,
  isoWeek,
  rollUp,
} from '../../../../src/modules/reports/reports.buckets.js';
import { classify } from '../../../../src/modules/reports/reports.customers.js';
import { filterEcho, selectColumns } from '../../../../src/modules/reports/reports.engine.js';
import { daysOfCover } from '../../../../src/modules/reports/reports.inventory.js';
import { unitLift } from '../../../../src/modules/reports/reports.marketing.js';
import { maskEmail, maskName, maskPhone } from '../../../../src/modules/reports/reports.mask.js';
import {
  ReportQuery,
  enumList,
  makeRange,
  resolveReportRange,
} from '../../../../src/modules/reports/reports.params.js';
import {
  maskProviderId,
  sanitizeFailure,
} from '../../../../src/modules/reports/reports.payments.js';
import {
  REPORT_REGISTRY,
  findReport,
  requiredPermissions,
} from '../../../../src/modules/reports/reports.registry.js';
import { deriveSales, SALES_METRICS } from '../../../../src/modules/reports/reports.sales.js';
import { ident, normalizeRow, toDec } from '../../../../src/modules/reports/reports.sql.js';
import { REPORT_KEYS } from '../../../../src/modules/reports/reports.types.js';

const NOW = new Date('2026-11-19T06:30:00.000Z');

function validationField(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('VALIDATION_ERROR');
    return (error as AppError).details?.[0]?.field;
  }
  throw new Error('expected a validation error');
}

describe('report registry', () => {
  it('covers all 20 canonical keys exactly once', () => {
    expect(REPORT_KEYS).toHaveLength(20);
    expect(Object.keys(REPORT_REGISTRY).sort()).toEqual([...REPORT_KEYS].sort());
    for (const key of REPORT_KEYS) {
      const def = findReport(key);
      expect(def?.key).toBe(key);
      expect(def?.title).toBeTruthy();
      expect(def?.version).toBe('1.0');
    }
    expect(findReport('nope')).toBeUndefined();
    expect(findReport('__proto__')).toBeUndefined();
  });

  it('maps domain permissions per family (R-14 / OQ-68)', () => {
    const domain = Object.fromEntries(
      REPORT_KEYS.map((k) => [k, [...REPORT_REGISTRY[k].domainPermissions]]),
    );
    expect(domain).toEqual({
      sales: [],
      orders: [],
      'order-status': [],
      'product-sales': [],
      'category-sales': [],
      'brand-sales': [],
      'best-sellers': [],
      'inventory-valuation': ['inventory.view'],
      'low-stock': ['inventory.view'],
      'customers-new-returning': ['customers.view'],
      'top-customers': ['customers.view'],
      coupons: [],
      promotions: [],
      'gst-summary': ['tax.view'],
      'gst-hsn': ['tax.view'],
      'gst-b2c': ['tax.view'],
      'gst-b2b': ['tax.view'],
      'gst-credit-notes': ['tax.view'],
      payments: ['payments.view'],
      refunds: ['refunds.view'],
    });
    expect(requiredPermissions(REPORT_REGISTRY['gst-hsn'], 'view')).toEqual([
      'reports.view',
      'tax.view',
    ]);
    expect(requiredPermissions(REPORT_REGISTRY['gst-hsn'], 'export')).toEqual([
      'reports.view',
      'tax.view',
      'reports.export',
    ]);
    // Customer-data exports (R-15).
    expect(requiredPermissions(REPORT_REGISTRY['top-customers'], 'export')).toEqual([
      'reports.view',
      'customers.view',
      'reports.export',
      'customers.export',
    ]);
    expect(REPORT_KEYS.filter((k) => REPORT_REGISTRY[k].customerData).sort()).toEqual([
      'customers-new-returning',
      'top-customers',
    ]);
    expect(REPORT_KEYS.filter((k) => REPORT_REGISTRY[k].footer !== undefined)).toHaveLength(5);
  });
});

describe('IST range resolution', () => {
  const opts = { dateMode: 'required' as const, maxDays: 366, now: NOW };

  it('converts inclusive IST dates to a UTC half-open range', () => {
    const range = resolveReportRange({ from: '2026-11-01', to: '2026-11-13' }, opts);
    expect(range?.start.toISOString()).toBe('2026-10-31T18:30:00.000Z');
    expect(range?.end.toISOString()).toBe('2026-11-13T18:30:00.000Z');
    expect(range?.days).toBe(13);
  });

  it('requires from/to, rejects reversed and over-long ranges with the field', () => {
    expect(validationField(() => resolveReportRange({ to: '2026-11-13' }, opts))).toBe('from');
    expect(
      validationField(() => resolveReportRange({ from: '2026-11-13', to: '2026-11-01' }, opts)),
    ).toBe('to');
    expect(
      validationField(() => resolveReportRange({ from: '2025-01-01', to: '2026-11-01' }, opts)),
    ).toBe('to');
    expect(resolveReportRange({}, { ...opts, dateMode: 'none' })).toBeNull();
  });

  it('supports GST periods and optional ranges (last 90 days)', () => {
    const feb = resolveReportRange({ period: '2028-02' }, opts);
    expect([feb?.from, feb?.to]).toEqual(['2028-02-01', '2028-02-29']);
    const optional = resolveReportRange({}, { ...opts, dateMode: 'optional' });
    expect(optional?.to).toBe('2026-11-19');
    expect(optional?.days).toBe(90);
  });

  it('validates query syntax and report-specific enum lists', () => {
    expect(ReportQuery.safeParse({ from: '2026-02-30' }).success).toBe(false);
    expect(ReportQuery.safeParse({ limit: '101' }).success).toBe(false);
    expect(ReportQuery.parse({ status: 'confirmed,packed' }).status).toEqual([
      'CONFIRMED',
      'PACKED',
    ]);
    expect(validationField(() => enumList(['NOPE'], ['A', 'B'], 'status'))).toBe('status');
  });
});

describe('time buckets', () => {
  it('labels ISO weeks across year boundaries (R12)', () => {
    expect(isoWeek('2026-11-13')).toMatchObject({ label: '2026-W46', weekStart: '2026-11-09' });
    expect(isoWeek('2026-12-31').label).toBe('2026-W53');
    expect(isoWeek('2027-01-03').label).toBe('2026-W53');
    expect(isoWeek('2027-01-04').label).toBe('2027-W01');
    expect(isoWeek('2024-12-30').label).toBe('2025-W01');
  });

  it('flags partial buckets, groups FY / quarter and picks a default grouping', () => {
    const range = makeRange('2026-11-12', '2026-11-30');
    const { buckets } = buildBuckets(range, 'week');
    expect(buckets[0]).toMatchObject({ key: '2026-W46', isPartial: true, start: '2026-11-12' });
    expect(buckets[1]).toMatchObject({ key: '2026-W47', isPartial: false });
    const fy = buildBuckets(makeRange('2026-03-30', '2026-04-02'), 'fy').buckets.map((b) => b.key);
    expect(fy).toEqual(['FY2025-26', 'FY2026-27']);
    const q = buildBuckets(makeRange('2026-01-01', '2026-12-31'), 'quarter').buckets;
    expect(q.map((b) => b.key)).toEqual(['2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4']);
    expect(q.every((b) => !b.isPartial)).toBe(true);
    expect(defaultGroupBy(62)).toBe('day');
    expect(defaultGroupBy(63)).toBe('month');
  });

  it('rolls up per-day metrics with zero-fill and range totals', () => {
    const range = makeRange('2026-11-01', '2026-11-03');
    const perDay = new Map([
      ['2026-11-01', { orders: new Decimal(2), orderValue: new Decimal('100.50') }],
      ['2026-11-03', { orders: new Decimal(1), orderValue: new Decimal('-20.00') }],
    ]);
    const { series, totals } = rollUp(perDay, ['orders', 'orderValue'] as const, range, 'day');
    expect(series.map((s) => [s.bucket.key, s.values.orders.toNumber()])).toEqual([
      ['2026-11-01', 2],
      ['2026-11-02', 0],
      ['2026-11-03', 1],
    ]);
    expect(totals.orderValue.toFixed(2)).toBe('80.50');
    expect(comparisonRange(range, 'previous_period')).toEqual({
      from: '2026-10-29',
      to: '2026-10-31',
    });
    expect(comparisonRange(makeRange('2028-02-29', '2028-02-29'), 'previous_year')).toEqual({
      from: '2027-02-28',
      to: '2027-02-28',
    });
    expect(changePercent(new Decimal(110), new Decimal(100))).toBe('10.00');
    expect(changePercent(new Decimal(1), new Decimal(0))).toBeNull();
  });
});

describe('derived metrics', () => {
  it('reproduces the §4.4 worked example (basis=transaction)', () => {
    const zero = Object.fromEntries(SALES_METRICS.map((k) => [k, new Decimal(0)])) as Record<
      (typeof SALES_METRICS)[number],
      Decimal
    >;
    const m = {
      ...zero,
      orders: new Decimal(2),
      grossSales: new Decimal('6560.00'),
      itemDiscounts: new Decimal('140.00'),
      couponDiscounts: new Decimal('200.00'),
      orderValue: new Decimal('6320.00'),
      refunds: new Decimal('2675.00'),
    };
    const d = deriveSales(m);
    expect(d.netSales?.toFixed(2)).toBe('6220.00');
    expect(d.discounts?.toFixed(2)).toBe('340.00');
    expect(d.netRevenue?.toFixed(2)).toBe('3645.00');
    expect(d.aov?.toFixed(2)).toBe('3160.00');
  });

  it('classifies new vs returning customers per period (§4.5)', () => {
    const t = {
      signUps: 0,
      newCustomers: 0,
      returningCustomers: 0,
      newOrders: 0,
      returningOrders: 0,
      newRevenue: new Decimal(0),
      returningRevenue: new Decimal(0),
    };
    classify(
      new Map([
        ['a', { orders: 2, revenue: new Decimal('100'), firstDay: '2026-11-10' }],
        ['b', { orders: 1, revenue: new Decimal('50'), firstDay: '2026-10-01' }],
      ]),
      '2026-11-09',
      t,
    );
    expect([t.newCustomers, t.returningCustomers, t.newOrders]).toEqual([1, 1, 2]);
    expect(t.returningRevenue.toFixed(2)).toBe('50.00');
  });

  it('computes days of cover, unit lift and masks', () => {
    expect(daysOfCover(10, 0)).toBe('∞');
    expect(daysOfCover(10, 60)).toBe('5.00');
    expect(unitLift(15, 10)).toBe('50.00');
    expect(unitLift(5, 0)).toBe('n/a');
    expect(maskEmail('ravi@example.com')).toBe('r***@example.com');
    expect(maskPhone('+919876543210')).toBe('+91******3210');
    expect(maskName('Ravi Kulkarni')).toBe('R*** K***');
    expect(maskProviderId('pay_ABCDEFGH123456')).toBe('********123456');
    expect(sanitizeFailure('BAD_REQUEST', 'card\ndeclined')).toBe('BAD_REQUEST: card declined');
  });
});

describe('SQL helpers & export columns', () => {
  it('normalises money as 2-dp strings and rejects unsafe identifiers', () => {
    const row = normalizeRow(
      [
        { key: 'a', label: 'A', type: 'money' },
        { key: 'b', label: 'B', type: 'int' },
        { key: 'c', label: 'C', type: 'datetime' },
        { key: 'd', label: 'D', type: 'boolean' },
        { key: 'e', label: 'E', type: 'date' },
      ],
      {
        a: new Decimal('1499.5'),
        b: 7n,
        c: new Date('2026-11-19T06:30:00Z'),
        d: 1,
        e: new Date('2026-11-19T00:00:00Z'),
      },
    );
    expect(row).toEqual({
      a: '1499.50',
      b: 7,
      c: '2026-11-19T06:30:00.000Z',
      d: true,
      e: '2026-11-19',
    });
    expect(toDec('12.345').toFixed(3)).toBe('12.345');
    expect(() => ident('o.id; DROP TABLE x')).toThrow();
  });

  it('selects export columns and rejects unknown ones (422)', () => {
    const cols = [
      { key: 'a', label: 'A', type: 'string' as const },
      { key: 'b', label: 'B', type: 'int' as const },
    ];
    expect(selectColumns(cols, ['b']).map((c) => c.key)).toEqual(['b']);
    expect(validationField(() => selectColumns(cols, ['zz']))).toBe('columns');
    const echo = filterEcho(
      REPORT_REGISTRY.orders,
      ReportQuery.parse({ from: '2026-11-01', to: '2026-11-02', groupBy: 'day' }),
      makeRange('2026-11-01', '2026-11-02'),
    );
    expect(echo).toMatchObject({ from: '2026-11-01', to: '2026-11-02', timezone: 'Asia/Kolkata' });
    expect(echo).not.toHaveProperty('groupBy');
  });
});

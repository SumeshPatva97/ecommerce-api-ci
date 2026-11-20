import { describe, expect, it } from 'vitest';

import {
  deriveComponentRates,
  gstinCheckChar,
  gstinStateCode,
  isEffectiveOn,
  isValidGstin,
  selectAssignment,
  toIstDateString,
  windowEnd,
  windowsOverlap,
  type AssignmentCandidate,
} from '../../../../src/lib/tax/index.js';
import { istDayRange } from '../../../../src/lib/time.js';

const day = (iso: string): Date => istDayRange(iso).start;

describe('effective windows (IST dates, inclusive end)', () => {
  const w = { effectiveFrom: day('2026-04-01'), effectiveTo: day('2026-12-31') };

  it('covers the whole inclusive end day', () => {
    expect(isEffectiveOn(w, day('2026-04-01'))).toBe(true);
    expect(isEffectiveOn(w, new Date(day('2027-01-01').getTime() - 1))).toBe(true);
    expect(isEffectiveOn(w, day('2027-01-01'))).toBe(false);
    expect(isEffectiveOn(w, new Date(day('2026-04-01').getTime() - 1))).toBe(false);
    expect(windowEnd(w)?.toISOString()).toBe(day('2027-01-01').toISOString());
  });

  it('treats a null end as open', () => {
    const open = { effectiveFrom: day('2026-01-01'), effectiveTo: null };
    expect(windowEnd(open)).toBeNull();
    expect(isEffectiveOn(open, day('2099-01-01'))).toBe(true);
  });

  it('detects overlaps', () => {
    const a = { effectiveFrom: day('2026-01-01'), effectiveTo: day('2026-06-30') };
    const b = { effectiveFrom: day('2026-07-01'), effectiveTo: null };
    const c = { effectiveFrom: day('2026-06-30'), effectiveTo: day('2026-08-01') };
    expect(windowsOverlap(a, b)).toBe(false);
    expect(windowsOverlap(b, a)).toBe(false);
    expect(windowsOverlap(a, c)).toBe(true);
    expect(windowsOverlap(b, c)).toBe(true);
    expect(windowsOverlap(b, { effectiveFrom: day('2030-01-01'), effectiveTo: null })).toBe(true);
  });

  it('formats IST dates', () => {
    expect(toIstDateString(day('2026-11-19'))).toBe('2026-11-19');
  });
});

describe('selectAssignment precedence', () => {
  const rate = (isActive = true) => ({ id: 'r', rate: '3.00', isActive });
  const base = {
    taxRateId: 'r',
    hsnCode: '7117',
    effectiveFrom: day('2026-01-01'),
    effectiveTo: null,
  };
  const productA: AssignmentCandidate = {
    ...base,
    id: 'pa',
    targetType: 'PRODUCT',
    productId: 'p1',
    categoryId: null,
    taxRate: rate(),
  };
  const catChild: AssignmentCandidate = {
    ...base,
    id: 'cc',
    targetType: 'CATEGORY',
    productId: null,
    categoryId: 'child',
    taxRate: rate(),
  };
  const catRoot: AssignmentCandidate = {
    ...base,
    id: 'cr',
    targetType: 'CATEGORY',
    productId: null,
    categoryId: 'root',
    taxRate: rate(),
  };
  const at = day('2026-11-19');

  it('prefers product over nearest category over ancestor', () => {
    expect(selectAssignment([catRoot, catChild, productA], 'p1', ['child', 'root'], at)).toEqual({
      assignment: productA,
      source: 'PRODUCT',
      categoryId: null,
    });
    const viaChild = selectAssignment([catRoot, catChild], 'p1', ['child', 'root'], at);
    expect(viaChild).toMatchObject({ source: 'CATEGORY', categoryId: 'child' });
    const viaRoot = selectAssignment([catRoot], 'p1', ['child', 'root'], at);
    expect(viaRoot).toMatchObject({ source: 'CATEGORY', categoryId: 'root' });
  });

  it('ignores windows not effective on the date and fails closed', () => {
    const future = { ...productA, effectiveFrom: day('2027-01-01') };
    expect(selectAssignment([future], 'p1', [], at)).toBe('NO_ASSIGNMENT');
    expect(
      selectAssignment([{ ...productA, taxRate: rate(false) }, catChild], 'p1', ['child'], at),
    ).toBe('RATE_INACTIVE');
    expect(selectAssignment([{ ...catChild, taxRate: rate(false) }], 'p1', ['child'], at)).toBe(
      'RATE_INACTIVE',
    );
  });
});

describe('deriveComponentRates', () => {
  it('splits CGST/SGST/UTGST = rate/2 and IGST = rate', () => {
    const r = deriveComponentRates('3');
    expect(r?.cgstRate.toFixed(2)).toBe('1.50');
    expect(r?.igstRate.toFixed(2)).toBe('3.00');
    expect(deriveComponentRates('0')?.sgstRate.toFixed(2)).toBe('0.00');
  });

  it('rejects unrepresentable or out-of-range rates', () => {
    expect(deriveComponentRates('0.25')).toBeUndefined();
    expect(deriveComponentRates('0.125')).toBeUndefined();
    expect(deriveComponentRates('101')).toBeUndefined();
    expect(deriveComponentRates('-1')).toBeUndefined();
  });
});

describe('GSTIN', () => {
  const first14 = '27AAPFU0939F1Z';
  const valid = `${first14}${gstinCheckChar(first14)}`;

  it('validates format and checksum', () => {
    expect(isValidGstin(valid)).toBe(true);
    expect(gstinStateCode(valid)).toBe('27');
    const wrongCheck = `${first14}${valid.endsWith('0') ? '1' : '0'}`;
    expect(isValidGstin(wrongCheck)).toBe(false);
    expect(isValidGstin('27aapfu0939f1zv')).toBe(false);
    expect(isValidGstin('27AAPFU0939F1Z')).toBe(false);
  });

  it('matches a published sample', () => {
    expect(isValidGstin('27AAPFU0939F1ZV')).toBe(true);
  });
});

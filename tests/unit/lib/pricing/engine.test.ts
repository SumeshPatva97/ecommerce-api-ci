/**
 * Pricing engine (pure) — BACKEND_STRUCTURE.md §8, API_DOCUMENTATION.md §3.4/§3.9 worked example.
 * No DB, no mocks.
 */
import { describe, expect, it } from 'vitest';

import {
  allocateLargestRemainder,
  couponAmount,
  couponFailureText,
  couponPreconditionFailure,
  formatIstDate,
  isLineCouponApplicable,
  isPromotionEffective,
  priceCart,
  promotionMatchesLine,
  promotionUnitDiscount,
  selectBestPromotion,
  type CouponSnapshot,
  type PricingLineInput,
  type PromotionSnapshot,
} from '../../../../src/lib/pricing/index.js';
import { Decimal } from '../../../../src/lib/money.js';

const NOW = new Date('2026-11-13T09:45:12.345Z');
const d = (v: string | number): Decimal => new Decimal(v);
const FIRST = { isFirstOrder: true, couponUsesByCustomer: 0 };

function line(over: Partial<PricingLineInput> = {}): PricingLineInput {
  return {
    lineId: 'ci-1',
    variantId: 'v-1',
    productId: 'p-1',
    categoryId: 'c-ear',
    categoryPath: ['c-ear', 'c-jewellery'],
    brandId: 'b-1',
    collectionIds: ['col-1'],
    quantity: 1,
    mrp: d('1199.00'),
    sellingPrice: d('999.00'),
    ...over,
  };
}

function promo(over: Partial<PromotionSnapshot> = {}): PromotionSnapshot {
  return {
    id: 'p-fest',
    name: 'Festive 10% off',
    scope: 'CATEGORY',
    discountType: 'PERCENTAGE',
    discountValue: d(10),
    maxDiscountAmount: null,
    startsAt: new Date('2026-11-01T00:00:00.000Z'),
    endsAt: new Date('2026-12-01T00:00:00.000Z'),
    status: 'ACTIVE',
    deleted: false,
    priority: 50,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    targets: [{ id: 'c-ear' }],
    ...over,
  };
}

function coupon(over: Partial<CouponSnapshot> = {}): CouponSnapshot {
  return {
    id: 'cp-1',
    code: 'WELCOME10',
    description: '10% off up to ₹300',
    status: 'ACTIVE',
    deleted: false,
    discountType: 'PERCENTAGE',
    discountValue: d(10),
    maxDiscountAmount: d(300),
    minOrderValue: null,
    startsAt: new Date('2026-11-01T00:00:00.000Z'),
    expiresAt: new Date('2026-12-01T00:00:00.000Z'),
    usageLimitEnabled: false,
    usageLimit: null,
    usedCount: 0,
    perCustomerLimit: null,
    isFirstOrderOnly: false,
    isCombinableWithPromotions: true,
    rules: [],
    ...over,
  };
}

const JHUMKA = line({
  lineId: 'ci-1',
  variantId: 'v-meera-gold-s',
  productId: 'p-meera',
  quantity: 2,
  mrp: d('1799.00'),
  sellingPrice: d('1499.00'),
});
const RING = line({
  lineId: 'ci-2',
  variantId: 'v-ring-silver-7',
  productId: 'p-tara',
  categoryId: 'c-ring',
  categoryPath: ['c-ring', 'c-jewellery'],
  brandId: 'b-2',
  collectionIds: [],
});

describe('priceCart — API_DOCUMENTATION §3.9 worked example (WELCOME10)', () => {
  const result = priceCart({
    lines: [JHUMKA, RING],
    promotions: [promo()],
    coupon: coupon(),
    customer: FIRST,
    now: NOW,
  });

  it('applies the best promotion to line 1 only', () => {
    const [l1, l2] = result.lines;
    expect(l1?.lineBase.toFixed(2)).toBe('2998.00');
    expect(l1?.promotion).toMatchObject({ id: 'p-fest', scope: 'CATEGORY' });
    expect(l1?.promotionDiscount.toFixed(2)).toBe('299.80');
    expect(l1?.postPromotionValue.toFixed(2)).toBe('2698.20');
    expect(l2?.promotion).toBeNull();
    expect(l2?.postPromotionValue.toFixed(2)).toBe('999.00');
  });

  it('caps the coupon at 300.00 and allocates 218.94 / 81.06', () => {
    expect(result.coupon).toMatchObject({ status: 'APPLIED', capped: true });
    if (result.coupon?.status !== 'APPLIED') throw new Error('expected applied');
    expect(result.coupon.eligibleBase.toFixed(2)).toBe('3697.20');
    expect(result.coupon.computed.toFixed(2)).toBe('369.72');
    expect(result.coupon.applied.toFixed(2)).toBe('300.00');
    expect(result.lines.map((l) => l.couponDiscount.toFixed(2))).toEqual(['218.94', '81.06']);
    expect(result.lines.map((l) => l.netLineValue.toFixed(2))).toEqual(['2479.26', '917.94']);
    expect(result.lines.every((l) => l.couponEligible)).toBe(true);
  });

  it('produces the documented totals', () => {
    expect(result.totals.subtotal.toFixed(2)).toBe('3997.00');
    expect(result.totals.itemDiscountTotal.toFixed(2)).toBe('299.80');
    expect(result.totals.couponDiscountTotal.toFixed(2)).toBe('300.00');
    expect(result.totals.netItemTotal.toFixed(2)).toBe('3397.20');
    expect(result.totals.mrpTotal.toFixed(2)).toBe('4797.00');
    expect(result.now).toBe(NOW);
  });
});

describe('priceCart — basics', () => {
  it('prices without promotions or coupon', () => {
    const r = priceCart({ lines: [RING], promotions: [], customer: FIRST, now: NOW });
    expect(r.coupon).toBeNull();
    expect(r.lines[0]?.netLineValue.toFixed(2)).toBe('999.00');
    expect(r.lines[0]?.couponEligible).toBe(false);
  });

  it('handles an empty cart', () => {
    const r = priceCart({ lines: [], promotions: [], coupon: null, customer: FIRST, now: NOW });
    expect(r.totals.subtotal.toFixed(2)).toBe('0.00');
  });

  it('excludes promoted lines when the coupon is not combinable', () => {
    const r = priceCart({
      lines: [JHUMKA, RING],
      promotions: [promo()],
      coupon: coupon({ isCombinableWithPromotions: false, maxDiscountAmount: null }),
      customer: FIRST,
      now: NOW,
    });
    expect(r.lines.map((l) => l.couponDiscount.toFixed(2))).toEqual(['0.00', '99.90']);
    expect(r.lines.map((l) => l.couponEligible)).toEqual([false, true]);
  });

  it('rejects a non-combinable coupon when all applicable lines are promoted', () => {
    const r = priceCart({
      lines: [JHUMKA],
      promotions: [promo()],
      coupon: coupon({ isCombinableWithPromotions: false }),
      customer: FIRST,
      now: NOW,
    });
    expect(r.coupon).toMatchObject({
      status: 'REJECTED',
      failure: { reason: 'COUPON_NOT_COMBINABLE' },
    });
    expect(r.totals.couponDiscountTotal.toFixed(2)).toBe('0.00');
  });

  it('rejects when no line is applicable', () => {
    const r = priceCart({
      lines: [RING],
      promotions: [],
      coupon: coupon({ rules: [{ ruleType: 'INCLUDE', targetType: 'BRAND', targetId: 'b-x' }] }),
      customer: FIRST,
      now: NOW,
    });
    expect(r.coupon).toMatchObject({ failure: { reason: 'COUPON_NOT_APPLICABLE' } });
  });

  it('reports the min-order shortfall on the eligible post-promotion subtotal', () => {
    const r = priceCart({
      lines: [JHUMKA],
      promotions: [promo({ discountValue: d(50) })],
      coupon: coupon({ minOrderValue: d('2000.00') }),
      customer: FIRST,
      now: NOW,
    });
    expect(r.coupon?.status).toBe('REJECTED');
    if (r.coupon?.status !== 'REJECTED') throw new Error('expected rejected');
    expect(r.coupon.failure.reason).toBe('COUPON_MIN_ORDER_NOT_MET');
    expect(r.coupon.failure.eligibleSubtotal?.toFixed(2)).toBe('1499.00');
    expect(r.coupon.failure.shortfall?.toFixed(2)).toBe('501.00');
  });

  it('applies a FIXED coupon limited to the eligible base', () => {
    const r = priceCart({
      lines: [RING],
      promotions: [],
      coupon: coupon({
        discountType: 'FIXED_AMOUNT',
        discountValue: d(5000),
        maxDiscountAmount: null,
      }),
      customer: FIRST,
      now: NOW,
    });
    if (r.coupon?.status !== 'APPLIED') throw new Error('expected applied');
    expect(r.coupon.applied.toFixed(2)).toBe('999.00');
    expect(r.coupon.capped).toBe(true);
    expect(r.lines[0]?.netLineValue.toFixed(2)).toBe('0.00');
  });

  it('gives the rounding remainder to the largest line', () => {
    const lines = ['a', 'b', 'c'].map((id) =>
      line({ lineId: id, productId: id, sellingPrice: d('100.00') }),
    );
    const r = priceCart({
      lines,
      promotions: [],
      coupon: coupon({
        discountType: 'FIXED_AMOUNT',
        discountValue: d(100),
        maxDiscountAmount: null,
      }),
      customer: FIRST,
      now: NOW,
    });
    expect(r.lines.map((l) => l.couponDiscount.toFixed(2))).toEqual(['33.34', '33.33', '33.33']);
    expect(r.totals.couponDiscountTotal.toFixed(2)).toBe('100.00');
  });
});

describe('promotions', () => {
  it('evaluates the effective window and status', () => {
    expect(isPromotionEffective(promo(), NOW)).toBe(true);
    expect(isPromotionEffective(promo({ status: 'SCHEDULED' }), NOW)).toBe(true);
    expect(isPromotionEffective(promo({ startsAt: null, endsAt: null }), NOW)).toBe(true);
    expect(isPromotionEffective(promo({ deleted: true }), NOW)).toBe(false);
    expect(isPromotionEffective(promo({ status: 'PAUSED' }), NOW)).toBe(false);
    expect(isPromotionEffective(promo({ startsAt: new Date('2026-11-14T00:00:00Z') }), NOW)).toBe(
      false,
    );
    expect(isPromotionEffective(promo({ endsAt: NOW }), NOW)).toBe(false);
  });

  it('matches each scope', () => {
    expect(
      promotionMatchesLine(promo({ scope: 'PRODUCT', targets: [{ id: 'p-1' }] }), line()),
    ).toBe(true);
    expect(promotionMatchesLine(promo({ scope: 'BRAND', targets: [{ id: 'b-1' }] }), line())).toBe(
      true,
    );
    expect(
      promotionMatchesLine(
        promo({ scope: 'BRAND', targets: [{ id: 'b-1' }] }),
        line({ brandId: null }),
      ),
    ).toBe(false);
    expect(
      promotionMatchesLine(promo({ scope: 'COLLECTION', targets: [{ id: 'col-1' }] }), line()),
    ).toBe(true);
    // ancestor category, with and without descendants
    expect(promotionMatchesLine(promo({ targets: [{ id: 'c-jewellery' }] }), line())).toBe(true);
    expect(
      promotionMatchesLine(
        promo({ targets: [{ id: 'c-jewellery', includeDescendants: false }] }),
        line(),
      ),
    ).toBe(false);
    expect(
      promotionMatchesLine(
        promo({ targets: [{ id: 'c-ear', includeDescendants: false }] }),
        line(),
      ),
    ).toBe(true);
  });

  it('computes unit discounts with caps and floors', () => {
    expect(promotionUnitDiscount(promo(), d('999.00')).toFixed(2)).toBe('99.90');
    expect(promotionUnitDiscount(promo({ maxDiscountAmount: d(50) }), d('999.00')).toFixed(2)).toBe(
      '50.00',
    );
    expect(
      promotionUnitDiscount(
        promo({ discountType: 'FIXED_AMOUNT', discountValue: d(200) }),
        d('999.00'),
      ).toFixed(2),
    ).toBe('200.00');
    // never below ₹0.01
    expect(
      promotionUnitDiscount(
        promo({ discountType: 'FIXED_AMOUNT', discountValue: d(5000) }),
        d('999.00'),
      ).toFixed(2),
    ).toBe('998.99');
    expect(
      promotionUnitDiscount(
        promo({ discountType: 'FIXED_AMOUNT', discountValue: d(5) }),
        d('0.01'),
      ).toFixed(2),
    ).toBe('0.00');
  });

  it('selects the largest discount, then priority, then age, then id', () => {
    const l = line();
    const small = promo({ id: 'small', discountValue: d(5) });
    const big = promo({ id: 'big', discountValue: d(20) });
    expect(selectBestPromotion(l, [small, big], NOW)?.id).toBe('big');
    const prioLow = promo({ id: 'x', priority: 10 });
    const prioHigh = promo({ id: 'y', priority: 90 });
    expect(selectBestPromotion(l, [prioHigh, prioLow], NOW)?.id).toBe('x');
    const older = promo({ id: 'z', createdAt: new Date('2026-01-01T00:00:00Z') });
    expect(selectBestPromotion(l, [promo({ id: 'w' }), older], NOW)?.id).toBe('z');
    expect(selectBestPromotion(l, [promo({ id: 'b2' }), promo({ id: 'a1' })], NOW)?.id).toBe('a1');
    expect(selectBestPromotion(l, [promo({ id: 'a1' }), promo({ id: 'b2' })], NOW)?.id).toBe('a1');
    expect(selectBestPromotion(l, [promo({ status: 'DRAFT' })], NOW)).toBeNull();
    expect(selectBestPromotion(l, [promo({ targets: [{ id: 'other' }] })], NOW)).toBeNull();
    expect(
      selectBestPromotion(l, [promo({ discountType: 'FIXED_AMOUNT', discountValue: d(0) })], NOW),
    ).toBeNull();
    expect(selectBestPromotion(line({ quantity: 3 }), [big], NOW)?.discount.toFixed(2)).toBe(
      '599.40',
    );
  });
});

describe('coupon rules', () => {
  it('evaluates preconditions in the documented order', () => {
    const c = (over: Partial<CouponSnapshot>) =>
      couponPreconditionFailure(coupon(over), FIRST, NOW)?.reason;
    expect(c({ deleted: true, status: 'INACTIVE' })).toBe('COUPON_NOT_FOUND');
    expect(c({ status: 'INACTIVE' })).toBe('COUPON_INACTIVE');
    expect(c({ startsAt: new Date('2026-11-20T00:00:00Z') })).toBe('COUPON_NOT_STARTED');
    expect(c({ expiresAt: NOW })).toBe('COUPON_EXPIRED');
    expect(c({ usageLimitEnabled: true, usageLimit: 3, usedCount: 3 })).toBe(
      'COUPON_USAGE_LIMIT_REACHED',
    );
    expect(c({ usageLimitEnabled: true, usageLimit: 3, usedCount: 2 })).toBeUndefined();
    expect(c({ usageLimitEnabled: true, usageLimit: null, usedCount: 9 })).toBeUndefined();
    expect(c({ startsAt: null, expiresAt: null })).toBeUndefined();
    expect(
      couponPreconditionFailure(
        coupon({ perCustomerLimit: 1 }),
        { isFirstOrder: true, couponUsesByCustomer: 1 },
        NOW,
      )?.reason,
    ).toBe('COUPON_CUSTOMER_LIMIT_REACHED');
    expect(
      couponPreconditionFailure(
        coupon({ isFirstOrderOnly: true }),
        { isFirstOrder: false, couponUsesByCustomer: 0 },
        NOW,
      )?.reason,
    ).toBe('COUPON_FIRST_ORDER_ONLY');
    expect(couponPreconditionFailure(coupon({ isFirstOrderOnly: true }), FIRST, NOW)).toBeNull();
  });

  it('rejects in the engine with the precondition reason', () => {
    const r = priceCart({
      lines: [RING],
      promotions: [],
      coupon: coupon({ status: 'INACTIVE' }),
      customer: FIRST,
      now: NOW,
    });
    expect(r.coupon).toEqual({
      status: 'REJECTED',
      couponId: 'cp-1',
      code: 'WELCOME10',
      failure: { reason: 'COUPON_INACTIVE' },
    });
  });

  it('applies include/exclude rules (exclude wins, categories include descendants)', () => {
    const l = line();
    const rules = (r: CouponSnapshot['rules']) => isLineCouponApplicable(coupon({ rules: r }), l);
    expect(rules([])).toBe(true);
    expect(rules([{ ruleType: 'INCLUDE', targetType: 'CATEGORY', targetId: 'c-jewellery' }])).toBe(
      true,
    );
    expect(rules([{ ruleType: 'INCLUDE', targetType: 'PRODUCT', targetId: 'p-x' }])).toBe(false);
    expect(
      rules([
        { ruleType: 'INCLUDE', targetType: 'CATEGORY', targetId: 'c-ear' },
        { ruleType: 'EXCLUDE', targetType: 'BRAND', targetId: 'b-1' },
      ]),
    ).toBe(false);
    expect(rules([{ ruleType: 'EXCLUDE', targetType: 'COLLECTION', targetId: 'col-9' }])).toBe(
      true,
    );
  });

  it('computes coupon amounts', () => {
    const pct = couponAmount(coupon({ maxDiscountAmount: null }), d('3697.20'));
    expect([pct.computed.toFixed(2), pct.applied.toFixed(2), pct.capped]).toEqual([
      '369.72',
      '369.72',
      false,
    ]);
    const under = couponAmount(coupon(), d('1000.00'));
    expect(under.capped).toBe(false);
    const fixed = couponAmount(
      coupon({ discountType: 'FIXED_AMOUNT', discountValue: d(500) }),
      d('4999.00'),
    );
    expect([fixed.applied.toFixed(2), fixed.capped]).toEqual(['500.00', false]);
  });

  it('allocates with the largest-remainder rule', () => {
    expect(allocateLargestRemainder(d(10), [d(0), d(0)]).map((x) => x.toFixed(2))).toEqual([
      '0.00',
      '0.00',
    ]);
    // ties → first entry absorbs the (negative) remainder
    expect(
      allocateLargestRemainder(d('0.02'), [d(1), d(1), d(1)]).map((x) => x.toFixed(2)),
    ).toEqual(['0.00', '0.01', '0.01']);
    // negative remainder taken from the largest line
    expect(
      allocateLargestRemainder(d('1.00'), [d(1), d(1), d(1), d(5)]).map((x) => x.toFixed(2)),
    ).toEqual(['0.13', '0.13', '0.13', '0.61']);
  });
});

describe('coupon failure texts', () => {
  it('formats every reason', () => {
    expect(formatIstDate(new Date('2026-10-31T18:29:59.999Z'))).toBe('31 Oct 2026');
    const reasons = [
      'COUPON_NOT_FOUND',
      'COUPON_INACTIVE',
      'COUPON_USAGE_LIMIT_REACHED',
      'COUPON_CUSTOMER_LIMIT_REACHED',
      'COUPON_FIRST_ORDER_ONLY',
      'COUPON_NOT_APPLICABLE',
      'COUPON_NOT_COMBINABLE',
    ] as const;
    for (const reason of reasons) expect(couponFailureText({ reason }).message).not.toBe('');
    expect(
      couponFailureText({
        reason: 'COUPON_EXPIRED',
        expiresAt: new Date('2026-10-31T18:29:59.999Z'),
      }),
    ).toEqual({
      message: 'This coupon has expired.',
      detail: 'Expired on 31 Oct 2026.',
      meta: { expiresAt: '2026-10-31T18:29:59.999Z' },
    });
    expect(couponFailureText({ reason: 'COUPON_EXPIRED' }).meta).toBeUndefined();
    expect(
      couponFailureText({
        reason: 'COUPON_NOT_STARTED',
        startsAt: new Date('2026-11-14T18:30:00.000Z'),
      }).message,
    ).toBe('This coupon is valid from 15 Nov 2026.');
    expect(couponFailureText({ reason: 'COUPON_NOT_STARTED' }).meta).toBeUndefined();
    expect(
      couponFailureText({
        reason: 'COUPON_MIN_ORDER_NOT_MET',
        minOrderValue: d(2000),
        eligibleSubtotal: d('1497.20'),
        shortfall: d('502.80'),
      }),
    ).toEqual({
      message: 'Add items worth ₹502.80 more to use this coupon.',
      detail: 'Minimum eligible order value is ₹2000.00.',
      meta: { minOrderValue: '2000.00', eligibleSubtotal: '1497.20', shortfall: '502.80' },
    });
    expect(couponFailureText({ reason: 'COUPON_MIN_ORDER_NOT_MET' }).meta?.shortfall).toBe('0.00');
  });
});

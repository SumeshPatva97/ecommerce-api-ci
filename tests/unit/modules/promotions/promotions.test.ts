/**
 * Promotion rules (pure) and the pricing input loader. The loader runs against the MOCKED DB
 * (tests/helpers/mockDb.ts) — the tests assert the query shapes and the snapshot mapping only.
 */
import { describe, expect, it } from 'vitest';

import { Decimal } from '../../../../src/lib/money.js';
import { createPricingInputLoader } from '../../../../src/modules/promotions/index.js';
import { toPromotionSnapshot } from '../../../../src/modules/promotions/pricing.loader.js';
import {
  canDelete,
  canPause,
  effectiveStatus,
  promotionRuleIssues,
  scheduleStatus,
} from '../../../../src/modules/promotions/promotions.rules.js';
import { createMockDb } from '../../../helpers/mockDb.js';

const NOW = new Date('2026-11-19T06:30:00.000Z');
const PAST = new Date('2026-11-01T00:00:00.000Z');
const FUTURE = new Date('2026-12-01T00:00:00.000Z');

describe('promotion rules', () => {
  const base = {
    scope: 'CATEGORY' as const,
    discountType: 'PERCENTAGE' as const,
    discountValue: '10',
  };

  it('validates values, caps, window and includeDescendants', () => {
    expect(promotionRuleIssues(base)).toEqual([]);
    expect(promotionRuleIssues({ ...base, discountValue: '101' })[0]?.field).toBe('discountValue');
    expect(
      promotionRuleIssues({ ...base, discountType: 'FIXED_AMOUNT', discountValue: '0' })[0]
        ?.message,
    ).toBe('Must be greater than 0.');
    expect(
      promotionRuleIssues({
        ...base,
        discountType: 'FIXED_AMOUNT',
        discountValue: '5',
        maxDiscountAmount: '1',
      })[0]?.field,
    ).toBe('maxDiscountAmount');
    expect(promotionRuleIssues({ ...base, maxDiscountAmount: '0' })[0]?.message).toBe(
      'Must be greater than 0.',
    );
    expect(promotionRuleIssues({ ...base, startsAt: FUTURE, endsAt: PAST })[0]?.field).toBe(
      'endsAt',
    );
    expect(
      promotionRuleIssues({ ...base, scope: 'BRAND', includeDescendants: true })[0]?.field,
    ).toBe('includeDescendants');
    expect(promotionRuleIssues({ ...base, includeDescendants: false })).toEqual([]);
  });

  it('derives schedule / effective status and transitions', () => {
    expect(scheduleStatus(PAST, FUTURE, NOW)).toBe('ACTIVE');
    expect(scheduleStatus(FUTURE, null, NOW)).toBe('SCHEDULED');
    expect(scheduleStatus(null, PAST, NOW)).toBe('EXPIRED');
    expect(scheduleStatus(null, null, NOW)).toBe('ACTIVE');
    expect(effectiveStatus({ status: 'SCHEDULED', startsAt: PAST, endsAt: FUTURE }, NOW)).toBe(
      'ACTIVE',
    );
    expect(effectiveStatus({ status: 'ACTIVE', startsAt: PAST, endsAt: PAST }, NOW)).toBe(
      'EXPIRED',
    );
    expect(effectiveStatus({ status: 'PAUSED', startsAt: PAST, endsAt: FUTURE }, NOW)).toBe(
      'PAUSED',
    );
    expect(canPause('ACTIVE')).toBe(true);
    expect(canPause('SCHEDULED')).toBe(true);
    expect(canPause('DRAFT')).toBe(false);
    expect(canDelete('DRAFT', 0)).toBe(true);
    expect(canDelete('EXPIRED', 0)).toBe(true);
    expect(canDelete('EXPIRED', 2)).toBe(false);
    expect(canDelete('ACTIVE', 0)).toBe(false);
  });
});

describe('pricing input loader', () => {
  const promoRow = (scope: string) => ({
    id: `p-${scope}`,
    name: scope,
    scope,
    discountType: 'PERCENTAGE',
    discountValue: new Decimal(10),
    maxDiscountAmount: null,
    startsAt: null,
    endsAt: null,
    status: 'ACTIVE',
    deletedAt: null,
    priority: 1,
    createdAt: PAST,
    products: [{ productId: 'prod' }],
    categories: [{ categoryId: 'cat', includeDescendants: false }],
    brands: [{ brandId: 'brand' }],
    collections: [{ collectionId: 'col' }],
  });

  it('maps every promotion scope to its targets', () => {
    expect(toPromotionSnapshot(promoRow('PRODUCT') as never).targets).toEqual([{ id: 'prod' }]);
    expect(toPromotionSnapshot(promoRow('CATEGORY') as never).targets).toEqual([
      { id: 'cat', includeDescendants: false },
    ]);
    expect(toPromotionSnapshot(promoRow('BRAND') as never).targets).toEqual([{ id: 'brand' }]);
    expect(toPromotionSnapshot(promoRow('COLLECTION') as never).targets).toEqual([{ id: 'col' }]);
  });

  it('loads product contexts with the category path, promotions, coupon and customer context', async () => {
    const { db, m } = createMockDb();
    m.product.findMany.mockResolvedValue([
      { id: 'prod', categoryId: 'leaf', brandId: 'brand', collections: [{ collectionId: 'col' }] },
    ]);
    m.category.findMany
      .mockResolvedValueOnce([{ id: 'leaf', parentId: 'mid' }])
      .mockResolvedValueOnce([{ id: 'mid', parentId: 'root' }])
      .mockResolvedValueOnce([{ id: 'root', parentId: null }]);
    m.promotion.findMany.mockResolvedValue([promoRow('BRAND')]);
    m.coupon.findUnique.mockResolvedValue({
      id: 'cp',
      code: 'X10',
      description: null,
      status: 'ACTIVE',
      deletedAt: null,
      discountType: 'FIXED_AMOUNT',
      discountValue: new Decimal(100),
      maxDiscountAmount: null,
      minOrderValue: null,
      startsAt: null,
      expiresAt: null,
      usageLimitEnabled: false,
      usageLimit: null,
      usedCount: 0,
      perCustomerLimit: null,
      isFirstOrderOnly: true,
      isCombinableWithPromotions: false,
      applicabilities: [
        {
          ruleType: 'EXCLUDE',
          targetType: 'BRAND',
          productId: null,
          categoryId: null,
          brandId: 'b',
          collectionId: null,
        },
        {
          ruleType: 'INCLUDE',
          targetType: 'PRODUCT',
          productId: null,
          categoryId: null,
          brandId: null,
          collectionId: null,
        },
      ],
    });
    m.couponUsage.count.mockResolvedValue(2);
    m.order.count.mockResolvedValue(1);
    const loader = createPricingInputLoader();
    const input = await loader.load(db, {
      items: [
        {
          lineId: 'l1',
          variantId: 'v',
          productId: 'prod',
          quantity: 1,
          mrp: new Decimal(10),
          sellingPrice: new Decimal(9),
        },
        {
          lineId: 'l2',
          variantId: 'v2',
          productId: 'gone',
          quantity: 1,
          mrp: new Decimal(10),
          sellingPrice: new Decimal(9),
        },
      ],
      userId: 'user',
      coupon: { codeNormalized: 'X10' },
      now: NOW,
    });
    expect(input.lines).toHaveLength(1);
    expect(input.lines[0]).toMatchObject({
      categoryId: 'leaf',
      categoryPath: ['leaf', 'mid', 'root'],
      brandId: 'brand',
      collectionIds: ['col'],
    });
    expect(input.promotions[0]?.targets).toEqual([{ id: 'brand' }]);
    expect(input.coupon?.rules).toEqual([
      { ruleType: 'EXCLUDE', targetType: 'BRAND', targetId: 'b' },
    ]);
    expect(input.customer).toEqual({ couponUsesByCustomer: 2, isFirstOrder: false });
    expect(input.couponMissing).toBe(false);
    const where = m.promotion.findMany.mock.calls[0]?.[0].where;
    expect(where.status).toEqual({ in: ['SCHEDULED', 'ACTIVE'] });
    expect(JSON.stringify(where)).toContain('"root"');
  });

  it('short-circuits empty inputs and reports a missing coupon', async () => {
    const { db, m } = createMockDb();
    m.coupon.findUnique.mockResolvedValue(null);
    const loader = createPricingInputLoader();
    const input = await loader.load(db, {
      items: [],
      userId: 'u',
      coupon: { id: 'gone' },
      now: NOW,
    });
    expect(input).toMatchObject({ lines: [], promotions: [], coupon: null, couponMissing: true });
    expect(m.product.findMany).not.toHaveBeenCalled();
    expect(m.promotion.findMany).not.toHaveBeenCalled();
    const none = await loader.load(db, { items: [], userId: 'u', now: NOW });
    expect(none.couponMissing).toBe(false);
  });
});

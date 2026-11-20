/**
 * Pure cart rules — line evaluation, availability, merge rule (R-04) and error shapes. No DB.
 */
import { describe, expect, it } from 'vitest';

import { Decimal } from '../../../../src/lib/money.js';
import {
  availability,
  availableQuantity,
  evaluateLine,
  insufficientStockError,
  itemLabel,
  mergedQuantity,
} from '../../../../src/modules/cart/cart.rules.js';
import { couponInvalidError } from '../../../../src/modules/coupons/index.js';

const NOW = new Date('2026-11-19T06:30:00.000Z');

function line(over: Record<string, unknown> = {}, product: Record<string, unknown> = {}) {
  return {
    quantity: 2,
    unitPriceAtAdd: new Decimal('100.00'),
    variant: {
      status: 'ACTIVE',
      deletedAt: null as Date | null,
      sellingPrice: new Decimal('100.00'),
      inventory: { quantityOnHand: 10, quantityReserved: 0, lowStockThreshold: null },
      product: {
        status: 'ACTIVE',
        deletedAt: null as Date | null,
        publishedAt: new Date('2026-01-01T00:00:00.000Z') as Date | null,
        ...product,
      },
      ...over,
    },
  };
}

describe('cart rules', () => {
  it('computes availability with the per-line cap and low-stock threshold', () => {
    expect(availableQuantity(null)).toBe(0);
    expect(availableQuantity({ quantityOnHand: 1, quantityReserved: 3 })).toBe(0);
    expect(availability(null, 5)).toEqual({ status: 'OUT_OF_STOCK', maxPurchasable: 0 });
    expect(availability({ quantityOnHand: 40, quantityReserved: 0 }, 5)).toEqual({
      status: 'IN_STOCK',
      maxPurchasable: 5,
    });
    expect(
      availability({ quantityOnHand: 8, quantityReserved: 0, lowStockThreshold: 10 }, 5).status,
    ).toBe('LOW_STOCK');
  });

  it('evaluates lines', () => {
    expect(evaluateLine(line(), NOW, 5)).toEqual({ purchasable: true, quantity: 2, issues: [] });
    expect(evaluateLine(line({}, { publishedAt: null }), NOW, 5).issues).toEqual([
      { code: 'PRODUCT_UNAVAILABLE' },
    ]);
    expect(
      evaluateLine(line({}, { publishedAt: new Date('2027-01-01T00:00:00Z') }), NOW, 5).purchasable,
    ).toBe(false);
    expect(evaluateLine(line({}, { deletedAt: NOW }), NOW, 5).purchasable).toBe(false);
    expect(evaluateLine(line({ deletedAt: NOW }), NOW, 5).issues).toEqual([
      { code: 'VARIANT_UNAVAILABLE' },
    ]);
    expect(evaluateLine(line({ inventory: null }), NOW, 5).issues).toEqual([
      { code: 'OUT_OF_STOCK' },
    ]);
    const capped = evaluateLine({ ...line(), quantity: 9 }, NOW, 5);
    expect(capped).toEqual({
      purchasable: true,
      quantity: 5,
      issues: [{ code: 'QUANTITY_REDUCED', meta: { requested: 9, applied: 5 } }],
    });
  });

  it('applies the R-04 merge rule', () => {
    expect(mergedQuantity(1, 3, 5, 10)).toEqual({ wanted: 3, applied: 3 });
    expect(mergedQuantity(4, 2, 5, 10)).toEqual({ wanted: 4, applied: 4 });
    expect(mergedQuantity(0, 9, 5, 10)).toEqual({ wanted: 9, applied: 5 });
    expect(mergedQuantity(0, 3, 5, 0)).toEqual({ wanted: 3, applied: 0 });
  });

  it('builds error shapes', () => {
    expect(itemLabel('Ring', 'Ring')).toBe('Ring');
    expect(itemLabel('Ring', '')).toBe('Ring');
    expect(itemLabel('Ring', 'Size 7')).toBe('Ring (Size 7)');
    const one = insufficientStockError({
      variantId: 'v',
      sku: 'S',
      label: 'Ring',
      requested: 2,
      inCart: 0,
      available: 1,
    });
    expect(one.message).toBe('Only 1 unit of Ring is available.');
    const none = insufficientStockError({
      variantId: 'v',
      sku: 'S',
      label: 'Ring',
      requested: 2,
      inCart: 1,
      available: 0,
    });
    expect(none.message).toBe('Ring is out of stock.');
    expect(none.details?.[0]?.message).toBe('Requested 2, available 0.');
    const inactive = couponInvalidError({ reason: 'COUPON_INACTIVE' });
    expect(inactive.httpStatus).toBe(422);
    expect(inactive.details).toEqual([
      { field: 'code', code: 'COUPON_INACTIVE', message: 'The coupon is not active.' },
    ]);
  });
});

/**
 * Checkout pure parts (unit, no DB): quote hash determinism, request schemas, PRICE_CHANGED shape.
 * The §3.9 numbers are covered end to end in tests/integration/modules/checkout (MOCKED DB).
 */
import { describe, expect, it } from 'vitest';

import { Prisma } from '../../../../src/generated/prisma/client.js';
import {
  CheckoutSummaryBody,
  PlaceOrderBody,
  priceChangedError,
  quoteHashOf,
  type ComputedQuote,
} from '../../../../src/modules/checkout/index.js';

const ADDR = '33333333-3333-4333-8333-333333333301';
const METHOD = '44444444-4444-4444-8444-444444444401';

describe('quoteHashOf', () => {
  it('is deterministic and independent of key order', () => {
    const a = quoteHashOf({ b: 1, a: { y: '2.00', x: [1, 2] } });
    const b = quoteHashOf({ a: { x: [1, 2], y: '2.00' }, b: 1 });
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(quoteHashOf({ b: 2 })).not.toBe(quoteHashOf({ b: 1 }));
  });
});

describe('checkout schemas', () => {
  it('accepts the summary body and rejects unknown keys and client amounts', () => {
    expect(
      CheckoutSummaryBody.safeParse({ shippingAddressId: ADDR, paymentMethod: 'ONLINE' }).success,
    ).toBe(true);
    expect(
      CheckoutSummaryBody.safeParse({
        shippingAddressId: ADDR,
        paymentMethod: 'ONLINE',
        grandTotal: '1.00',
      }).success,
    ).toBe(false);
    expect(
      CheckoutSummaryBody.safeParse({ shippingAddressId: ADDR, paymentMethod: 'UPI' }).success,
    ).toBe(false);
  });

  it('requires quoteHash, shippingMethodId and acceptTerms=true; strips markup from the note', () => {
    const base = {
      shippingAddressId: ADDR,
      shippingMethodId: METHOD,
      paymentMethod: 'ONLINE',
      quoteHash: `sha256:${'c'.repeat(64)}`,
      acceptTerms: true,
    };
    const parsed = PlaceOrderBody.parse({
      ...base,
      customerNote: '  <script>x</script>Leave at door ',
    });
    expect(parsed.customerNote).toBe('xLeave at door');
    expect(PlaceOrderBody.safeParse({ ...base, acceptTerms: false }).success).toBe(false);
    expect(PlaceOrderBody.safeParse({ ...base, quoteHash: 'abc' }).success).toBe(false);
    expect(PlaceOrderBody.safeParse({ ...base, shippingMethodId: undefined }).success).toBe(false);
    expect(PlaceOrderBody.safeParse({ ...base, buyerGstin: 'NOT-A-GSTIN' }).success).toBe(false);
    expect(PlaceOrderBody.safeParse({ ...base, customerNote: 'x'.repeat(501) }).success).toBe(
      false,
    );
  });
});

describe('priceChangedError', () => {
  const current = {
    lines: [
      { item: { variantId: 'v1' }, priced: { unitPrice: new Prisma.Decimal('1549') } },
      { item: { variantId: 'v2' }, priced: { unitPrice: new Prisma.Decimal('999') } },
    ],
    tax: { totals: { grandTotal: new Prisma.Decimal('3596') } },
  } as unknown as ComputedQuote;

  it('lists changed unit prices per line', () => {
    const err = priceChangedError(
      {
        lines: [
          { variantId: 'v1', unitPrice: '1499.00' },
          { variantId: 'v2', unitPrice: '999.00' },
        ],
        grandTotal: '3496.00',
      },
      current,
    );
    expect(err.code).toBe('PRICE_CHANGED');
    expect(err.httpStatus).toBe(409);
    expect(err.details).toEqual([
      expect.objectContaining({
        field: 'lines[0].unitPrice',
        meta: { variantId: 'v1', old: '1499.00', new: '1549.00' },
      }),
    ]);
  });

  it('falls back to the totals when the previous quote is unknown', () => {
    const err = priceChangedError(undefined, current);
    expect(err.details).toEqual([
      expect.objectContaining({ field: 'quoteHash', meta: { newGrandTotal: '3596.00' } }),
    ]);
  });
});

/**
 * Cart routes through the real Express app — API_DOCUMENTATION.md §3.4.
 * MOCKED DB (tests/helpers/mockDb.ts): verifies the HTTP contract, ownership scoping, pricing
 * wiring (engine + loader + tax estimate) and error shapes; no SQL is executed.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { Decimal } from '../../../../src/lib/money.js';
import { createCartModule } from '../../../../src/modules/cart/index.js';
import { buildModuleTestApp } from '../../../helpers/container.js';
import { IDS, couponRow, jhumka, primeCart, promotionRow, ring, variantCheck } from './fixtures.js';

function setup() {
  const t = buildModuleTestApp([createCartModule]);
  const customer = t.customer();
  return { t, customer, auth: customer.headers };
}

describe('GET /cart', () => {
  it('requires a customer token (401) and refuses a staff token', async () => {
    const { t } = setup();
    expect((await request(t.app).get('/api/v1/cart')).status).toBe(401);
    const staff = t.staff({ isSuperadmin: true });
    const res = await request(t.app).get('/api/v1/cart').set(staff.headers);
    expect([401, 403]).toContain(res.status);
    expect(t.m.cart.findFirst).not.toHaveBeenCalled();
  });

  it('creates an empty cart when the customer has none', async () => {
    const { t, auth } = setup();
    primeCart(t);
    t.m.cart.findFirst.mockResolvedValue(null);
    const res = await request(t.app).get('/api/v1/cart').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: IDS.cart,
      items: [],
      coupon: null,
      itemCount: 0,
      totals: { subtotal: '0.00', estimatedTotal: '0.00', shippingCharge: null },
    });
    expect(t.m.cart.create).toHaveBeenCalledTimes(1);
  });

  it('re-prices the documented WELCOME10 example (promotion + capped coupon + tax estimate)', async () => {
    const { t, customer, auth } = setup();
    primeCart(t, {
      userId: customer.ctx.userId,
      items: [jhumka(), ring()],
      couponId: IDS.coupon,
      couponCode: 'WELCOME10',
      promotions: [promotionRow()],
      coupon: couponRow(),
    });
    const res = await request(t.app).get('/api/v1/cart').set(auth);
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.items[0]).toMatchObject({
      id: IDS.itemJhumka,
      productName: 'Meera Kundan Jhumka',
      variantName: 'Gold / Small',
      quantity: 2,
      mrp: '1799.00',
      unitPrice: '1499.00',
      lineBase: '2998.00',
      promotion: { id: IDS.promo, label: 'Festive 10% off', discount: '299.80' },
      couponDiscount: '218.94',
      lineNet: '2479.26',
      availability: { status: 'IN_STOCK', maxPurchasable: 5 },
      issues: [],
    });
    expect(data.items[0].image.thumbUrl).toContain('w_160');
    expect(data.items[1]).toMatchObject({
      promotion: null,
      couponDiscount: '81.06',
      lineNet: '917.94',
    });
    expect(data.coupon).toEqual({
      code: 'WELCOME10',
      discount: '300.00',
      description: '10% off up to ₹300',
    });
    expect(data.totals).toEqual({
      subtotal: '3997.00',
      itemDiscountTotal: '299.80',
      couponDiscountTotal: '300.00',
      shippingCharge: null,
      estimatedTaxIncluded: '98.95',
      estimatedTotal: '3397.20',
      pricesIncludeTax: true,
    });
    expect(data.itemCount).toBe(3);
    expect(data.warnings).toEqual([]);
    // the cart query is scoped to the caller
    expect(t.m.cart.findFirst.mock.calls[0]?.[0].where).toEqual({
      userId: customer.ctx.userId,
      status: 'ACTIVE',
    });
  });

  it('flags stale lines: reduces quantity, marks out-of-stock / unavailable / price change', async () => {
    const { t, auth } = setup();
    primeCart(t, {
      items: [
        jhumka({ quantity: 4, onHand: 3, unitPriceAtAdd: '1399.00' }),
        ring({ onHand: 2, reserved: 2 }),
        ring({ id: IDS.vOther, variantId: IDS.vOther, productStatus: 'ARCHIVED' }),
        ring({ id: IDS.cart, variantId: IDS.cart, variantStatus: 'INACTIVE' }),
      ],
    });
    const res = await request(t.app).get('/api/v1/cart').set(auth);
    expect(res.status).toBe(200);
    const [a, b, c, d] = res.body.data.items;
    expect(a.quantity).toBe(3);
    expect(a.availability).toEqual({ status: 'LOW_STOCK', maxPurchasable: 3 });
    expect(a.issues).toEqual([
      { code: 'QUANTITY_REDUCED', meta: { requested: 4, applied: 3 } },
      { code: 'PRICE_CHANGED', meta: { old: '1399.00', new: '1499.00' } },
    ]);
    expect(b.issues).toEqual([{ code: 'OUT_OF_STOCK' }]);
    expect(c.issues).toEqual([{ code: 'PRODUCT_UNAVAILABLE' }]);
    expect(d.issues).toEqual([{ code: 'VARIANT_UNAVAILABLE' }]);
    expect(t.m.cartItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: IDS.itemJhumka }, data: { quantity: 3 } }),
    );
    // only the purchasable line is in the totals
    expect(res.body.data.totals.subtotal).toBe('4497.00');
  });

  it('detaches a coupon that no longer applies and warns (no `reason` key)', async () => {
    const { t, auth } = setup();
    primeCart(t, {
      items: [ring()],
      couponId: IDS.coupon,
      couponCode: 'WELCOME10',
      coupon: couponRow({ expiresAt: new Date('2026-11-18T00:00:00.000Z') }),
    });
    const res = await request(t.app).get('/api/v1/cart').set(auth);
    expect(res.body.data.coupon).toBeNull();
    expect(res.body.data.warnings).toEqual([
      { code: 'COUPON_REMOVED', meta: { couponCode: 'WELCOME10', causeCode: 'COUPON_EXPIRED' } },
    ]);
    expect(t.m.cart.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { couponId: null, couponCode: null } }),
    );
  });

  it('reports a partial tax estimate when a rate cannot be resolved', async () => {
    const { t, auth } = setup();
    primeCart(t, { items: [ring()], ratePercent: null });
    const res = await request(t.app).get('/api/v1/cart').set(auth);
    expect(res.body.data.totals.estimatedTaxIncluded).toBe('0.00');
    expect(res.body.data.warnings).toEqual([
      { code: 'TAX_ESTIMATE_PARTIAL', meta: { productIds: [IDS.pRing] } },
    ]);
  });
});

describe('POST /cart/items', () => {
  it('adds a new line at the current price (201)', async () => {
    const { t, auth } = setup();
    primeCart(t);
    t.m.productVariant.findUnique.mockResolvedValue(variantCheck());
    t.m.cartItem.findUnique.mockResolvedValue(null);
    t.m.cartItem.count.mockResolvedValue(0);
    const res = await request(t.app)
      .post('/api/v1/cart/items')
      .set(auth)
      .send({ variantId: IDS.vOther, quantity: 2 });
    expect(res.status).toBe(201);
    const data = t.m.cartItem.create.mock.calls[0]?.[0].data;
    expect(data).toMatchObject({ cartId: IDS.cart, variantId: IDS.vOther, quantity: 2 });
    expect(String(data.unitPriceAtAdd)).toBe('1499');
  });

  it('adds to an existing line', async () => {
    const { t, auth } = setup();
    primeCart(t);
    t.m.productVariant.findUnique.mockResolvedValue(variantCheck());
    t.m.cartItem.findUnique.mockResolvedValue({ id: IDS.itemJhumka, quantity: 2 });
    await request(t.app)
      .post('/api/v1/cart/items')
      .set(auth)
      .send({ variantId: IDS.vOther, quantity: 1 })
      .expect(201);
    expect(t.m.cartItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: IDS.itemJhumka }, data: { quantity: 3 } }),
    );
  });

  it('enforces the per-line cap from settings (422 MAX_QTY_PER_LINE)', async () => {
    const { t, auth } = setup();
    primeCart(t);
    t.m.setting.findUnique.mockResolvedValue({ value: 3 });
    t.m.productVariant.findUnique.mockResolvedValue(variantCheck());
    t.m.cartItem.findUnique.mockResolvedValue({ id: IDS.itemJhumka, quantity: 2 });
    const res = await request(t.app)
      .post('/api/v1/cart/items')
      .set(auth)
      .send({ variantId: IDS.vOther, quantity: 2 });
    expect(res.status).toBe(422);
    expect(res.body.error.details[0]).toMatchObject({
      field: 'quantity',
      code: 'MAX_QTY_PER_LINE',
      meta: { max: 3, inCart: 2 },
    });
  });

  it('returns 409 INSUFFICIENT_STOCK with the documented detail', async () => {
    const { t, auth } = setup();
    primeCart(t);
    t.m.productVariant.findUnique.mockResolvedValue(
      variantCheck({ inventory: { quantityOnHand: 3, quantityReserved: 1 } }),
    );
    t.m.cartItem.findUnique.mockResolvedValue(null);
    t.m.cartItem.count.mockResolvedValue(0);
    const res = await request(t.app)
      .post('/api/v1/cart/items')
      .set(auth)
      .send({ variantId: IDS.vOther, quantity: 3 });
    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({
      code: 'INSUFFICIENT_STOCK',
      message: 'Only 2 units of Meera Kundan Jhumka (Gold / Medium) are available.',
      details: [
        {
          field: 'quantity',
          code: 'INSUFFICIENT_STOCK',
          message: 'Requested 3, available 2.',
          meta: {
            variantId: IDS.vOther,
            sku: 'EAR-MEERA-GLD-M',
            requested: 3,
            inCart: 0,
            available: 2,
          },
        },
      ],
    });
    expect(t.m.cartItem.create).not.toHaveBeenCalled();
  });

  it('returns 404 for an inactive variant or unpublished product', async () => {
    const { t, auth } = setup();
    primeCart(t);
    t.m.productVariant.findUnique.mockResolvedValue(variantCheck({ status: 'INACTIVE' }));
    const res = await request(t.app)
      .post('/api/v1/cart/items')
      .set(auth)
      .send({ variantId: IDS.vOther, quantity: 1 });
    expect(res.status).toBe(404);
    t.m.productVariant.findUnique.mockResolvedValue(null);
    expect(
      (
        await request(t.app)
          .post('/api/v1/cart/items')
          .set(auth)
          .send({ variantId: IDS.vOther, quantity: 1 })
      ).status,
    ).toBe(404);
  });

  it('rejects the 51st distinct line (422 CART_LINE_LIMIT)', async () => {
    const { t, auth } = setup();
    primeCart(t);
    t.m.productVariant.findUnique.mockResolvedValue(variantCheck());
    t.m.cartItem.findUnique.mockResolvedValue(null);
    t.m.cartItem.count.mockResolvedValue(50);
    const res = await request(t.app)
      .post('/api/v1/cart/items')
      .set(auth)
      .send({ variantId: IDS.vOther, quantity: 1 });
    expect(res.status).toBe(422);
    expect(res.body.error.details[0].code).toBe('CART_LINE_LIMIT');
  });

  it('rejects unknown keys (no userId accepted) and quantity 0', async () => {
    const { t, auth } = setup();
    const res = await request(t.app)
      .post('/api/v1/cart/items')
      .set(auth)
      .send({ variantId: IDS.vOther, quantity: 0, userId: IDS.cart });
    expect(res.status).toBe(422);
    const fields = (res.body.error.details as { field?: string }[]).map((d) => d.field);
    expect(fields).toContain('quantity');
  });
});

describe('PATCH / DELETE /cart/items/:itemId (ownership)', () => {
  it("returns 404 for another customer's item (IDOR) and scopes the lookup to the caller", async () => {
    const { t, customer, auth } = setup();
    primeCart(t);
    t.m.cartItem.findFirst.mockResolvedValue(null);
    const patch = await request(t.app)
      .patch(`/api/v1/cart/items/${IDS.itemJhumka}`)
      .set(auth)
      .send({ quantity: 1 });
    expect(patch.status).toBe(404);
    const del = await request(t.app).delete(`/api/v1/cart/items/${IDS.itemJhumka}`).set(auth);
    expect(del.status).toBe(404);
    expect(t.m.cartItem.findFirst.mock.calls[0]?.[0].where).toEqual({
      id: IDS.itemJhumka,
      cart: { userId: customer.ctx.userId, status: 'ACTIVE' },
    });
    expect(t.m.cartItem.update).not.toHaveBeenCalled();
    expect(t.m.cartItem.delete).not.toHaveBeenCalled();
  });

  it('updates the quantity of an owned line, with stock checks', async () => {
    const { t, auth } = setup();
    primeCart(t);
    t.m.cartItem.findFirst.mockResolvedValue({
      id: IDS.itemJhumka,
      cartId: IDS.cart,
      variantId: IDS.vOther,
      quantity: 1,
    });
    t.m.productVariant.findUnique.mockResolvedValue(variantCheck());
    await request(t.app)
      .patch(`/api/v1/cart/items/${IDS.itemJhumka}`)
      .set(auth)
      .send({ quantity: 4 })
      .expect(200);
    expect(t.m.cartItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { quantity: 4 } }),
    );
    t.m.productVariant.findUnique.mockResolvedValue(variantCheck({ deletedAt: new Date() }));
    const gone = await request(t.app)
      .patch(`/api/v1/cart/items/${IDS.itemJhumka}`)
      .set(auth)
      .send({ quantity: 1 });
    expect(gone.status).toBe(409);
    expect(gone.body.error.message).toContain('out of stock');
  });

  it('removes a line and auto-removes a coupon that no longer applies', async () => {
    const { t, auth } = setup();
    primeCart(t, {
      items: [],
      couponId: IDS.coupon,
      couponCode: 'WELCOME10',
      coupon: couponRow(),
    });
    t.m.cartItem.findFirst.mockResolvedValue({
      id: IDS.itemRing,
      cartId: IDS.cart,
      variantId: IDS.vRing,
      quantity: 1,
    });
    const res = await request(t.app).delete(`/api/v1/cart/items/${IDS.itemRing}`).set(auth);
    expect(res.status).toBe(200);
    expect(t.m.cartItem.delete).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: IDS.itemRing } }),
    );
    expect(res.body.data.warnings).toEqual([
      {
        code: 'COUPON_REMOVED',
        meta: { couponCode: 'WELCOME10', causeCode: 'COUPON_NOT_APPLICABLE' },
      },
    ]);
  });
});

describe('POST /cart/merge (R-04)', () => {
  it('takes the larger quantity, caps it and reports reductions and skips', async () => {
    const { t, auth } = setup();
    primeCart(t);
    t.m.productVariant.findMany.mockResolvedValue([
      variantCheck({ id: IDS.vJhumka, inventory: { quantityOnHand: 2, quantityReserved: 0 } }),
      variantCheck({ id: IDS.vRing }),
      variantCheck({ id: IDS.vOther, status: 'INACTIVE' }),
    ]);
    t.m.cartItem.findMany.mockResolvedValue([
      { id: IDS.itemRing, variantId: IDS.vRing, quantity: 3 },
    ]);
    const res = await request(t.app)
      .post('/api/v1/cart/merge')
      .set(auth)
      .send({
        items: [
          { variantId: IDS.vJhumka, quantity: 4 },
          { variantId: IDS.vRing, quantity: 1 },
          { variantId: IDS.vOther, quantity: 1 },
          { variantId: IDS.itemJhumka, quantity: 1 },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.data.warnings).toEqual([
      { code: 'QUANTITY_REDUCED', meta: { variantId: IDS.vJhumka, requested: 4, applied: 2 } },
      { code: 'ITEM_SKIPPED', meta: { variantId: IDS.vOther, causeCode: 'VARIANT_UNAVAILABLE' } },
      {
        code: 'ITEM_SKIPPED',
        meta: { variantId: IDS.itemJhumka, causeCode: 'VARIANT_UNAVAILABLE' },
      },
    ]);
    expect(t.m.cartItem.create).toHaveBeenCalledTimes(1);
    expect(t.m.cartItem.create.mock.calls[0]?.[0].data).toMatchObject({
      variantId: IDS.vJhumka,
      quantity: 2,
    });
    // server qty 3 > guest 1 → unchanged
    expect(t.m.cartItem.update).not.toHaveBeenCalled();
  });

  it('skips out-of-stock variants and rejects more than 50 items', async () => {
    const { t, auth } = setup();
    primeCart(t);
    t.m.productVariant.findMany.mockResolvedValue([
      variantCheck({ id: IDS.vJhumka, inventory: { quantityOnHand: 0, quantityReserved: 0 } }),
    ]);
    t.m.cartItem.findMany.mockResolvedValue([]);
    const res = await request(t.app)
      .post('/api/v1/cart/merge')
      .set(auth)
      .send({ items: [{ variantId: IDS.vJhumka, quantity: 1 }] });
    expect(res.body.data.warnings).toEqual([
      { code: 'ITEM_SKIPPED', meta: { variantId: IDS.vJhumka, causeCode: 'OUT_OF_STOCK' } },
    ]);
    const tooMany = Array.from({ length: 51 }, () => ({ variantId: IDS.vJhumka, quantity: 1 }));
    expect(
      (await request(t.app).post('/api/v1/cart/merge').set(auth).send({ items: tooMany })).status,
    ).toBe(422);
  });

  it('skips new lines beyond the 50-line limit', async () => {
    const { t, auth } = setup();
    primeCart(t);
    t.m.productVariant.findMany.mockResolvedValue([variantCheck({ id: IDS.vJhumka })]);
    t.m.cartItem.findMany.mockResolvedValue(
      Array.from({ length: 50 }, (_, i) => ({ id: `i${i}`, variantId: `v${i}`, quantity: 1 })),
    );
    const res = await request(t.app)
      .post('/api/v1/cart/merge')
      .set(auth)
      .send({ items: [{ variantId: IDS.vJhumka, quantity: 1 }] });
    expect(res.body.data.warnings[0].meta.causeCode).toBe('CART_LINE_LIMIT');
  });
});

describe('POST/DELETE /cart/coupon', () => {
  it('normalizes the code and applies a valid coupon', async () => {
    const { t, auth } = setup();
    primeCart(t, { items: [ring()], coupon: couponRow() });
    const res = await request(t.app)
      .post('/api/v1/cart/coupon')
      .set(auth)
      .send({ code: ' welcome10 ' });
    expect(res.status).toBe(200);
    expect(t.m.coupon.findUnique.mock.calls[0]?.[0].where).toEqual({ codeNormalized: 'WELCOME10' });
    expect(t.m.cart.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: IDS.cart },
        data: expect.objectContaining({ couponId: IDS.coupon, couponCode: 'WELCOME10' }),
      }),
    );
  });

  it('returns 422 COUPON_INVALID with one reason per response', async () => {
    const { t, auth } = setup();
    primeCart(t, { items: [ring()] });
    const unknown = await request(t.app)
      .post('/api/v1/cart/coupon')
      .set(auth)
      .send({ code: 'NOPE10' });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error).toMatchObject({
      code: 'COUPON_INVALID',
      message: 'This coupon code is not valid.',
      details: [{ field: 'code', code: 'COUPON_NOT_FOUND' }],
    });

    t.m.coupon.findUnique.mockResolvedValue(
      couponRow({ expiresAt: new Date('2026-10-31T18:29:59.999Z') }),
    );
    const expired = await request(t.app)
      .post('/api/v1/cart/coupon')
      .set(auth)
      .send({ code: 'WELCOME10' });
    expect(expired.body.error).toEqual({
      code: 'COUPON_INVALID',
      message: 'This coupon has expired.',
      details: [
        {
          field: 'code',
          code: 'COUPON_EXPIRED',
          message: 'Expired on 31 Oct 2026.',
          meta: { expiresAt: '2026-10-31T18:29:59.999Z' },
        },
      ],
    });

    t.m.coupon.findUnique.mockResolvedValue(couponRow({ minOrderValue: new Decimal('2000.00') }));
    const min = await request(t.app)
      .post('/api/v1/cart/coupon')
      .set(auth)
      .send({ code: 'WELCOME10' });
    expect(min.body.error.details[0]).toMatchObject({
      code: 'COUPON_MIN_ORDER_NOT_MET',
      meta: { minOrderValue: '2000.00', eligibleSubtotal: '999.00', shortfall: '1001.00' },
    });
    expect(min.body.error.message).toBe('Add items worth ₹1001.00 more to use this coupon.');
    expect(t.m.cart.update).not.toHaveBeenCalled();
  });

  it('rejects malformed codes with 422 VALIDATION_ERROR', async () => {
    const { t, auth } = setup();
    const res = await request(t.app)
      .post('/api/v1/cart/coupon')
      .set(auth)
      .send({ code: 'SAVE 10' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('removes the coupon (idempotent)', async () => {
    const { t, auth } = setup();
    primeCart(t, { items: [ring()] });
    const res = await request(t.app).delete('/api/v1/cart/coupon').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.data.coupon).toBeNull();
    expect(t.m.cart.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { couponId: null, couponCode: null } }),
    );
  });
});

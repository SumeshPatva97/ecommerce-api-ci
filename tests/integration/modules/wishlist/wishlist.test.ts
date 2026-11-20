/**
 * Wishlist routes through the real Express app — API_DOCUMENTATION.md §3.5.
 * MOCKED DB (tests/helpers/mockDb.ts): ownership scoping (IDOR → 404), limits, duplicates and
 * move-to-cart wiring; no SQL is executed.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { Decimal } from '../../../../src/lib/money.js';
import { createWishlistModule } from '../../../../src/modules/wishlist/index.js';
import { buildModuleTestApp } from '../../../helpers/container.js';
import { primeCart, variantCheck } from '../cart/fixtures.js';

const WISHLIST = '9e8d7c6b-5a49-4a38-8b27-000000000001';
const ITEM = '9e8d7c6b-5a49-4a38-8b27-000000000002';
const PRODUCT = '9e8d7c6b-5a49-4a38-8b27-000000000003';
const VARIANT = '9e8d7c6b-5a49-4a38-8b27-000000000004';

function productCard(over: Record<string, unknown> = {}) {
  return {
    id: PRODUCT,
    slug: 'tara-silver-ring',
    name: 'Tara Silver Ring',
    productType: 'VARIABLE',
    isNewArrival: false,
    isBestSellerPinned: false,
    publishedAt: new Date('2026-10-01T00:00:00.000Z'),
    avgRating: new Decimal('4.50'),
    reviewCount: 3,
    totalSold: 10,
    status: 'ACTIVE',
    deletedAt: null,
    brand: null,
    category: { id: 'cat', name: 'Rings', slug: 'rings' },
    images: [{ cloudinaryPublicId: 'products/tara', altText: 'Tara' }],
    variants: [
      {
        id: VARIANT,
        sku: 'RNG-TARA-7',
        name: 'Size 7',
        mrp: new Decimal('1199.00'),
        sellingPrice: new Decimal('999.00'),
        isDefault: true,
        sortOrder: 0,
        inventory: { quantityOnHand: 9, quantityReserved: 0, lowStockThreshold: null },
        variantValues: [],
      },
    ],
    ...over,
  };
}

function itemRow(over: Record<string, unknown> = {}) {
  return {
    id: ITEM,
    productId: PRODUCT,
    variantId: null,
    createdAt: new Date('2026-11-18T00:00:00.000Z'),
    product: productCard(),
    ...over,
  };
}

function setup() {
  const t = buildModuleTestApp([createWishlistModule]);
  const customer = t.customer();
  return { t, customer, auth: customer.headers };
}

describe('wishlist', () => {
  it('lists items with card data, newest first, paginated (default 30)', async () => {
    const { t, customer, auth } = setup();
    t.m.wishlist.findUnique.mockResolvedValue({ id: WISHLIST });
    t.m.wishlistItem.findMany.mockResolvedValue([itemRow()]);
    t.m.wishlistItem.count.mockResolvedValue(1);
    const res = await request(t.app).get('/api/v1/wishlist').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({
      id: ITEM,
      productId: PRODUCT,
      productSlug: 'tara-silver-ring',
      name: 'Tara Silver Ring',
      price: { min: '999.00', max: '999.00' },
      availability: { inStock: true, lowStock: false, isAvailable: true },
      variantId: null,
      addedAt: '2026-11-18T00:00:00.000Z',
    });
    expect(res.body.meta).toMatchObject({ page: 1, limit: 30, totalItems: 1 });
    expect(t.m.wishlist.findUnique.mock.calls[0]?.[0].where).toEqual({
      userId: customer.ctx.userId,
    });
  });

  it('returns an empty page when the customer has no wishlist yet', async () => {
    const { t, auth } = setup();
    t.m.wishlist.findUnique.mockResolvedValue(null);
    const res = await request(t.app).get('/api/v1/wishlist').set(auth);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.totalItems).toBe(0);
  });

  it('adds an item (201) and rejects duplicates (409), unknown products (404) and the 201st item (422)', async () => {
    const { t, auth } = setup();
    t.m.product.findFirst.mockResolvedValue({ id: PRODUCT, productType: 'VARIABLE' });
    t.m.productVariant.findFirst.mockResolvedValue({ id: VARIANT });
    t.m.wishlist.upsert.mockResolvedValue({ id: WISHLIST });
    t.m.wishlistItem.findFirst.mockResolvedValue(null);
    t.m.wishlistItem.count.mockResolvedValue(0);
    t.m.wishlistItem.create.mockResolvedValue(itemRow({ variantId: VARIANT }));
    const res = await request(t.app)
      .post('/api/v1/wishlist/items')
      .set(auth)
      .send({ productId: PRODUCT, variantId: VARIANT });
    expect(res.status).toBe(201);
    expect(res.body.data.variantId).toBe(VARIANT);

    t.m.wishlistItem.findFirst.mockResolvedValue({ id: ITEM });
    const dup = await request(t.app)
      .post('/api/v1/wishlist/items')
      .set(auth)
      .send({ productId: PRODUCT });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_RESOURCE');

    t.m.wishlistItem.findFirst.mockResolvedValue(null);
    t.m.wishlistItem.count.mockResolvedValue(200);
    const full = await request(t.app)
      .post('/api/v1/wishlist/items')
      .set(auth)
      .send({ productId: PRODUCT });
    expect(full.status).toBe(422);
    expect(full.body.error.details[0].code).toBe('WISHLIST_LIMIT');

    t.m.productVariant.findFirst.mockResolvedValue(null);
    expect(
      (
        await request(t.app)
          .post('/api/v1/wishlist/items')
          .set(auth)
          .send({ productId: PRODUCT, variantId: VARIANT })
      ).status,
    ).toBe(404);
    t.m.product.findFirst.mockResolvedValue(null);
    expect(
      (await request(t.app).post('/api/v1/wishlist/items').set(auth).send({ productId: PRODUCT }))
        .status,
    ).toBe(404);
    const strict = await request(t.app)
      .post('/api/v1/wishlist/items')
      .set(auth)
      .send({ productId: PRODUCT, userId: WISHLIST });
    expect(strict.status).toBe(422);
  });

  it("returns 404 for another customer's item (IDOR) on delete and move-to-cart", async () => {
    const { t, customer, auth } = setup();
    t.m.wishlistItem.findFirst.mockResolvedValue(null);
    expect((await request(t.app).delete(`/api/v1/wishlist/items/${ITEM}`).set(auth)).status).toBe(
      404,
    );
    expect(
      (await request(t.app).post(`/api/v1/wishlist/items/${ITEM}/move-to-cart`).set(auth).send({}))
        .status,
    ).toBe(404);
    expect(t.m.wishlistItem.findFirst.mock.calls[0]?.[0].where).toEqual({
      id: ITEM,
      wishlist: { userId: customer.ctx.userId },
    });
    expect(t.m.wishlistItem.delete).not.toHaveBeenCalled();
  });

  it('deletes an owned item', async () => {
    const { t, auth } = setup();
    t.m.wishlistItem.findFirst.mockResolvedValue({
      id: ITEM,
      productId: PRODUCT,
      variantId: null,
      product: { productType: 'VARIABLE' },
    });
    const res = await request(t.app).delete(`/api/v1/wishlist/items/${ITEM}`).set(auth);
    expect(res.body.data).toEqual({ id: ITEM, deleted: true });
  });

  it('move-to-cart requires a variant for VARIABLE products (422 VARIANT_REQUIRED)', async () => {
    const { t, auth } = setup();
    t.m.wishlistItem.findFirst.mockResolvedValue({
      id: ITEM,
      productId: PRODUCT,
      variantId: null,
      product: { productType: 'VARIABLE' },
    });
    const res = await request(t.app)
      .post(`/api/v1/wishlist/items/${ITEM}/move-to-cart`)
      .set(auth)
      .send({});
    expect(res.status).toBe(422);
    expect(res.body.error.details[0].code).toBe('VARIANT_REQUIRED');
  });

  it('moves a SIMPLE product (default variant) to the cart and removes the wishlist item', async () => {
    const { t, auth } = setup();
    primeCart(t);
    t.m.wishlistItem.findFirst.mockResolvedValue({
      id: ITEM,
      productId: PRODUCT,
      variantId: null,
      product: { productType: 'SIMPLE' },
    });
    t.m.productVariant.findFirst.mockResolvedValue({ id: VARIANT });
    t.m.productVariant.findUnique.mockResolvedValue(variantCheck({ id: VARIANT }));
    t.m.cartItem.findUnique.mockResolvedValue(null);
    t.m.cartItem.count.mockResolvedValue(0);
    const res = await request(t.app)
      .post(`/api/v1/wishlist/items/${ITEM}/move-to-cart`)
      .set(auth)
      .send({ quantity: 2 });
    expect(res.status).toBe(200);
    expect(res.body.data.wishlistItemRemoved).toBe(true);
    expect(res.body.data.cart).toHaveProperty('totals');
    expect(t.m.cartItem.create.mock.calls[0]?.[0].data).toMatchObject({
      variantId: VARIANT,
      quantity: 2,
    });
    expect(t.m.wishlistItem.delete).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ITEM } }),
    );
  });

  it('keeps the wishlist item when the cart rejects the move (409 INSUFFICIENT_STOCK)', async () => {
    const { t, auth } = setup();
    primeCart(t);
    t.m.wishlistItem.findFirst.mockResolvedValue({
      id: ITEM,
      productId: PRODUCT,
      variantId: VARIANT,
      product: { productType: 'VARIABLE' },
    });
    t.m.productVariant.findFirst.mockResolvedValue({ id: VARIANT });
    t.m.productVariant.findUnique.mockResolvedValue(
      variantCheck({ id: VARIANT, inventory: { quantityOnHand: 0, quantityReserved: 0 } }),
    );
    t.m.cartItem.findUnique.mockResolvedValue(null);
    t.m.cartItem.count.mockResolvedValue(0);
    const res = await request(t.app)
      .post(`/api/v1/wishlist/items/${ITEM}/move-to-cart`)
      .set(auth)
      .send({ variantId: VARIANT });
    expect(res.status).toBe(409);
    expect(t.m.wishlistItem.delete).not.toHaveBeenCalled();
    t.m.productVariant.findFirst.mockResolvedValue(null);
    expect(
      (
        await request(t.app)
          .post(`/api/v1/wishlist/items/${ITEM}/move-to-cart`)
          .set(auth)
          .send({ variantId: VARIANT })
      ).status,
    ).toBe(404);
  });

  it('requires authentication', async () => {
    const { t } = setup();
    expect((await request(t.app).get('/api/v1/wishlist')).status).toBe(401);
  });
});

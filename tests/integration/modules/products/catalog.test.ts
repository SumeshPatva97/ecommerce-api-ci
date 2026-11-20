/**
 * Public catalog (listing, facets, detail, related, autocomplete) — MOCKED DB (no MySQL). The
 * Prisma `where` objects handed to the mocks are asserted, so filter semantics are verified at
 * the query-construction level, not executed SQL.
 */
import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { dec } from '../../../../src/lib/money.js';
import { createCatalogModule } from '../../../../src/modules/catalog/index.js';
import { buildModuleTestApp, type ModuleTestApp } from '../../../helpers/container.js';
import { cardRow, primeEmptyDb, UPLOAD_FOLDER } from './fixtures.js';

let t: ModuleTestApp;

beforeEach(() => {
  t = buildModuleTestApp([createCatalogModule]);
  primeEmptyDb(t.m);
});

interface Where {
  AND: Record<string, unknown>[];
}
const lastWhere = (): Where => t.m.product.findMany.mock.calls.at(-1)?.[0].where as Where;

describe('GET /products', () => {
  it('lists only visible products and returns cards with string money and page meta', async () => {
    t.m.product.findMany.mockResolvedValue([cardRow()]);
    t.m.product.count.mockResolvedValue(31);
    const res = await request(t.app).get('/api/v1/products?page=2');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=60, stale-while-revalidate=300');
    expect(res.body.meta).toMatchObject({
      page: 2,
      limit: 30,
      totalItems: 31,
      totalPages: 2,
      hasNextPage: false,
      hasPrevPage: true,
      sort: 'newest',
    });
    const call = t.m.product.findMany.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      skip: 30,
      take: 30,
      orderBy: [{ publishedAt: 'desc' }, { id: 'asc' }],
    });
    expect(call.where.AND[0]).toMatchObject({
      status: 'ACTIVE',
      deletedAt: null,
      publishedAt: { lte: t.now.value },
      variants: { some: { status: 'ACTIVE', deletedAt: null } },
    });
    const card = res.body.data[0];
    expect(card).toMatchObject({
      price: {
        min: '999.00',
        max: '999.00',
        mrpMin: '1199.00',
        hasRange: false,
        discountPercentMax: 17,
      },
      availability: { inStock: true, lowStock: true },
      badges: ['BEST_SELLER'],
      rating: { average: '4.50', count: 3 },
    });
    expect(card.primaryImage.url).toContain(`w_600/${UPLOAD_FOLDER}/products/x/main`);
    expect(card.hoverImage.altText).toBe('On model');
    expect(card.defaultVariantId).toEqual(expect.any(String));
    expect(JSON.stringify(res.body)).not.toMatch(/costPrice|quantityOnHand|createdById/);
  });

  it('builds filters for category subtree, brand, attributes, price, availability and sort', async () => {
    const root = randomUUID();
    const child = randomUUID();
    t.m.category.findFirst.mockResolvedValue({ id: root });
    t.m.category.findMany.mockResolvedValueOnce([{ id: child }]).mockResolvedValue([]);
    const res = await request(t.app).get('/api/v1/products').query({
      category: 'earrings',
      brand: 'aura,noor',
      material: 'brass',
      attributes: 'plating:gold-plated|silver-plated',
      minPrice: '500',
      maxPrice: '3000',
      availability: 'in_stock',
      sort: 'price_asc',
      limit: '10',
    });
    expect(res.status).toBe(200);
    const where = lastWhere();
    expect(where.AND).toEqual(
      expect.arrayContaining([
        { categoryId: { in: [root, child] } },
        { brand: { slug: { in: ['aura', 'noor'] }, deletedAt: null } },
        expect.objectContaining({
          OR: expect.arrayContaining([
            {
              attributeValues: {
                some: {
                  attribute: { code: 'material' },
                  attributeValue: { slug: { in: ['brass'] } },
                },
              },
            },
          ]),
        }),
        {
          variants: {
            some: { status: 'ACTIVE', deletedAt: null, sellingPrice: { gte: '500', lte: '3000' } },
          },
        },
      ]),
    );
    expect(JSON.stringify(where)).toContain('"code":"plating"');
    expect(t.m.product.findMany.mock.calls.at(-1)?.[0].orderBy[0]).toEqual({
      minSellingPrice: 'asc',
    });
    expect(res.body.meta.filters).toMatchObject({
      category: 'earrings',
      brand: ['aura', 'noor'],
      material: ['brass'],
      attributes: { plating: ['gold-plated', 'silver-plated'] },
      minPrice: '500.00',
      maxPrice: '3000.00',
      availability: 'in_stock',
    });
  });

  it('returns 404 for an unknown category and 422 for invalid paging/prices/sort', async () => {
    expect((await request(t.app).get('/api/v1/products?category=nope')).status).toBe(404);
    expect((await request(t.app).get('/api/v1/products?limit=101')).status).toBe(422);
    expect((await request(t.app).get('/api/v1/products?minPrice=10&maxPrice=5')).status).toBe(422);
    expect((await request(t.app).get('/api/v1/products?sort=cheapest')).status).toBe(422);
    expect((await request(t.app).get('/api/v1/products?unknownKey=1')).status).toBe(200);
  });

  it('orders `ids` results by input order and adds matchedVariants for `variantIds`', async () => {
    const a = cardRow({ id: randomUUID(), slug: 'a' });
    const b = cardRow({ id: randomUUID(), slug: 'b' });
    t.m.product.findMany.mockResolvedValue([a, b]);
    t.m.product.count.mockResolvedValue(2);
    const ids = await request(t.app).get(`/api/v1/products?ids=${b.id},${a.id}`);
    expect((ids.body.data as { slug: string }[]).map((p) => p.slug)).toEqual(['b', 'a']);

    const variantId = a.variants[0]?.id ?? '';
    t.m.product.findMany.mockResolvedValue([a]);
    const res = await request(t.app).get(`/api/v1/products?variantIds=${variantId}`);
    expect(res.body.data[0].matchedVariants).toEqual([
      {
        variantId,
        sku: 'RNG-TARA-SLV',
        variantName: 'Tara Silver Ring',
        mrp: '1199.00',
        unitPrice: '999.00',
        availability: { status: 'LOW_STOCK', maxPurchasable: 3 },
      },
    ]);
  });
});

describe('GET /products/:slug', () => {
  it('returns 404 when the product is not visible (unpublished, inactive or deleted)', async () => {
    const res = await request(t.app).get('/api/v1/products/draft-ring');
    expect(res.status).toBe(404);
    const where = t.m.product.findFirst.mock.calls[0]?.[0].where as Where;
    expect(where.AND).toEqual([
      expect.objectContaining({ status: 'ACTIVE', publishedAt: { lte: t.now.value } }),
      { slug: 'draft-ring' },
    ]);
  });

  it('maps axes, variants, image resolution and unavailable combinations without cost data', async () => {
    const finishId = randomUUID();
    const sizeId = randomUUID();
    const link = (
      attrId: string,
      code: string,
      name: string,
      display: string,
      valueId: string,
      slug: string,
      label: string,
      sort: number,
    ) => ({
      attributeId: attrId,
      attributeValueId: valueId,
      attribute: { code, name, displayType: display, sortOrder: code === 'size' ? 1 : 0 },
      attributeValue: {
        slug,
        value: label,
        swatchHex: display === 'SWATCH' ? '#C9A96E' : null,
        sortOrder: sort,
      },
    });
    const gold = randomUUID();
    const rose = randomUUID();
    const s = randomUUID();
    const m = randomUUID();
    const vGoldS = randomUUID();
    const vGoldM = randomUUID();
    const vRoseS = randomUUID();
    const variant = (
      id: string,
      sku: string,
      links: ReturnType<typeof link>[],
      onHand: number,
    ) => ({
      id,
      sku,
      name: links.map((l) => l.attributeValue.value).join(' / '),
      mrp: dec('1799'),
      sellingPrice: dec('1499'),
      isDefault: false,
      sortOrder: 0,
      inventory: { quantityOnHand: onHand, quantityReserved: 0, lowStockThreshold: null },
      variantValues: links,
    });
    const goldL = link(finishId, 'metal-finish', 'Metal Finish', 'SWATCH', gold, 'gold', 'Gold', 0);
    const roseL = link(
      finishId,
      'metal-finish',
      'Metal Finish',
      'SWATCH',
      rose,
      'rose-gold',
      'Rose Gold',
      1,
    );
    const sL = link(sizeId, 'size', 'Size', 'BUTTON', s, 'small', 'Small', 0);
    const mL = link(sizeId, 'size', 'Size', 'BUTTON', m, 'medium', 'Medium', 1);
    const shared = {
      id: 'img-main',
      variantId: null,
      cloudinaryPublicId: 'ecom/dev/products/p/main',
      altText: 'Main',
      sortOrder: 0,
      isPrimary: true,
    };
    const goldImg = {
      id: 'img-g',
      variantId: vGoldS,
      cloudinaryPublicId: 'ecom/dev/products/p/gold',
      altText: 'Gold',
      sortOrder: 1,
      isPrimary: false,
    };
    t.m.product.findFirst.mockResolvedValue({
      ...cardRow({ productType: 'VARIABLE', slug: 'meera' }),
      categoryId: 'cat-jh',
      shortDescription: 'Hand-set',
      description: '<p>x</p>',
      careInstructions: null,
      seoTitle: null,
      seoDescription: null,
      countryOfOrigin: 'India',
      manufacturerName: null,
      manufacturerAddress: null,
      importerName: null,
      importerAddress: null,
      collections: [{ collection: { name: 'Bridal Edit', slug: 'bridal-edit' } }],
      attributeValues: [
        {
          attribute: { name: 'Gemstone', sortOrder: 1 },
          attributeValue: { value: 'Pearl', sortOrder: 1 },
        },
        {
          attribute: { name: 'Gemstone', sortOrder: 1 },
          attributeValue: { value: 'Kundan', sortOrder: 0 },
        },
        {
          attribute: { name: 'Material', sortOrder: 0 },
          attributeValue: { value: 'Brass', sortOrder: 0 },
        },
      ],
      images: [shared, goldImg],
      variants: [
        variant(vGoldS, 'EAR-GLD-S', [goldL, sL], 10),
        variant(vGoldM, 'EAR-GLD-M', [goldL, mL], 2),
        variant(vRoseS, 'EAR-RSG-S', [roseL, sL], 0),
      ],
    });
    t.m.category.findUnique
      .mockResolvedValueOnce({ name: 'Jhumkas', slug: 'jhumkas', parentId: 'cat-ear' })
      .mockResolvedValueOnce({ name: 'Earrings', slug: 'earrings', parentId: null });
    t.m.review.count.mockResolvedValue(1);

    const res = await request(t.app).get('/api/v1/products/meera?variant=ear-gld-m');
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.breadcrumb).toEqual([
      { name: 'Earrings', slug: 'earrings' },
      { name: 'Jhumkas', slug: 'jhumkas' },
    ]);
    expect(d.specifications).toEqual([
      { attribute: 'Material', value: 'Brass' },
      { attribute: 'Gemstone', value: 'Kundan, Pearl' },
    ]);
    expect((d.attributeAxes as { slug: string }[]).map((a) => a.slug)).toEqual([
      'metal-finish',
      'size',
    ]);
    expect(d.attributeAxes[0].values[0]).toEqual({
      valueId: gold,
      slug: 'gold',
      label: 'Gold',
      hex: '#C9A96E',
    });
    expect(d.unavailableCombinations).toEqual([{ 'metal-finish': 'rose-gold', size: 'medium' }]);
    const byId = new Map((d.variants as { id: string }[]).map((v) => [v.id, v]));
    expect(byId.get(vGoldS)).toMatchObject({
      options: { 'metal-finish': 'gold', size: 'small' },
      mrp: '1799.00',
      sellingPrice: '1499.00',
      effectivePrice: '1499.00',
      discountPercent: 17,
      availability: { status: 'IN_STOCK', maxPurchasable: 5 },
      imageIds: ['img-g', 'img-main'],
    });
    // Same swatch value (Gold) shares the variant images (workflow §11.3).
    expect(byId.get(vGoldM)).toMatchObject({
      availability: { status: 'LOW_STOCK', maxPurchasable: 2 },
      imageIds: ['img-g', 'img-main'],
    });
    expect(byId.get(vRoseS)).toMatchObject({
      availability: { status: 'OUT_OF_STOCK', maxPurchasable: 0 },
      imageIds: ['img-main'],
    });
    expect(d.selectedVariantId).toBe(vGoldM);
    expect(d.rating.distribution).toEqual({ '1': 1, '2': 1, '3': 1, '4': 1, '5': 1 });
    expect(d).not.toHaveProperty('isWishlisted');
    expect(d.images[0]).toMatchObject({ id: 'img-main', variantId: null });
    expect(JSON.stringify(res.body)).not.toMatch(/costPrice|quantityOnHand|quantityReserved/);
  });

  it('adds isWishlisted for a signed-in customer and keeps the response private', async () => {
    t.m.product.findFirst.mockResolvedValue({
      ...cardRow(),
      categoryId: 'c',
      shortDescription: null,
      description: null,
      careInstructions: null,
      seoTitle: null,
      seoDescription: null,
      countryOfOrigin: null,
      manufacturerName: null,
      manufacturerAddress: null,
      importerName: null,
      importerAddress: null,
      collections: [],
      attributeValues: [],
      images: [],
    });
    t.m.wishlistItem.count.mockResolvedValue(1);
    const customer = t.customer();
    const res = await request(t.app).get('/api/v1/products/tara-silver-ring').set(customer.headers);
    expect(res.status).toBe(200);
    expect(res.body.data.isWishlisted).toBe(true);
    expect(res.body.data.attributeAxes).toEqual([]);
    expect(res.headers['cache-control']).toContain('no-store');
  });
});

describe('GET /products/facets', () => {
  it('computes disjunctive counts (own filter excluded) and price/availability blocks', async () => {
    const brandA = randomUUID();
    const brandB = randomUUID();
    const row = (brandId: string, price: string, onHand: number) => ({
      id: randomUUID(),
      categoryId: 'cat',
      brandId,
      collections: [],
      attributeValues: [],
      variants: [
        {
          sellingPrice: dec(price),
          inventory: { quantityOnHand: onHand, quantityReserved: 0 },
          variantValues: [],
        },
      ],
    });
    // 1st query = base (brand filter applied), 2nd = brand filter removed.
    t.m.product.findMany
      .mockResolvedValueOnce([row(brandA, '1200', 1)])
      .mockResolvedValueOnce([
        row(brandA, '1200', 1),
        row(brandB, '450', 0),
        row(brandB, '5200', 2),
      ]);
    t.m.brand.findMany.mockResolvedValue([
      { id: brandA, name: 'Aura', slug: 'aura' },
      { id: brandB, name: 'Noor', slug: 'noor' },
    ]);
    t.m.category.findMany.mockResolvedValue([{ id: 'cat', name: 'Rings', slug: 'rings' }]);
    const res = await request(t.app).get('/api/v1/products/facets?brand=aura');
    expect(res.status).toBe(200);
    expect(res.body.data.brands).toEqual([
      { slug: 'noor', name: 'Noor', count: 2, selected: false },
      { slug: 'aura', name: 'Aura', count: 1, selected: true },
    ]);
    expect(res.body.data.categories).toEqual([{ slug: 'rings', name: 'Rings', count: 1 }]);
    expect(res.body.data.price).toMatchObject({ min: '1200.00', max: '1200.00' });
    expect(res.body.data.price.buckets[1]).toEqual({ from: '1000.00', to: '1999.00', count: 1 });
    expect(res.body.data.availability).toEqual({ inStock: 1, all: 1 });
    expect(res.body.meta.filters.brand).toEqual(['aura']);
  });
});

describe('GET /products/:slug/related and /search/autocomplete', () => {
  it('ranks related products by collection > category > brand and excludes self', async () => {
    const self = {
      id: 'self',
      categoryId: 'cat',
      brandId: 'brand',
      collections: [{ collectionId: 'col' }],
      attributeValues: [],
    };
    t.m.product.findFirst.mockResolvedValue(self);
    const cand = (slug: string, o: Record<string, unknown>) => ({
      ...cardRow({ slug }),
      categoryId: 'other',
      brandId: null,
      collections: [],
      attributeValues: [],
      ...o,
    });
    t.m.product.findMany.mockResolvedValue([
      cand('brand-only', { brandId: 'brand', totalSold: 999 }),
      cand('collection', { collections: [{ collectionId: 'col' }] }),
      cand('category', { categoryId: 'cat' }),
    ]);
    const res = await request(t.app).get('/api/v1/products/meera/related?limit=2');
    expect(res.status).toBe(200);
    expect((res.body.data as { slug: string }[]).map((p) => p.slug)).toEqual([
      'collection',
      'category',
    ]);
    const where = t.m.product.findMany.mock.calls[0]?.[0].where as Where;
    expect(where.AND).toEqual(expect.arrayContaining([{ id: { not: 'self' } }]));
  });

  it('ranks exact SKU matches first and validates q length', async () => {
    expect((await request(t.app).get('/api/v1/search/autocomplete?q=a')).status).toBe(422);
    t.m.product.findMany.mockResolvedValue([
      {
        id: '1',
        slug: 'name-hit',
        name: 'Rng Classic',
        images: [],
        variants: [{ sku: 'X-1', sellingPrice: dec('100') }],
      },
      {
        id: '2',
        slug: 'sku-hit',
        name: 'Other',
        images: [{ cloudinaryPublicId: 'a/b' }],
        variants: [{ sku: 'RNG', sellingPrice: dec('250') }],
      },
    ]);
    t.m.category.findMany.mockResolvedValue([{ slug: 'rings', name: 'Rings' }]);
    const res = await request(t.app).get('/api/v1/search/autocomplete?q=rng');
    expect(res.status).toBe(200);
    expect(res.body.data.query).toBe('rng');
    expect((res.body.data.products as { slug: string }[]).map((p) => p.slug)).toEqual([
      'sku-hit',
      'name-hit',
    ]);
    expect(res.body.data.products[0]).toMatchObject({ price: '250.00' });
    expect(res.body.data.products[0].thumbUrl).toContain('w_160');
    expect(res.body.data.categories).toEqual([{ slug: 'rings', name: 'Rings' }]);
  });
});

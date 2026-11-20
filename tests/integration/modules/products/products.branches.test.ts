/**
 * Admin products — edge cases through the real Express app. MOCKED DB (Prisma delegates are
 * vi.fn()s from tests/helpers/mockDb.ts; no MySQL, no SQL executed). Covers list filters/sorting,
 * reference validation, duplicate pre-checks on create/update, partial updates, the required-
 * attribute guard for ACTIVE products, the status lifecycle and check-duplicate per field.
 */
import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { dec } from '../../../../src/lib/money.js';
import { createProductsModule } from '../../../../src/modules/products/index.js';
import { buildModuleTestApp, type ModuleTestApp } from '../../../helpers/container.js';
import {
  attribute,
  attributeValue,
  categoryNode,
  primeEmptyDb,
  productAdminRow,
  productCore,
  serveAttributes,
} from './fixtures.js';

const ALL = ['products.view', 'products.create', 'products.update', 'products.delete'];
const BASE = '/api/v1/admin/products';

let t: ModuleTestApp;
let headers: Record<string, string>;
const category = categoryNode();

beforeEach(() => {
  t = buildModuleTestApp([createProductsModule]);
  primeEmptyDb(t.m);
  t.m.category.findUnique.mockResolvedValue(category);
  headers = t.staff({ permissions: ALL }).headers;
});

interface FindFirstArgs {
  where: { nameNormalized?: string; slug?: string };
}

/**
 * Routes `product.findFirst` by query shape: name-conflict lookups (`nameNormalized`), slug-
 * conflict lookups (`slug`), and everything else (findCore / findAdmin).
 */
function routeProducts(rows: { main?: unknown; nameHit?: unknown; slugHit?: unknown }): void {
  t.m.product.findFirst.mockImplementation((args: FindFirstArgs) => {
    if (args.where.nameNormalized !== undefined) return Promise.resolve(rows.nameHit ?? null);
    if (args.where.slug !== undefined) return Promise.resolve(rows.slugHit ?? null);
    return Promise.resolve(rows.main ?? null);
  });
}

function requiredRule(attributeId: string, name = 'Metal') {
  return {
    categoryId: category.id,
    attributeId,
    isRequired: true,
    isVariantAxisDefault: false,
    inheritToChildren: true,
    sortOrder: 0,
    attribute: { name },
  };
}

const simpleBody = {
  productType: 'SIMPLE',
  name: 'Tara Silver Ring',
  categoryId: category.id,
  variant: { sku: 'RNG-TARA', mrp: '1199.00', sellingPrice: '999.00' },
};

// ------------------------------------------------------------------------------------- list
describe('GET /admin/products — filters & sorting', () => {
  it('builds one AND clause per filter and passes the paging window', async () => {
    const categoryId = randomUUID();
    const brandId = randomUUID();
    const collectionId = randomUUID();
    t.m.product.count.mockResolvedValue(0);
    const res = await request(t.app).get(BASE).set(headers).query({
      status: 'ACTIVE',
      productType: 'VARIABLE',
      categoryId,
      brandId,
      collectionId,
      stock: 'in_stock',
      q: 'ear-1',
      page: 2,
      limit: 5,
    });
    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ sort: '-createdAt' });
    const args = t.m.product.findMany.mock.calls[0]?.[0];
    expect(args).toMatchObject({ skip: 5, take: 5 });
    expect(args.where.AND).toEqual([
      { deletedAt: null },
      { status: 'ACTIVE' },
      { productType: 'VARIABLE' },
      { categoryId },
      { brandId },
      { collections: { some: { collectionId } } },
      { isInStock: true },
      {
        OR: [
          { name: { contains: 'ear-1' } },
          { variants: { some: { sku: { startsWith: 'EAR-1' } } } },
          { variants: { some: { barcode: 'EAR-1' } } },
        ],
      },
    ]);
  });

  it('maps out_of_stock and low_stock to their own predicates', async () => {
    t.m.product.count.mockResolvedValue(0);
    await request(t.app).get(BASE).set(headers).query({ stock: 'out_of_stock' });
    expect(t.m.product.findMany.mock.calls[0]?.[0].where.AND).toContainEqual({ isInStock: false });
    await request(t.app).get(BASE).set(headers).query({ stock: 'low_stock' });
    const low = t.m.product.findMany.mock.calls[1]?.[0].where.AND as Record<string, unknown>[];
    expect(low[1]).toMatchObject({
      variants: { some: { deletedAt: null, status: 'ACTIVE' } },
    });
  });

  it.each([
    ['createdAt', { createdAt: 'asc' }],
    ['name', { name: 'asc' }],
    ['-updatedAt', { updatedAt: 'desc' }],
    ['price', { minSellingPrice: 'asc' }],
    ['-price', { minSellingPrice: 'desc' }],
    ['-createdAt', { createdAt: 'desc' }],
  ])('sort=%s orders by the mapped column with an id tiebreaker', async (sort, first) => {
    t.m.product.count.mockResolvedValue(0);
    const res = await request(t.app).get(BASE).set(headers).query({ sort });
    expect(res.status).toBe(200);
    expect(res.body.meta.sort).toBe(sort);
    expect(t.m.product.findMany.mock.calls[0]?.[0].orderBy).toEqual([first, { id: 'asc' }]);
  });

  it('rejects an unknown sort key (422)', async () => {
    const res = await request(t.app).get(BASE).set(headers).query({ sort: 'cost' });
    expect(res.status).toBe(422);
  });
});

// ------------------------------------------------------------------------------------- create
describe('POST /admin/products — validation & references', () => {
  it('rejects an unknown/inactive category (422 CATEGORY_INVALID)', async () => {
    t.m.category.findUnique.mockResolvedValue(null);
    const res = await request(t.app).post(BASE).set(headers).send(simpleBody);
    expect(res.status).toBe(422);
    expect(res.body.error.details).toEqual([
      expect.objectContaining({ field: 'categoryId', code: 'CATEGORY_INVALID' }),
    ]);
    expect(t.m.$transaction).not.toHaveBeenCalled();
  });

  it('reports every missing reference (brand, collection, HSN, attribute value) at once', async () => {
    const collectionId = randomUUID();
    const valueId = randomUUID();
    const res = await request(t.app)
      .post(BASE)
      .set(headers)
      .send({
        ...simpleBody,
        brandId: randomUUID(),
        collectionIds: [collectionId],
        hsnCode: '7117',
        attributeValueIds: [valueId],
      });
    expect(res.status).toBe(422);
    const codes = (res.body.error.details as { field: string; code: string }[]).map(
      (d) => `${d.field}:${d.code}`,
    );
    expect(codes).toEqual([
      'brandId:BRAND_NOT_FOUND',
      'collectionIds[0]:COLLECTION_NOT_FOUND',
      'hsnCode:HSN_NOT_FOUND',
      'attributeValueIds[0]:ATTRIBUTE_VALUE_NOT_FOUND',
    ]);
  });

  it('creates with resolved references, links values/collections and maps every scalar field', async () => {
    const brandId = randomUUID();
    const collectionId = randomUUID();
    const material = attribute({ code: 'material', name: 'Material', isVariantAxis: false });
    const silver = attributeValue(material, 'Silver');
    serveAttributes(t.m, [material], [silver]);
    t.m.brand.findFirst.mockResolvedValue({ id: brandId });
    t.m.collection.findMany.mockResolvedValue([{ id: collectionId }]);
    t.m.hsnCode.findUnique.mockResolvedValue({ hsnCode: '7117' });
    const res = await request(t.app)
      .post(BASE)
      .set(headers)
      .send({
        ...simpleBody,
        slug: 'tara-ring',
        brandId,
        collectionIds: [collectionId],
        hsnCode: '7117',
        attributeValueIds: [silver.id],
        shortDescription: 'Short',
        description: null,
        careInstructions: 'Keep dry',
        searchKeywords: 'ring silver',
        isFeatured: true,
        isNewArrival: true,
        isBestSellerPinned: false,
        seo: { title: 'SEO title', description: 'SEO description' },
        legal: {
          countryOfOrigin: 'India',
          manufacturerName: 'Aura',
          manufacturerAddress: 'Jaipur',
          importerName: 'None',
          importerAddress: 'N/A',
        },
      });
    expect(res.status).toBe(201);
    expect(res.body.data.slug).toBe('tara-ring');
    expect(t.m.product.create.mock.calls[0]?.[0].data).toMatchObject({
      slug: 'tara-ring',
      brandId,
      hsnCode: '7117',
      shortDescription: 'Short',
      description: null,
      careInstructions: 'Keep dry',
      searchKeywords: 'ring silver',
      isFeatured: true,
      isNewArrival: true,
      isBestSellerPinned: false,
      seoTitle: 'SEO title',
      seoDescription: 'SEO description',
      countryOfOrigin: 'India',
      manufacturerName: 'Aura',
      manufacturerAddress: 'Jaipur',
      importerName: 'None',
      importerAddress: 'N/A',
    });
    expect(t.m.productAttributeValue.createMany.mock.calls[0]?.[0].data).toEqual([
      expect.objectContaining({ attributeId: material.id, attributeValueId: silver.id }),
    ]);
    expect(t.m.collectionProduct.createMany.mock.calls[0]?.[0].data).toEqual([
      expect.objectContaining({ collectionId, addedAt: t.now.value }),
    ]);
    const audit = t.m.auditLog.create.mock.calls.at(-1)?.[0].data;
    expect(audit.newValues).toMatchObject({
      brandId,
      attributeValueIds: [silver.id],
      collectionIds: [collectionId],
    });
  });

  it('rejects an explicit slug that is already taken (409, deleted owner flagged)', async () => {
    routeProducts({ slugHit: { id: 'p-old', name: 'Old', deletedAt: new Date() } });
    const res = await request(t.app)
      .post(BASE)
      .set(headers)
      .send({ ...simpleBody, slug: 'tara-ring' });
    expect(res.status).toBe(409);
    expect(res.body.error.details).toEqual([
      expect.objectContaining({
        field: 'slug',
        code: 'DUPLICATE_RESOURCE',
        meta: { existingId: 'p-old', deleted: true },
      }),
    ]);
  });

  it('warns about required attributes that are still missing on a DRAFT create', async () => {
    const attrId = randomUUID();
    t.m.categoryAttribute.findMany.mockResolvedValue([requiredRule(attrId, 'Purity')]);
    const res = await request(t.app).post(BASE).set(headers).send(simpleBody);
    expect(res.status).toBe(201);
    expect(res.body.data.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'REQUIRED_ATTRIBUTE_MISSING',
          meta: { attributeId: attrId },
        }),
      ]),
    );
  });

  it('creates a VARIABLE product without axes/variants and warns NO_VARIANTS', async () => {
    const res = await request(t.app)
      .post(BASE)
      .set(headers)
      .send({ productType: 'VARIABLE', name: 'Empty Shell', categoryId: category.id });
    expect(res.status).toBe(201);
    expect(res.body.data.variants).toEqual([]);
    const codes = (res.body.data.warnings as { code: string }[]).map((w) => w.code);
    expect(codes).toEqual(['NO_VARIANTS', 'NO_IMAGES']);
    expect(t.m.productVariant.create).not.toHaveBeenCalled();
  });

  it('accepts axes with no variants yet (NO_VARIANTS warning, no value lookup)', async () => {
    const finish = attribute();
    serveAttributes(t.m, [finish], []);
    const res = await request(t.app)
      .post(BASE)
      .set(headers)
      .send({
        productType: 'VARIABLE',
        name: 'Axis Only',
        categoryId: category.id,
        variantAxes: [finish.id],
      });
    expect(res.status).toBe(201);
    expect((res.body.data.warnings as { code: string }[]).map((w) => w.code)).toContain(
      'NO_VARIANTS',
    );
  });

  it('rejects a variant whose values do not match the axes (422 AXIS_VALUES_MISMATCH)', async () => {
    const finish = attribute();
    const size = attribute({ code: 'size', name: 'Size' });
    const gold = attributeValue(finish, 'Gold');
    const small = attributeValue(size, 'Small');
    serveAttributes(t.m, [finish, size], [gold, small]);
    const res = await request(t.app)
      .post(BASE)
      .set(headers)
      .send({
        productType: 'VARIABLE',
        name: 'Mismatch',
        categoryId: category.id,
        variantAxes: [finish.id, size.id],
        variants: [{ attributeValueIds: [gold.id], sku: 'MM-1', mrp: '10', sellingPrice: '9' }],
      });
    expect(res.status).toBe(422);
    expect(res.body.error.details[0]).toMatchObject({
      field: 'variants[0].attributeValueIds',
      code: 'AXIS_VALUES_MISMATCH',
    });
  });
});

// ------------------------------------------------------------------------------------- update
describe('PATCH /admin/products/:productId', () => {
  it('404s an unknown product', async () => {
    const res = await request(t.app)
      .patch(`${BASE}/${randomUUID()}`)
      .set(headers)
      .send({ isFeatured: true });
    expect(res.status).toBe(404);
  });

  it('reports a renamed product clashing in its category and a taken slug together (409)', async () => {
    const row = productAdminRow();
    routeProducts({
      main: row,
      nameHit: { id: 'p2', name: 'Gold Ring', deletedAt: null, category: { name: 'Rings' } },
      slugHit: { id: 'p3', name: 'Other', deletedAt: null },
    });
    const res = await request(t.app)
      .patch(`${BASE}/${row.id}`)
      .set(headers)
      .send({ name: 'Gold Ring', slug: 'gold-ring' });
    expect(res.status).toBe(409);
    expect(res.body.error.details).toEqual([
      expect.objectContaining({
        field: 'name',
        message: 'A product named "Gold Ring" already exists in Rings.',
        meta: { existingId: 'p2', scope: 'CATEGORY', deleted: false },
      }),
      expect.objectContaining({ field: 'slug', meta: { existingId: 'p3', deleted: false } }),
    ]);
    // The conflict queries exclude the product itself.
    const nameCall = t.m.product.findFirst.mock.calls.find(
      (c) => (c[0] as FindFirstArgs).where.nameNormalized !== undefined,
    );
    expect(nameCall?.[0].where.id).toEqual({ not: row.id });
    expect(t.m.product.update).not.toHaveBeenCalled();
  });

  it('applies a partial update: rename, re-slug, move category, replace values & collections', async () => {
    const row = productAdminRow();
    const newCategory = randomUUID();
    const collectionId = randomUUID();
    const material = attribute({ code: 'material', name: 'Material', isVariantAxis: false });
    const silver = attributeValue(material, 'Silver');
    serveAttributes(t.m, [material], [silver]);
    t.m.collection.findMany.mockResolvedValue([{ id: collectionId }]);
    routeProducts({ main: row });
    const res = await request(t.app)
      .patch(`${BASE}/${row.id}`)
      .set(headers)
      .send({
        name: 'Meera  Polki Jhumka',
        slug: 'meera-polki-jhumka',
        categoryId: newCategory,
        attributeValueIds: [silver.id],
        collectionIds: [collectionId],
        description: '<p>Bold</p><script>x</script>',
        seo: { title: 'Only title' },
        legal: {},
        expectedUpdatedAt: row.updatedAt.toISOString(),
      });
    expect(res.status).toBe(200);
    const data = t.m.product.update.mock.calls[0]?.[0].data;
    expect(data).toMatchObject({
      name: 'Meera  Polki Jhumka',
      nameNormalized: 'meera polki jhumka',
      slug: 'meera-polki-jhumka',
      categoryId: newCategory,
      description: '<p>Bold</p>',
      seoTitle: 'Only title',
    });
    expect(data).not.toHaveProperty('seoDescription');
    expect(data).not.toHaveProperty('countryOfOrigin');
    expect(t.m.productAttributeValue.deleteMany).toHaveBeenCalledWith({
      where: { productId: row.id },
    });
    expect(t.m.productAttributeValue.createMany.mock.calls[0]?.[0].data).toEqual([
      { productId: row.id, attributeId: material.id, attributeValueId: silver.id },
    ]);
    expect(t.m.collectionProduct.createMany.mock.calls[0]?.[0].data).toEqual([
      expect.objectContaining({ collectionId, productId: row.id, addedAt: t.now.value }),
    ]);
    const audit = t.m.auditLog.create.mock.calls.at(-1)?.[0].data;
    expect(audit.newValues).toMatchObject({
      name: 'Meera  Polki Jhumka',
      slug: 'meera-polki-jhumka',
      categoryId: newCategory,
      attributeValueIds: [silver.id],
      collectionIds: [collectionId],
    });
  });

  it('clears values and collections with empty arrays (delete, no re-insert)', async () => {
    const row = productAdminRow();
    routeProducts({ main: row });
    const res = await request(t.app)
      .patch(`${BASE}/${row.id}`)
      .set(headers)
      .send({ attributeValueIds: [], collectionIds: [], slug: row.slug });
    expect(res.status).toBe(200);
    expect(t.m.productAttributeValue.deleteMany).toHaveBeenCalled();
    expect(t.m.collectionProduct.deleteMany).toHaveBeenCalled();
    expect(t.m.productAttributeValue.createMany).not.toHaveBeenCalled();
    expect(t.m.collectionProduct.createMany).not.toHaveBeenCalled();
    // Unchanged slug → no conflict lookup.
    expect(
      t.m.product.findFirst.mock.calls.some(
        (c) => (c[0] as FindFirstArgs).where.slug !== undefined,
      ),
    ).toBe(false);
  });

  it('moving to an unusable category is rejected (422 CATEGORY_INVALID)', async () => {
    const row = productAdminRow();
    routeProducts({ main: row });
    t.m.category.findUnique.mockResolvedValue({ ...category, isActive: false });
    const res = await request(t.app)
      .patch(`${BASE}/${row.id}`)
      .set(headers)
      .send({ categoryId: randomUUID() });
    expect(res.status).toBe(422);
    expect(res.body.error.details[0].code).toBe('CATEGORY_INVALID');
  });

  it('an ACTIVE product cannot drop a required attribute (422 REQUIRED_ATTRIBUTE_MISSING)', async () => {
    const attrId = randomUUID();
    const row = productAdminRow({ status: 'ACTIVE' });
    routeProducts({ main: row });
    t.m.categoryAttribute.findMany.mockResolvedValue([requiredRule(attrId, 'Purity')]);
    const res = await request(t.app)
      .patch(`${BASE}/${row.id}`)
      .set(headers)
      .send({ attributeValueIds: [] });
    expect(res.status).toBe(422);
    expect(res.body.error.details).toEqual([
      expect.objectContaining({
        field: 'attributeValueIds',
        code: 'REQUIRED_ATTRIBUTE_MISSING',
        message: 'Required attribute "Purity" has no value.',
        meta: { attributeId: attrId },
      }),
    ]);
    expect(t.m.$transaction).not.toHaveBeenCalled();
  });

  it('an ACTIVE SIMPLE product keeping its stored values passes the required-attribute check', async () => {
    const attrId = randomUUID();
    const row = productAdminRow({
      status: 'ACTIVE',
      productType: 'SIMPLE',
      attributeValues: [
        {
          attributeId: attrId,
          attributeValueId: randomUUID(),
          attribute: { code: 'purity', name: 'Purity', sortOrder: 0 },
          attributeValue: { value: '925', slug: '925', sortOrder: 0 },
        },
      ],
    });
    routeProducts({ main: row });
    t.m.categoryAttribute.findMany.mockResolvedValue([requiredRule(attrId, 'Purity')]);
    // Same category id → re-read the chain instead of re-validating the category.
    const res = await request(t.app)
      .patch(`${BASE}/${row.id}`)
      .set(headers)
      .send({ categoryId: row.categoryId });
    expect(res.status).toBe(200);
    expect(t.m.product.update.mock.calls[0]?.[0].data.categoryId).toBe(row.categoryId);
  });
});

// ------------------------------------------------------------------------------------- delete
describe('DELETE /admin/products/:productId', () => {
  it('404s an unknown product', async () => {
    const res = await request(t.app).delete(`${BASE}/${randomUUID()}`).set(headers);
    expect(res.status).toBe(404);
    expect(t.m.product.update).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------------------------- status
describe('PATCH /admin/products/:productId/status — lifecycle', () => {
  const url = (id: string) => `${BASE}/${id}/status`;

  it('404s an unknown product', async () => {
    const res = await request(t.app)
      .patch(url(randomUUID()))
      .set(headers)
      .send({ status: 'ARCHIVED' });
    expect(res.status).toBe(404);
  });

  it('is a no-op when the status does not change (DRAFT without publishedAt)', async () => {
    const core = productCore();
    t.m.product.findFirst.mockResolvedValue(core);
    const res = await request(t.app).patch(url(core.id)).set(headers).send({ status: 'DRAFT' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: core.id, status: 'DRAFT', publishedAt: null });
    expect(t.m.$transaction).not.toHaveBeenCalled();
  });

  it('is a no-op for ACTIVE → ACTIVE and echoes the original publishedAt', async () => {
    const publishedAt = new Date('2026-05-01T00:00:00.000Z');
    const core = productCore({ status: 'ACTIVE', publishedAt });
    t.m.product.findFirst.mockResolvedValue(core);
    const res = await request(t.app).patch(url(core.id)).set(headers).send({ status: 'ACTIVE' });
    expect(res.status).toBe(200);
    expect(res.body.data.publishedAt).toBe(publishedAt.toISOString());
    expect(t.m.product.update).not.toHaveBeenCalled();
  });

  it('ACTIVE → INACTIVE keeps publishedAt and skips the publish gate', async () => {
    const publishedAt = new Date('2026-05-01T00:00:00.000Z');
    const core = productCore({ status: 'ACTIVE', publishedAt });
    t.m.product.findFirst.mockResolvedValue(core);
    const res = await request(t.app)
      .patch(url(core.id))
      .set(headers)
      .send({ status: 'INACTIVE', reason: 'Seasonal' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      id: core.id,
      status: 'INACTIVE',
      publishedAt: publishedAt.toISOString(),
    });
    expect(t.m.productImage.count).not.toHaveBeenCalled();
    expect(t.m.product.update.mock.calls[0]?.[0].data).toMatchObject({
      status: 'INACTIVE',
      publishedAt,
    });
  });

  it('DRAFT → ARCHIVED leaves publishedAt null', async () => {
    const core = productCore();
    t.m.product.findFirst.mockResolvedValue(core);
    const res = await request(t.app).patch(url(core.id)).set(headers).send({ status: 'ARCHIVED' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: core.id, status: 'ARCHIVED', publishedAt: null });
  });

  it('ARCHIVED → ACTIVE is not a lifecycle edge (409 lists allowed: DRAFT)', async () => {
    const core = productCore({ status: 'ARCHIVED' });
    t.m.product.findFirst.mockResolvedValue(core);
    const res = await request(t.app).patch(url(core.id)).set(headers).send({ status: 'ACTIVE' });
    expect(res.status).toBe(409);
    expect(res.body.error.details[0].meta).toEqual({
      from: 'ARCHIVED',
      to: 'ACTIVE',
      allowed: ['DRAFT'],
    });
  });

  it('re-publishing a SIMPLE INACTIVE product keeps its first publishedAt', async () => {
    const publishedAt = new Date('2026-05-01T00:00:00.000Z');
    const core = productCore({
      status: 'INACTIVE',
      productType: 'SIMPLE',
      publishedAt,
      categoryId: category.id,
      hsnCode: '7117',
    });
    t.m.product.findFirst.mockResolvedValue(core);
    t.m.productVariant.findMany.mockResolvedValue([
      {
        id: 'v',
        sku: 'S',
        status: 'ACTIVE',
        mrp: dec('100'),
        sellingPrice: dec('90'),
        combinationKey: 'DEFAULT',
        deletedAt: null,
        variantValues: [],
      },
    ]);
    t.m.productImage.count.mockResolvedValue(2);
    t.m.hsnCode.findUnique.mockResolvedValue({
      defaultTaxRate: { rate: dec('3'), isActive: true },
    });
    const res = await request(t.app).patch(url(core.id)).set(headers).send({ status: 'ACTIVE' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      id: core.id,
      status: 'ACTIVE',
      publishedAt: publishedAt.toISOString(),
    });
  });

  it('publishing is blocked by a missing required attribute and an inactive category', async () => {
    const attrId = randomUUID();
    const core = productCore({ categoryId: category.id, hsnCode: '7117' });
    t.m.product.findFirst.mockResolvedValue(core);
    t.m.category.findUnique.mockResolvedValue({ ...category, deletedAt: new Date() });
    t.m.categoryAttribute.findMany.mockResolvedValue([requiredRule(attrId, 'Purity')]);
    t.m.productImage.count.mockResolvedValue(1);
    t.m.hsnCode.findUnique.mockResolvedValue({
      defaultTaxRate: { rate: dec('3'), isActive: true },
    });
    const res = await request(t.app).patch(url(core.id)).set(headers).send({ status: 'ACTIVE' });
    expect(res.status).toBe(422);
    const reqs = (res.body.error.details as { meta: { requirement: string } }[]).map(
      (d) => d.meta.requirement,
    );
    expect(reqs).toEqual([
      'ACTIVE_VARIANT_REQUIRED',
      'REQUIRED_ATTRIBUTE_MISSING',
      'CATEGORY_INACTIVE',
    ]);
  });
});

// ------------------------------------------------------------------------------------- check-duplicate
describe('GET /admin/products/check-duplicate — per field', () => {
  const check = (query: Record<string, string>) =>
    request(t.app).get(`${BASE}/check-duplicate`).query(query).set(headers);

  it('name: reports a soft-deleted product in the same category, then availability', async () => {
    const categoryId = randomUUID();
    t.m.product.findFirst.mockResolvedValueOnce({
      id: 'p1',
      name: 'Gold Ring',
      deletedAt: new Date(),
      category: { name: 'Rings' },
    });
    const taken = await check({ field: 'name', value: '  Gold   RING ', categoryId });
    expect(taken.status).toBe(200);
    expect(taken.body.data).toEqual({
      field: 'name',
      value: 'Gold   RING',
      normalized: 'gold ring',
      valid: true,
      available: false,
      conflict: { entity: 'product', id: 'p1', productName: 'Gold Ring', deleted: true },
    });
    expect(t.m.product.findFirst.mock.calls[0]?.[0].where).toMatchObject({
      categoryId,
      nameNormalized: 'gold ring',
    });

    const free = await check({ field: 'name', value: 'Silver Ring', categoryId });
    expect(free.body.data).toMatchObject({ available: true, conflict: null });
  });

  it('slug: slugifies the value, reports conflicts and flags un-sluggable input as invalid', async () => {
    const excludeId = randomUUID();
    t.m.product.findFirst.mockResolvedValueOnce({ id: 'p2', name: 'Tara', deletedAt: null });
    const taken = await check({ field: 'slug', value: 'Tara Ring', excludeId });
    expect(taken.body.data).toMatchObject({
      normalized: 'tara-ring',
      valid: true,
      available: false,
      conflict: { entity: 'product', id: 'p2', productName: 'Tara', deleted: false },
    });
    expect(t.m.product.findFirst.mock.calls[0]?.[0].where).toEqual({
      slug: 'tara-ring',
      id: { not: excludeId },
    });

    const junk = await check({ field: 'slug', value: '!!!' });
    expect(junk.body.data).toMatchObject({ normalized: '', valid: false, available: true });
  });

  it('sku: an invalid code is reported without querying', async () => {
    const res = await check({ field: 'sku', value: 'has space' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      normalized: 'HAS SPACE',
      valid: false,
      available: false,
      conflict: null,
    });
    expect(t.m.productVariant.findMany).not.toHaveBeenCalled();
  });

  it('barcode: a free barcode is available (barcode column queried)', async () => {
    const res = await check({ field: 'barcode', value: '8901234567890' });
    expect(res.body.data).toMatchObject({ valid: true, available: true, conflict: null });
    expect(t.m.productVariant.findMany.mock.calls[0]?.[0].where).toEqual({
      barcode: { in: ['8901234567890'] },
    });
  });
});

/**
 * Admin products through the real Express app — MOCKED DB (Prisma delegates are vi.fn()s; no
 * MySQL). Verifies guards, validation, duplicate pre-checks, transactions (variant + inventory +
 * audit rows written via the tx client), status rules and cost-price visibility.
 */
import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { dec } from '../../../../src/lib/money.js';
import { createProductsModule } from '../../../../src/modules/products/index.js';
import { buildModuleTestApp, type ModuleTestApp } from '../../../helpers/container.js';
import { expectAdminRoutesGuarded } from '../../../helpers/routeTable.js';
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

let t: ModuleTestApp;
let headers: Record<string, string>;
const category = categoryNode();

beforeEach(() => {
  t = buildModuleTestApp([createProductsModule]);
  primeEmptyDb(t.m);
  t.m.category.findUnique.mockResolvedValue(category);
  headers = t.staff({ permissions: ALL }).headers;
});

function auditRows(): Record<string, unknown>[] {
  return t.m.auditLog.create.mock.calls.map(
    (c) => (c[0] as { data: Record<string, unknown> }).data,
  );
}

const simpleBody = {
  productType: 'SIMPLE',
  name: '  Tara   Silver Ring ',
  categoryId: category.id,
  description: '<p onclick="x()">Polished</p><script>alert(1)</script>',
  variant: {
    sku: ' rng-tara-slv ',
    mrp: '1199.00',
    sellingPrice: '999.00',
    costPrice: '420.00',
    weightGrams: '3.200',
    initialStock: 25,
    lowStockThreshold: 5,
  },
};

describe('admin products — guards', () => {
  it('declares a permission guard on every admin route (route-table self-test)', () => {
    const module = createProductsModule(t.container);
    const routes = expectAdminRoutesGuarded(module);
    const find = (m: string, p: string) => routes.find((r) => r.method === m && r.path === p);
    expect(find('POST', '/products')?.permissions).toEqual(['products.create']);
    expect(find('POST', '/products/:productId/variants/generate')?.permissions).toEqual([
      'products.create',
    ]);
    expect(find('PATCH', '/products/:productId/status')?.permissions).toEqual(['products.update']);
    expect(find('DELETE', '/product-variants/:variantId')?.permissions).toEqual([
      'products.delete',
    ]);
    expect(find('PUT', '/products/:productId/images/order')?.permissions).toEqual([
      'products.update',
    ]);
    expect(routes).toHaveLength(16);
  });

  it('rejects anonymous calls (401) and missing permissions (403 + audit)', async () => {
    expect((await request(t.app).get('/api/v1/admin/products')).status).toBe(401);
    const viewer = t.staff({ permissions: ['products.view'] });
    const res = await request(t.app)
      .post('/api/v1/admin/products')
      .set(viewer.headers)
      .send(simpleBody);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PERMISSION_DENIED');
    expect(auditRows()[0]).toMatchObject({ action: 'PERMISSION_DENIED', outcome: 'FAILURE' });
  });
});

describe('POST /admin/products', () => {
  it('creates a SIMPLE product with its default variant and inventory row in one transaction', async () => {
    const res = await request(t.app).post('/api/v1/admin/products').set(headers).send(simpleBody);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      productType: 'SIMPLE',
      name: 'Tara   Silver Ring',
      slug: 'tara-silver-ring',
      status: 'DRAFT',
      variants: [
        {
          sku: 'RNG-TARA-SLV',
          isDefault: true,
          combinationKey: 'DEFAULT',
          mrp: '1199.00',
          sellingPrice: '999.00',
          inventory: { onHand: 0, reserved: 0, available: 0 },
        },
      ],
    });
    const warnings = (res.body.data.warnings as { code: string }[]).map((w) => w.code);
    expect(warnings).toEqual(expect.arrayContaining(['NO_IMAGES', 'INITIAL_STOCK_NOT_APPLIED']));

    expect(t.m.$transaction).toHaveBeenCalledTimes(1);
    const productData = t.m.product.create.mock.calls[0]?.[0].data;
    expect(productData).toMatchObject({ nameNormalized: 'tara silver ring', status: 'DRAFT' });
    expect(productData.description).toBe('<p>Polished</p>');
    const variantData = t.m.productVariant.create.mock.calls[0]?.[0].data;
    expect(variantData).toMatchObject({
      sku: 'RNG-TARA-SLV',
      isDefault: true,
      costPrice: '420.00',
    });
    const inventoryData = t.m.inventory.create.mock.calls[0]?.[0].data;
    expect(inventoryData).toMatchObject({
      quantityOnHand: 0,
      quantityReserved: 0,
      lowStockThreshold: 5,
    });
    expect(t.m.inventoryTransaction.create).not.toHaveBeenCalled(); // stock only via movements
    expect(t.m.product.update).toHaveBeenCalled(); // denormalized listing fields refreshed

    const rows = auditRows();
    expect(rows.map((r) => `${String(r.action)}:${String(r.entityType)}`)).toEqual([
      'CREATE:ProductVariant',
      'CREATE:Product',
    ]);
  });

  it('creates a VARIABLE product with sorted combination keys and one value row per axis', async () => {
    const finish = attribute();
    const size = attribute({ code: 'size', name: 'Size', displayType: 'BUTTON', sortOrder: 1 });
    const gold = attributeValue(finish, 'Gold');
    const small = attributeValue(size, 'Small');
    const medium = attributeValue(size, 'Medium', 1);
    serveAttributes(t.m, [finish, size], [gold, small, medium]);
    const res = await request(t.app)
      .post('/api/v1/admin/products')
      .set(headers)
      .send({
        productType: 'VARIABLE',
        name: 'Meera Kundan Jhumka',
        categoryId: category.id,
        variantAxes: [finish.id, size.id],
        variants: [
          {
            attributeValueIds: [small.id, gold.id],
            sku: 'EAR-MEERA-GLD-S',
            mrp: '1799.00',
            sellingPrice: '1499.00',
          },
          {
            attributeValueIds: [gold.id, medium.id],
            sku: 'EAR-MEERA-GLD-M',
            mrp: '1899.00',
            sellingPrice: '1599.00',
          },
        ],
      });
    expect(res.status).toBe(201);
    const keys = t.m.productVariant.create.mock.calls.map(
      (c) => c[0].data.combinationKey as string,
    );
    expect(keys).toEqual([
      [gold.id, small.id].sort().join('|'),
      [gold.id, medium.id].sort().join('|'),
    ]);
    expect(t.m.productVariant.create.mock.calls[0]?.[0].data.name).toBe('Gold / Small');
    expect(t.m.variantAttributeValue.createMany).toHaveBeenCalledTimes(2);
    expect(t.m.inventory.create).toHaveBeenCalledTimes(2);
  });

  it('rejects a repeated combination in the request (422 DUPLICATE_COMBINATION)', async () => {
    const finish = attribute();
    const gold = attributeValue(finish, 'Gold');
    serveAttributes(t.m, [finish], [gold]);
    const res = await request(t.app)
      .post('/api/v1/admin/products')
      .set(headers)
      .send({
        productType: 'VARIABLE',
        name: 'Duo',
        categoryId: category.id,
        variantAxes: [finish.id],
        variants: [
          { attributeValueIds: [gold.id], sku: 'A-1', mrp: '10', sellingPrice: '9' },
          { attributeValueIds: [gold.id], sku: 'A-2', mrp: '10', sellingPrice: '9' },
        ],
      });
    expect(res.status).toBe(422);
    expect(res.body.error.details[0]).toMatchObject({
      field: 'variants[1].attributeValueIds',
      code: 'DUPLICATE_COMBINATION',
    });
    expect(t.m.$transaction).not.toHaveBeenCalled();
  });

  it('reports name (per category, OQ-04) and SKU conflicts together as 409', async () => {
    t.m.product.findFirst.mockResolvedValueOnce({
      id: 'existing',
      name: 'Tara Silver Ring',
      deletedAt: null,
      category: { name: 'Rings' },
    });
    t.m.productVariant.findMany.mockResolvedValueOnce([
      {
        id: 'v-old',
        sku: 'RNG-TARA-SLV',
        barcode: null,
        deletedAt: new Date(),
        productId: 'p-old',
        product: { name: 'Old Ring' },
      },
    ]);
    const res = await request(t.app).post('/api/v1/admin/products').set(headers).send(simpleBody);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_RESOURCE');
    expect(res.body.error.details).toEqual([
      expect.objectContaining({
        field: 'name',
        meta: expect.objectContaining({ scope: 'CATEGORY' }),
      }),
      expect.objectContaining({
        field: 'variant.sku',
        meta: expect.objectContaining({ existingVariantId: 'v-old', deleted: true }),
      }),
    ]);
    expect(t.m.$transaction).not.toHaveBeenCalled();
  });

  it('validates prices, SKU charset and unknown keys (422)', async () => {
    const res = await request(t.app)
      .post('/api/v1/admin/products')
      .set(headers)
      .send({
        ...simpleBody,
        rogue: true,
        variant: { ...simpleBody.variant, sku: 'RNG TARA', sellingPrice: '1500.00' },
      });
    expect(res.status).toBe(422);
    const fields = (res.body.error.details as { field?: string }[]).map((d) => d.field);
    expect(fields).toEqual(expect.arrayContaining(['variant.sku', 'variant.sellingPrice']));
  });

  it('refuses status ACTIVE at create when publish requirements are not met', async () => {
    const res = await request(t.app)
      .post('/api/v1/admin/products')
      .set(headers)
      .send({ ...simpleBody, status: 'ACTIVE' });
    expect(res.status).toBe(422);
    const requirements = (
      res.body.error.details as { code: string; meta: { requirement: string } }[]
    ).map((d) => `${d.code}:${d.meta.requirement}`);
    expect(requirements).toEqual(
      expect.arrayContaining([
        'PUBLISH_REQUIREMENTS_NOT_MET:IMAGE_REQUIRED',
        'PUBLISH_REQUIREMENTS_NOT_MET:TAX_UNRESOLVED',
      ]),
    );
  });
});

describe('GET /admin/products/check-duplicate', () => {
  it('normalizes SKUs and reports the conflicting variant', async () => {
    t.m.productVariant.findMany.mockResolvedValueOnce([
      {
        id: 'v1',
        sku: 'EAR-1',
        barcode: null,
        deletedAt: null,
        productId: 'p1',
        product: { name: 'Meera' },
      },
    ]);
    const res = await request(t.app)
      .get('/api/v1/admin/products/check-duplicate')
      .query({ field: 'sku', value: ' ear-1 ' })
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      normalized: 'EAR-1',
      available: false,
      conflict: { entity: 'product_variant', id: 'v1', productName: 'Meera', deleted: false },
    });
  });

  it('requires categoryId for field=name', async () => {
    const res = await request(t.app)
      .get('/api/v1/admin/products/check-duplicate')
      .query({ field: 'name', value: 'Gold Ring' })
      .set(headers);
    expect(res.status).toBe(422);
    expect(res.body.error.details[0].field).toBe('categoryId');
  });
});

describe('PATCH /admin/products/:productId/status', () => {
  const id = randomUUID();

  it('blocks publishing with 422 PUBLISH_REQUIREMENTS_NOT_MET', async () => {
    t.m.product.findFirst.mockResolvedValueOnce(productCore({ id, categoryId: category.id }));
    const res = await request(t.app)
      .patch(`/api/v1/admin/products/${id}/status`)
      .set(headers)
      .send({ status: 'ACTIVE' });
    expect(res.status).toBe(422);
    const reqs = (res.body.error.details as { meta: { requirement: string } }[]).map(
      (d) => d.meta.requirement,
    );
    expect(reqs).toEqual(['ACTIVE_VARIANT_REQUIRED', 'IMAGE_REQUIRED', 'TAX_UNRESOLVED']);
    expect(t.m.product.update).not.toHaveBeenCalled();
  });

  it('publishes when the gate passes, sets publishedAt once and audits STATUS_CHANGE', async () => {
    t.m.product.findFirst.mockResolvedValueOnce(
      productCore({ id, categoryId: category.id, hsnCode: '7117' }),
    );
    t.m.productVariant.findMany.mockResolvedValueOnce([
      {
        id: 'v',
        sku: 'S',
        status: 'ACTIVE',
        mrp: dec('100'),
        sellingPrice: dec('90'),
        combinationKey: 'k',
        deletedAt: null,
        variantValues: [],
      },
    ]);
    t.m.productImage.count.mockResolvedValueOnce(1);
    t.m.hsnCode.findUnique.mockResolvedValueOnce({
      defaultTaxRate: { rate: dec('3'), isActive: true },
    });
    const res = await request(t.app)
      .patch(`/api/v1/admin/products/${id}/status`)
      .set(headers)
      .send({ status: 'ACTIVE', reason: 'Launch' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id, status: 'ACTIVE', publishedAt: t.now.value.toISOString() });
    expect(t.m.product.update.mock.calls[0]?.[0].data).toMatchObject({ status: 'ACTIVE' });
    expect(auditRows().at(-1)).toMatchObject({
      action: 'STATUS_CHANGE',
      entityType: 'Product',
      entityId: id,
      reason: 'Launch',
    });
  });

  it('rejects transitions outside the lifecycle (409 INVALID_STATE_TRANSITION)', async () => {
    t.m.product.findFirst.mockResolvedValueOnce(productCore({ id, status: 'ACTIVE' }));
    const res = await request(t.app)
      .patch(`/api/v1/admin/products/${id}/status`)
      .set(headers)
      .send({ status: 'DRAFT' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect(res.body.error.details[0].meta.allowed).toEqual(['INACTIVE', 'ARCHIVED']);
  });
});

describe('GET/DELETE /admin/products/:productId', () => {
  it('shows costPrice only to staff with products.update or reports.view', async () => {
    const row = productAdminRow();
    t.m.product.findFirst.mockResolvedValue(row);
    const viewer = t.staff({ permissions: ['products.view'] });
    const hidden = await request(t.app).get(`/api/v1/admin/products/${row.id}`).set(viewer.headers);
    expect(hidden.status).toBe(200);
    expect(hidden.body.data.variants[0]).not.toHaveProperty('costPrice');
    expect(hidden.body.data.variants[0].inventory).toEqual({
      onHand: 10,
      reserved: 2,
      available: 8,
      lowStockThreshold: null,
    });
    const editor = await request(t.app).get(`/api/v1/admin/products/${row.id}`).set(headers);
    expect(editor.body.data.variants[0].costPrice).toBe('620.00');
    expect(editor.body.data.variants[0].weightGrams).toBe('4.250');
  });

  it('returns 404 for unknown/deleted products', async () => {
    const res = await request(t.app).get(`/api/v1/admin/products/${randomUUID()}`).set(headers);
    expect(res.status).toBe(404);
  });

  it('soft-deletes the product and its variants (status ARCHIVED) with an audit row', async () => {
    const core = productCore();
    t.m.product.findFirst.mockResolvedValueOnce(core);
    const res = await request(t.app).delete(`/api/v1/admin/products/${core.id}`).set(headers);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: core.id, deleted: true });
    expect(t.m.product.update.mock.calls[0]?.[0].data).toMatchObject({
      status: 'ARCHIVED',
      deletedAt: t.now.value,
    });
    expect(t.m.productVariant.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { productId: core.id, deletedAt: null },
    });
    expect(t.m.product.delete).not.toHaveBeenCalled();
    expect(auditRows().at(-1)).toMatchObject({ action: 'DELETE', entityType: 'Product' });
  });

  it('blocks delete while variants hold active reservations', async () => {
    const core = productCore();
    t.m.product.findFirst.mockResolvedValueOnce(core);
    t.m.stockReservation.count.mockResolvedValueOnce(2);
    const res = await request(t.app).delete(`/api/v1/admin/products/${core.id}`).set(headers);
    expect(res.status).toBe(409);
    expect(res.body.error.details[0].code).toBe('ACTIVE_RESERVATIONS');
  });
});

describe('PATCH /admin/products/:productId', () => {
  it('rejects a stale write (409 STALE_WRITE)', async () => {
    const row = productAdminRow();
    t.m.product.findFirst.mockResolvedValueOnce(row);
    const res = await request(t.app)
      .patch(`/api/v1/admin/products/${row.id}`)
      .set(headers)
      .send({ shortDescription: 'x', expectedUpdatedAt: '2020-01-01T00:00:00.000Z' });
    expect(res.status).toBe(409);
    expect(res.body.error.details[0].code).toBe('STALE_WRITE');
  });

  it('updates fields, writes an UPDATE audit diff and returns the fresh detail', async () => {
    const row = productAdminRow();
    t.m.product.findFirst.mockResolvedValue(row);
    const res = await request(t.app)
      .patch(`/api/v1/admin/products/${row.id}`)
      .set(headers)
      .send({ shortDescription: 'Hand-set kundan', isFeatured: true });
    expect(res.status).toBe(200);
    expect(t.m.product.update.mock.calls[0]?.[0].data).toMatchObject({
      shortDescription: 'Hand-set kundan',
      isFeatured: true,
    });
    const audit = auditRows().at(-1);
    expect(audit).toMatchObject({ action: 'UPDATE', entityType: 'Product' });
    expect(audit?.newValues).toMatchObject({
      shortDescription: 'Hand-set kundan',
      isFeatured: true,
    });
  });
});

describe('Phase 4 catalogue gaps — product name uniqueness', () => {
  it('TC-017: case/whitespace variants of a name in the same category are a 409 duplicate', async () => {
    const existing = {
      id: randomUUID(),
      name: 'Tara Silver Ring',
      deletedAt: null,
      category: { name: 'Rings' },
    };
    // Simulates the per-category unique key on (category_id, name_normalized).
    t.m.product.findFirst.mockImplementation(
      (args: { where: { categoryId?: string; nameNormalized?: string } }) =>
        Promise.resolve(
          args.where.categoryId === category.id && args.where.nameNormalized === 'tara silver ring'
            ? existing
            : null,
        ),
    );
    for (const name of ['TARA SILVER RING', '  tara   silver   ring  ', 'Tara\tSilver\nRing']) {
      const res = await request(t.app)
        .post('/api/v1/admin/products')
        .set(headers)
        .send({ ...simpleBody, name });
      expect(res.status, name).toBe(409);
      expect(res.body.error.code).toBe('DUPLICATE_RESOURCE');
      expect(res.body.error.details).toEqual([
        expect.objectContaining({
          field: 'name',
          meta: expect.objectContaining({ scope: 'CATEGORY' }),
        }),
      ]);
    }
    const lookups = t.m.product.findFirst.mock.calls
      .map((c) => (c[0] as { where: Record<string, unknown> }).where)
      .filter((w) => 'nameNormalized' in w);
    expect(lookups).toHaveLength(3);
    for (const w of lookups) {
      expect(w).toMatchObject({ categoryId: category.id, nameNormalized: 'tara silver ring' });
    }
    expect(t.m.$transaction).not.toHaveBeenCalled();
  });
});

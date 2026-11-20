/**
 * Variants — edge cases through the real Express app. MOCKED DB (Prisma delegates are vi.fn()s
 * from tests/helpers/mockDb.ts; no MySQL). Covers listing, the first-variant axis rule, add/update
 * duplicate checks, partial updates, delete guards, and generate preview/commit validation.
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
  primeEmptyDb,
  productCore,
  serveAttributes,
  variantAdminRow,
  type ValueFixture,
} from './fixtures.js';

let t: ModuleTestApp;
let headers: Record<string, string>;
const finish = attribute();
const size = attribute({ code: 'size', name: 'Size', displayType: 'BUTTON', sortOrder: 1 });
let gold: ValueFixture;
let rose: ValueFixture;
let small: ValueFixture;
let medium: ValueFixture;
const product = productCore();

beforeEach(() => {
  t = buildModuleTestApp([createProductsModule]);
  primeEmptyDb(t.m);
  headers = t.staff({
    permissions: ['products.view', 'products.create', 'products.update', 'products.delete'],
  }).headers;
  gold = attributeValue(finish, 'Gold');
  rose = attributeValue(finish, 'Rose Gold', 1);
  small = attributeValue(size, 'Small');
  medium = attributeValue(size, 'Medium', 1);
  serveAttributes(t.m, [finish, size], [gold, rose, small, medium]);
  t.m.product.findFirst.mockResolvedValue(product);
});

const key = (...ids: string[]) => [...ids].sort().join('|');

interface ExistingRow {
  id: string;
  sku: string;
  status: string;
  combinationKey: string;
  deletedAt: Date | null;
  variantValues: { attributeId: string; attributeValueId: string }[];
}

function existing(values: ValueFixture[], over: Partial<ExistingRow> = {}): ExistingRow {
  return {
    id: randomUUID(),
    sku: `OLD-${String(Math.random()).slice(2, 8)}`,
    status: 'ACTIVE',
    combinationKey: key(...values.map((v) => v.id)),
    deletedAt: null,
    variantValues: values.map((v) => ({ attributeId: v.attributeId, attributeValueId: v.id })),
    ...over,
  };
}

interface VariantFindManyArgs {
  where: {
    sku?: { in?: string[] };
    barcode?: { in?: string[] };
    productId?: string;
    status?: string;
  };
}

/**
 * Routes `productVariant.findMany`: SKU/barcode conflict lookups get `codeHits` (filtered by the
 * queried values), everything else (variantsWithValues / listVariants) gets `rows`.
 */
function serveVariants(
  rows: unknown[],
  codeHits: { sku?: string; barcode?: string | null; id: string; deletedAt?: Date | null }[] = [],
): void {
  t.m.productVariant.findMany.mockImplementation((args: VariantFindManyArgs) => {
    const skuIn = args.where.sku?.in;
    const barcodeIn = args.where.barcode?.in;
    if (skuIn !== undefined || barcodeIn !== undefined) {
      return Promise.resolve(
        codeHits
          .filter((h) =>
            skuIn !== undefined
              ? h.sku !== undefined && skuIn.includes(h.sku)
              : h.barcode != null && (barcodeIn ?? []).includes(h.barcode),
          )
          .map((h) => ({
            sku: null,
            barcode: null,
            deletedAt: null,
            productId: 'p-other',
            product: { name: 'Other Product' },
            ...h,
          })),
      );
    }
    // refreshListingFields (ACTIVE-only price/stock read) → nothing sellable in these tests.
    if (args.where.status === 'ACTIVE') return Promise.resolve([]);
    return Promise.resolve(rows);
  });
}

// ------------------------------------------------------------------------------------- list
describe('GET /admin/products/:productId/variants', () => {
  it('404s an unknown product', async () => {
    t.m.product.findFirst.mockResolvedValue(null);
    const res = await request(t.app)
      .get(`/api/v1/admin/products/${randomUUID()}/variants`)
      .set(headers);
    expect(res.status).toBe(404);
  });

  it('lists variants with cost price for editors and without it for viewers', async () => {
    serveVariants([variantAdminRow({ productId: product.id })]);
    const editor = await request(t.app)
      .get(`/api/v1/admin/products/${product.id}/variants`)
      .set(headers);
    expect(editor.status).toBe(200);
    expect(editor.body.data[0]).toMatchObject({ sku: 'EAR-MEERA-GLD-S', costPrice: '620.00' });
    const viewer = t.staff({ permissions: ['products.view'] }).headers;
    const hidden = await request(t.app)
      .get(`/api/v1/admin/products/${product.id}/variants`)
      .set(viewer);
    expect(hidden.body.data[0]).not.toHaveProperty('costPrice');
  });
});

// ------------------------------------------------------------------------------------- add
describe('POST /admin/products/:productId/variants', () => {
  const url = () => `/api/v1/admin/products/${product.id}/variants`;
  const body = (extra: Record<string, unknown> = {}) => ({
    attributeValueIds: [gold.id, small.id],
    sku: 'EAR-NEW-1',
    mrp: '100.00',
    sellingPrice: '90.00',
    ...extra,
  });

  it('404s an unknown product', async () => {
    t.m.product.findFirst.mockResolvedValue(null);
    const res = await request(t.app).post(url()).set(headers).send(body());
    expect(res.status).toBe(404);
  });

  it('refuses a 201st live variant (422 TOO_MANY_VARIANTS)', async () => {
    const rows = Array.from({ length: 200 }, (_, i) =>
      existing([], { combinationKey: `k${String(i)}` }),
    );
    // Deleted variants do not count towards the cap.
    rows.push(existing([], { combinationKey: 'gone', deletedAt: new Date() }));
    serveVariants(rows);
    const res = await request(t.app).post(url()).set(headers).send(body());
    expect(res.status).toBe(422);
    expect(res.body.error.details[0]).toMatchObject({
      code: 'TOO_MANY_VARIANTS',
      meta: { current: 200 },
    });
  });

  it('the first variant defines the axes; opening stock is only a warning', async () => {
    serveVariants([]);
    const res = await request(t.app)
      .post(url())
      .set(headers)
      .send(body({ initialStock: 5 }));
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      name: 'Gold / Small',
      combinationKey: key(gold.id, small.id),
      warnings: [expect.objectContaining({ code: 'INITIAL_STOCK_NOT_APPLIED' })],
    });
    expect(t.m.productVariant.create.mock.calls[0]?.[0].data).toMatchObject({ sortOrder: 0 });
    expect(t.m.variantAttributeValue.createMany.mock.calls[0]?.[0].data).toHaveLength(2);
  });

  it('a first variant using a non-axis attribute is rejected (422 NOT_A_VARIANT_AXIS)', async () => {
    const material = attribute({ code: 'material', name: 'Material', isVariantAxis: false });
    const brass = attributeValue(material, 'Brass');
    serveAttributes(t.m, [material], [brass]);
    serveVariants([]);
    const res = await request(t.app)
      .post(url())
      .set(headers)
      .send(body({ attributeValueIds: [brass.id] }));
    expect(res.status).toBe(422);
    expect(res.body.error.details[0]).toMatchObject({
      field: 'attributeValueIds',
      code: 'NOT_A_VARIANT_AXIS',
    });
    expect(t.m.$transaction).not.toHaveBeenCalled();
  });

  it('a combination held by a deleted variant suggests restoring it (409)', async () => {
    const gone = existing([gold, small], { deletedAt: new Date() });
    serveVariants([gone]);
    const res = await request(t.app).post(url()).set(headers).send(body());
    expect(res.status).toBe(409);
    expect(res.body.error.details[0]).toMatchObject({
      code: 'DUPLICATE_COMBINATION',
      message: 'Combination "Gold / Small" already exists (deleted variant — restore it instead).',
      meta: { existingVariantId: gone.id, deleted: true },
    });
  });

  it('a SKU or barcode already used elsewhere is a 409 naming the field', async () => {
    serveVariants(
      [existing([rose, medium])],
      [
        { id: 'v-sku', sku: 'EAR-NEW-1' },
        { id: 'v-bc', barcode: '890123' },
      ],
    );
    const res = await request(t.app)
      .post(url())
      .set(headers)
      .send(body({ barcode: '890123' }));
    expect(res.status).toBe(409);
    expect((res.body.error.details as { field: string }[]).map((d) => d.field)).toEqual([
      'variant.sku',
      'variant.barcode',
    ]);
    expect(t.m.productVariant.create).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------------------------- update
describe('PATCH /admin/product-variants/:variantId', () => {
  const variant = (over: Record<string, unknown> = {}) => ({
    ...variantAdminRow({ productId: product.id, ...over }),
    product: { id: product.id, productType: 'VARIABLE', status: 'ACTIVE', name: product.name },
  });
  const url = (id: string) => `/api/v1/admin/product-variants/${id}`;

  it('404s an unknown variant', async () => {
    const res = await request(t.app)
      .patch(url(randomUUID()))
      .set(headers)
      .send({ status: 'INACTIVE' });
    expect(res.status).toBe(404);
  });

  it('validates the stored compare-at price against a new selling price', async () => {
    const v = variant({ compareAtPrice: dec('1500.00') });
    t.m.productVariant.findFirst.mockResolvedValue(v);
    const res = await request(t.app)
      .patch(url(v.id))
      .set(headers)
      .send({ sellingPrice: '1599.00' });
    expect(res.status).toBe(422);
    expect(res.body.error.details).toEqual([expect.objectContaining({ field: 'compareAtPrice' })]);
  });

  it('validates a new compare-at price against the stored selling price', async () => {
    const v = variant();
    t.m.productVariant.findFirst.mockResolvedValue(v);
    const res = await request(t.app)
      .patch(url(v.id))
      .set(headers)
      .send({ compareAtPrice: '100.00' });
    expect(res.status).toBe(422);
    expect(res.body.error.details[0].field).toBe('compareAtPrice');
  });

  it('reports both a taken SKU and a taken barcode (409; deleted owner flagged)', async () => {
    const v = variant();
    t.m.productVariant.findFirst.mockResolvedValue(v);
    serveVariants(
      [],
      [
        { id: 'v-sku', sku: 'EAR-TAKEN', deletedAt: new Date() },
        { id: 'v-bc', barcode: 'BC-TAKEN' },
      ],
    );
    const res = await request(t.app)
      .patch(url(v.id))
      .set(headers)
      .send({ sku: 'ear-taken', barcode: 'bc-taken' });
    expect(res.status).toBe(409);
    expect(res.body.error.details).toEqual([
      expect.objectContaining({
        field: 'sku',
        message: 'SKU EAR-TAKEN is already used.',
        meta: { existingVariantId: 'v-sku', productName: 'Other Product', deleted: true },
      }),
      expect.objectContaining({
        field: 'barcode',
        message: 'Barcode BC-TAKEN is already used.',
        meta: expect.objectContaining({ deleted: false }),
      }),
    ]);
    // Conflict lookups exclude the variant itself.
    expect(t.m.productVariant.findMany.mock.calls[0]?.[0].where.id).toEqual({ not: v.id });
  });

  it('writes every provided field, refreshes listing fields and audits the diff', async () => {
    const v = variant({ barcode: 'OLD-BC' });
    t.m.productVariant.findFirst.mockResolvedValue(v);
    serveVariants([]);
    const res = await request(t.app).patch(url(v.id)).set(headers).send({
      sku: 'EAR-FRESH',
      barcode: null,
      mrp: '2000.00',
      sellingPrice: '1800.00',
      compareAtPrice: null,
      costPrice: '700.00',
      weightGrams: '5.000',
      lengthMm: 10,
      widthMm: 11,
      heightMm: 12,
      status: 'INACTIVE',
      sortOrder: 3,
    });
    expect(res.status).toBe(200);
    expect(t.m.productVariant.update.mock.calls[0]?.[0].data).toMatchObject({
      sku: 'EAR-FRESH',
      barcode: null,
      mrp: '2000.00',
      sellingPrice: '1800.00',
      compareAtPrice: null,
      costPrice: '700.00',
      weightGrams: '5.000',
      lengthMm: 10,
      widthMm: 11,
      heightMm: 12,
      status: 'INACTIVE',
      sortOrder: 3,
    });
    // Only the SKU was checked: a cleared barcode needs no conflict lookup.
    const queried = t.m.productVariant.findMany.mock.calls.map(
      (c) => Object.keys((c[0] as VariantFindManyArgs).where)[0],
    );
    expect(queried).toContain('sku');
    expect(queried).not.toContain('barcode');
    expect(t.m.product.update).toHaveBeenCalled(); // listing fields refreshed
    expect(t.m.auditLog.create.mock.calls.at(-1)?.[0].data).toMatchObject({
      action: 'UPDATE',
      entityType: 'ProductVariant',
    });
  });

  it('a cost-only change does not refresh listing fields', async () => {
    const v = variant();
    t.m.productVariant.findFirst.mockResolvedValue(v);
    const res = await request(t.app).patch(url(v.id)).set(headers).send({ costPrice: '650.00' });
    expect(res.status).toBe(200);
    expect(t.m.product.update).not.toHaveBeenCalled();
    expect(t.m.orderItem.count).not.toHaveBeenCalled(); // SKU unchanged → no history lookup
  });

  it('404s when the variant disappears before the fresh read', async () => {
    const v = variant();
    t.m.productVariant.findFirst.mockResolvedValueOnce(v).mockResolvedValueOnce(null);
    const res = await request(t.app).patch(url(v.id)).set(headers).send({ sortOrder: 1 });
    expect(res.status).toBe(404);
  });
});

// ------------------------------------------------------------------------------------- delete
describe('DELETE /admin/product-variants/:variantId — guards', () => {
  const url = (id: string) => `/api/v1/admin/product-variants/${id}`;
  const variant = (
    over: Record<string, unknown> = {},
    productOver: Record<string, unknown> = {},
  ) => ({
    ...variantAdminRow({ productId: product.id, ...over }),
    product: {
      id: product.id,
      productType: 'VARIABLE',
      status: 'ACTIVE',
      name: product.name,
      ...productOver,
    },
  });

  it('404s an unknown variant', async () => {
    const res = await request(t.app).delete(url(randomUUID())).set(headers);
    expect(res.status).toBe(404);
  });

  it.each([
    ['the default variant', { isDefault: true }, {}],
    ['the variant of a SIMPLE product', {}, { productType: 'SIMPLE' }],
  ])('refuses to delete %s (409 DEFAULT_VARIANT)', async (_label, over, productOver) => {
    const v = variant(over, productOver);
    t.m.productVariant.findFirst.mockResolvedValue(v);
    const res = await request(t.app).delete(url(v.id)).set(headers);
    expect(res.status).toBe(409);
    expect(res.body.error.details[0].code).toBe('DEFAULT_VARIANT');
  });

  it('refuses to delete the last ACTIVE variant of an ACTIVE product', async () => {
    const v = variant();
    t.m.productVariant.findFirst.mockResolvedValue(v);
    serveVariants([
      { id: v.id, status: 'ACTIVE' },
      { id: 'other', status: 'INACTIVE' },
    ]);
    const res = await request(t.app).delete(url(v.id)).set(headers);
    expect(res.status).toBe(409);
    expect(res.body.error.details[0].code).toBe('LAST_ACTIVE_VARIANT');
  });

  it('allows it when the product itself is not ACTIVE', async () => {
    const v = variant({}, { status: 'INACTIVE' });
    t.m.productVariant.findFirst.mockResolvedValue(v);
    serveVariants([
      { id: v.id, status: 'ACTIVE' },
      { id: 'other', status: 'INACTIVE' },
    ]);
    const res = await request(t.app).delete(url(v.id)).set(headers);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: v.id, deleted: true });
  });
});

// ------------------------------------------------------------------------------------- generate
describe('POST …/variants/generate — validation', () => {
  const url = (mode: string, id = product.id) =>
    `/api/v1/admin/products/${id}/variants/generate?mode=${mode}`;
  const body = (extra: Record<string, unknown> = {}) => ({
    axes: [
      { attributeId: finish.id, valueIds: [gold.id, rose.id] },
      { attributeId: size.id, valueIds: [small.id, medium.id] },
    ],
    defaults: { mrp: '1899.00', sellingPrice: '1599.00' },
    skuBase: 'EAR',
    ...extra,
  });

  it('404s an unknown product', async () => {
    t.m.product.findFirst.mockResolvedValue(null);
    const res = await request(t.app).post(url('preview', randomUUID())).set(headers).send(body());
    expect(res.status).toBe(404);
  });

  it('flags unknown values, axis mismatches and too many combinations together', async () => {
    serveVariants([existing([gold])]); // product currently varies by finish only
    const many = (n: number) => Array.from({ length: n }, () => randomUUID());
    const res = await request(t.app)
      .post(url('preview'))
      .set(headers)
      .send(
        body({
          axes: [
            { attributeId: finish.id, valueIds: [gold.id, ...many(10)] },
            { attributeId: size.id, valueIds: [small.id, ...many(9)] },
          ],
        }),
      );
    expect(res.status).toBe(422);
    const codes = new Set((res.body.error.details as { code: string }[]).map((d) => d.code));
    expect([...codes].sort()).toEqual([
      'ATTRIBUTE_VALUE_NOT_FOUND',
      'AXIS_MISMATCH',
      'TOO_MANY_COMBINATIONS',
    ]);
    const mismatch = (res.body.error.details as { code: string; meta?: unknown }[]).find(
      (d) => d.code === 'AXIS_MISMATCH',
    );
    expect(mismatch?.meta).toEqual({ existingAxes: [finish.id] });
  });

  it('rejects overrides for unknown or already-existing combinations', async () => {
    serveVariants([existing([gold, small])]);
    const res = await request(t.app)
      .post(url('preview'))
      .set(headers)
      .send(
        body({
          overrides: [
            { combinationKey: 'not-a-combination', sku: 'X-1' },
            { combinationKey: key(gold.id, small.id), sku: 'X-2' },
          ],
        }),
      );
    expect(res.status).toBe(422);
    expect(res.body.error.details).toEqual([
      expect.objectContaining({
        field: 'overrides[0].combinationKey',
        code: 'UNKNOWN_COMBINATION',
      }),
      expect.objectContaining({
        field: 'overrides[1].combinationKey',
        code: 'COMBINATION_EXISTS',
      }),
    ]);
  });

  it.each([
    ['{BASE} without skuBase', { skuBase: undefined, skuPattern: '{BASE}-{axis1}' }, 'skuBase'],
    ['an unknown token', { skuPattern: '{colour}-{axis2}' }, 'skuPattern'],
  ])('rejects a SKU pattern with %s (422 SKU_PATTERN_INVALID)', async (_l, extra, field) => {
    serveVariants([]);
    const res = await request(t.app).post(url('preview')).set(headers).send(body(extra));
    expect(res.status).toBe(422);
    expect(res.body.error.details[0]).toMatchObject({ field, code: 'SKU_PATTERN_INVALID' });
  });

  it('preview: default pattern, deleted combinations, SKU conflicts and price overrides', async () => {
    const deleted = existing([gold, small], { deletedAt: new Date(), status: 'INACTIVE' });
    serveVariants([deleted], [{ id: 'v-x', sku: 'EAR-ROSEGO-SMALL', deletedAt: new Date() }]);
    const res = await request(t.app)
      .post(url('preview'))
      .set(headers)
      .send(
        body({
          overrides: [
            { combinationKey: key(gold.id, medium.id), mrp: '2100.00', sellingPrice: '1999.00' },
          ],
        }),
      );
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data).toMatchObject({ totalCombinations: 4, toCreate: 3, existing: 1, conflicts: 1 });
    const byKey = new Map(
      (data.combinations as { combinationKey: string }[]).map((c) => [c.combinationKey, c]),
    );
    expect(byKey.get(key(gold.id, small.id))).toMatchObject({
      status: 'EXISTS_DELETED',
      existingVariantId: deleted.id,
      existingVariantStatus: 'INACTIVE',
      sku: deleted.sku,
    });
    expect(byKey.get(key(rose.id, small.id))).toMatchObject({
      proposedSku: 'EAR-ROSEGO-SMALL',
      skuValid: true,
      skuAvailable: false,
      skuConflict: { variantId: 'v-x', productName: 'Other Product', deleted: true },
    });
    expect(byKey.get(key(gold.id, medium.id))).toMatchObject({
      proposedSku: 'EAR-GOLD-MEDIUM',
      mrp: '2100.00',
      sellingPrice: '1999.00',
      skip: false,
    });
  });

  async function previewToken(extra: Record<string, unknown> = {}): Promise<string> {
    const res = await request(t.app).post(url('preview')).set(headers).send(body(extra));
    expect(res.status).toBe(200);
    return res.body.data.previewToken as string;
  }

  it('commit: a pattern yielding one SKU for all rows and a price override above MRP → 422', async () => {
    serveVariants([]);
    const token = await previewToken({ skuPattern: '{BASE}' });
    const res = await request(t.app)
      .post(url('commit'))
      .set(headers)
      .send(
        body({
          skuPattern: '{BASE}',
          previewToken: token,
          overrides: [
            { combinationKey: key(gold.id, small.id), sku: 'EAR-GS' },
            { combinationKey: key(rose.id, small.id), sellingPrice: '5000.00' },
          ],
        }),
      );
    expect(res.status).toBe(422);
    const details = res.body.error.details as { field: string; code?: string }[];
    expect(details.filter((d) => d.code === 'DUPLICATE_SKU_IN_REQUEST')).toHaveLength(3);
    expect(details.some((d) => d.field.endsWith('.sellingPrice'))).toBe(true);
    expect(t.m.$transaction).not.toHaveBeenCalled();
  });

  it('commit: proposed SKUs longer than 32 characters must be overridden (422 SKU_INVALID)', async () => {
    serveVariants([]);
    const extra = { skuBase: 'ABCDEFGHIJKLMNOP', skuPattern: '{BASE}-{BASE}-{axis1}' };
    const token = await previewToken(extra);
    const res = await request(t.app)
      .post(url('commit'))
      .set(headers)
      .send(body({ ...extra, previewToken: token }));
    expect(res.status).toBe(422);
    expect(
      (res.body.error.details as { code: string }[]).every((d) => d.code === 'SKU_INVALID'),
    ).toBe(true);
  });

  it('commit: exceeding 200 live variants is refused (422 TOO_MANY_VARIANTS)', async () => {
    serveVariants(
      Array.from({ length: 199 }, (_, i) => existing([], { combinationKey: `k${String(i)}` })),
    );
    const preview = await request(t.app).post(url('preview')).set(headers).send(body());
    expect(preview.body.data.maxVariantsExceeded).toBe(true);
    const res = await request(t.app)
      .post(url('commit'))
      .set(headers)
      .send(body({ previewToken: preview.body.data.previewToken as string }));
    expect(res.status).toBe(422);
    expect(res.body.error.details[0]).toMatchObject({
      code: 'TOO_MANY_VARIANTS',
      meta: { current: 199, toCreate: 4 },
    });
  });

  it('commit: without stock overrides there are no warnings and sort orders follow live count', async () => {
    serveVariants([existing([gold, small])]);
    const token = await previewToken();
    const res = await request(t.app)
      .post(url('commit'))
      .set(headers)
      .send(body({ previewToken: token }));
    expect(res.status).toBe(201);
    expect(res.body.data.warnings).toEqual([]);
    expect(res.body.data.created).toHaveLength(3);
    expect(t.m.productVariant.create.mock.calls.map((c) => c[0].data.sortOrder as number)).toEqual([
      1, 2, 3,
    ]);
  });
});

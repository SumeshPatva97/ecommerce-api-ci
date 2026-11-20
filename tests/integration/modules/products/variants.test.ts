/**
 * Variants: generate preview/commit, add, update, delete — MOCKED DB (no MySQL). Verifies that
 * preview writes nothing, commit is one transaction with variant + values + inventory rows and
 * audit rows, a racing unique violation becomes 409 naming the combination, and the deletion
 * guards.
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

function existingGoldSmall() {
  return {
    id: 'v-gold-s',
    sku: 'EAR-MEERA-GOLD-SMALL',
    status: 'ACTIVE',
    mrp: dec('1899'),
    sellingPrice: dec('1599'),
    combinationKey: key(gold.id, small.id),
    deletedAt: null,
    inventory: null,
    variantValues: [
      { attributeId: finish.id, attributeValueId: gold.id },
      { attributeId: size.id, attributeValueId: small.id },
    ],
  };
}

function generateBody(extra: Record<string, unknown> = {}) {
  return {
    axes: [
      { attributeId: finish.id, valueIds: [gold.id, rose.id] },
      { attributeId: size.id, valueIds: [small.id, medium.id] },
    ],
    defaults: { mrp: '1899.00', sellingPrice: '1599.00', status: 'ACTIVE' },
    skuBase: 'EAR-MEERA',
    skuPattern: '{BASE}-{metal-finish}-{size}',
    ...extra,
  };
}

const url = (mode: string) => `/api/v1/admin/products/${product.id}/variants/generate?mode=${mode}`;

async function preview(): Promise<request.Response> {
  t.m.productVariant.findMany.mockResolvedValue([existingGoldSmall()]);
  return request(t.app).post(url('preview')).set(headers).send(generateBody());
}

describe('POST …/variants/generate?mode=preview', () => {
  it('returns combinations with EXISTS/NEW status and proposed SKUs without writing', async () => {
    const res = await preview();
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data).toMatchObject({ mode: 'preview', totalCombinations: 4, toCreate: 3, existing: 1 });
    expect(data.previewToken).toMatch(/^pvw_/);
    const byKey = new Map(
      (data.combinations as { combinationKey: string }[]).map((c) => [c.combinationKey, c]),
    );
    expect(byKey.get(key(gold.id, small.id))).toMatchObject({
      status: 'EXISTS',
      existingVariantId: 'v-gold-s',
      label: 'Gold / Small',
    });
    expect(byKey.get(key(rose.id, medium.id))).toMatchObject({
      status: 'NEW',
      label: 'Rose Gold / Medium',
      proposedSku: 'EAR-MEERA-ROSEGO-MEDIUM',
      skuAvailable: true,
      mrp: '1899.00',
    });
    expect(t.m.$transaction).not.toHaveBeenCalled();
    expect(t.m.productVariant.create).not.toHaveBeenCalled();
    expect(t.m.auditLog.create).not.toHaveBeenCalled();
  });

  it('rejects non-axis attributes and values from another attribute (422)', async () => {
    const material = attribute({ code: 'material', name: 'Material', isVariantAxis: false });
    const brass = attributeValue(material, 'Brass');
    serveAttributes(t.m, [finish, size, material], [gold, small, brass]);
    const res = await request(t.app)
      .post(url('preview'))
      .set(headers)
      .send(
        generateBody({
          axes: [
            { attributeId: material.id, valueIds: [brass.id] },
            { attributeId: size.id, valueIds: [gold.id] },
          ],
        }),
      );
    expect(res.status).toBe(422);
    const codes = (res.body.error.details as { code: string }[]).map((d) => d.code);
    expect(codes).toEqual(expect.arrayContaining(['NOT_A_VARIANT_AXIS', 'VALUE_NOT_IN_AXIS']));
  });

  it('refuses generation on a SIMPLE product (409 SIMPLE_PRODUCT_SINGLE_VARIANT)', async () => {
    t.m.product.findFirst.mockResolvedValue({ ...product, productType: 'SIMPLE' });
    const res = await request(t.app).post(url('preview')).set(headers).send(generateBody());
    expect(res.status).toBe(409);
    expect(res.body.error.details[0].code).toBe('SIMPLE_PRODUCT_SINGLE_VARIANT');
  });
});

describe('POST …/variants/generate?mode=commit', () => {
  it('creates all NEW combinations atomically (variants + values + inventory + audit)', async () => {
    const token = (await preview()).body.data.previewToken as string;
    const res = await request(t.app)
      .post(url('commit'))
      .set(headers)
      .send(
        generateBody({
          previewToken: token,
          overrides: [
            { combinationKey: key(rose.id, small.id), sku: 'EAR-MEERA-RSG-S', initialStock: 4 },
            { combinationKey: key(gold.id, medium.id), skip: true },
          ],
        }),
      );
    expect(res.status).toBe(201);
    expect(res.body.data.mode).toBe('commit');
    const created = res.body.data.created as { sku: string; combinationKey: string }[];
    expect(created.map((c) => c.sku).sort()).toEqual([
      'EAR-MEERA-ROSEGO-MEDIUM',
      'EAR-MEERA-RSG-S',
    ]);
    const skipped = res.body.data.skipped as { reason: string }[];
    expect(skipped.map((s) => s.reason).sort()).toEqual(['EXISTS', 'SKIPPED']);
    expect(res.body.data.warnings[0].code).toBe('INITIAL_STOCK_NOT_APPLIED');

    expect(t.m.$transaction).toHaveBeenCalledTimes(1);
    expect(t.m.productVariant.create).toHaveBeenCalledTimes(2);
    expect(t.m.variantAttributeValue.createMany).toHaveBeenCalledTimes(2);
    expect(t.m.inventory.create).toHaveBeenCalledTimes(2);
    const audit = t.m.auditLog.create.mock.calls.map((c) => c[0].data as Record<string, unknown>);
    expect(
      audit.filter((a) => a.entityType === 'ProductVariant' && a.action === 'CREATE'),
    ).toHaveLength(2);
    expect(audit.at(-1)).toMatchObject({ action: 'UPDATE', entityType: 'Product' });

    // The token is single-use.
    const again = await request(t.app)
      .post(url('commit'))
      .set(headers)
      .send(generateBody({ previewToken: token }));
    expect(again.status).toBe(409);
    expect(again.body.error.details[0].code).toBe('PREVIEW_STALE');
  });

  it('rejects a commit whose inputs differ from the preview (409 PREVIEW_STALE)', async () => {
    const token = (await preview()).body.data.previewToken as string;
    const res = await request(t.app)
      .post(url('commit'))
      .set(headers)
      .send(
        generateBody({ previewToken: token, defaults: { mrp: '999.00', sellingPrice: '899.00' } }),
      );
    expect(res.status).toBe(409);
    expect(res.body.error.details[0].code).toBe('PREVIEW_STALE');
    expect(t.m.productVariant.create).not.toHaveBeenCalled();
  });

  it('requires a preview token', async () => {
    const res = await request(t.app).post(url('commit')).set(headers).send(generateBody());
    expect(res.status).toBe(422);
    expect(res.body.error.details[0].code).toBe('PREVIEW_REQUIRED');
  });

  it('maps a racing unique violation to 409 naming the combination and rolls back', async () => {
    const token = (await preview()).body.data.previewToken as string;
    t.m.productVariant.create.mockReset();
    t.m.productVariant.create.mockResolvedValueOnce({ id: randomUUID() }).mockRejectedValueOnce(
      Object.assign(new Error('Unique constraint failed'), {
        code: 'P2002',
        clientVersion: '7.10.1',
        meta: { target: 'uq_product_variants_combination' },
      }),
    );
    const res = await request(t.app)
      .post(url('commit'))
      .set(headers)
      .send(generateBody({ previewToken: token }));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_RESOURCE');
    expect(res.body.error.message).toMatch(/Combination ".+ \/ .+" already exists/);
    expect(res.body.error.details[0]).toMatchObject({ code: 'DUPLICATE_COMBINATION' });
  });

  it('flags unresolved SKU conflicts at commit with 422', async () => {
    const token = (await preview()).body.data.previewToken as string;
    t.m.productVariant.findMany.mockImplementation(
      (args: { where?: { sku?: { in?: string[] } } }) =>
        Promise.resolve(
          args.where?.sku?.in?.includes('EAR-MEERA-ROSEGO-SMALL') === true
            ? [
                {
                  id: 'v-x',
                  sku: 'EAR-MEERA-ROSEGO-SMALL',
                  barcode: null,
                  deletedAt: null,
                  productId: 'p2',
                  product: { name: 'Other' },
                },
              ]
            : [existingGoldSmall()],
        ),
    );
    const res = await request(t.app)
      .post(url('commit'))
      .set(headers)
      .send(generateBody({ previewToken: token }));
    expect(res.status).toBe(422);
    expect(res.body.error.details[0]).toMatchObject({ code: 'SKU_CONFLICT' });
    expect(t.m.$transaction).not.toHaveBeenCalled();
  });
});

describe('POST /admin/products/:productId/variants', () => {
  it('rejects an existing combination (409 DUPLICATE_COMBINATION)', async () => {
    t.m.productVariant.findMany.mockResolvedValue([existingGoldSmall()]);
    const res = await request(t.app)
      .post(`/api/v1/admin/products/${product.id}/variants`)
      .set(headers)
      .send({ attributeValueIds: [small.id, gold.id], sku: 'NEW-1', mrp: '10', sellingPrice: '9' });
    expect(res.status).toBe(409);
    expect(res.body.error.details[0]).toMatchObject({
      code: 'DUPLICATE_COMBINATION',
      meta: { existingVariantId: 'v-gold-s' },
    });
  });

  it('adds a variant with its inventory row', async () => {
    t.m.productVariant.findMany.mockResolvedValue([existingGoldSmall()]);
    const res = await request(t.app)
      .post(`/api/v1/admin/products/${product.id}/variants`)
      .set(headers)
      .send({
        attributeValueIds: [medium.id, rose.id],
        sku: 'ear-meera-rsg-m',
        mrp: '10',
        sellingPrice: '9',
      });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ sku: 'EAR-MEERA-RSG-M', name: 'Rose Gold / Medium' });
    expect(t.m.inventory.create).toHaveBeenCalledTimes(1);
  });
});

describe('PATCH/DELETE /admin/product-variants/:variantId', () => {
  const variant = () => ({
    ...variantAdminRow({ productId: product.id }),
    product: { id: product.id, productType: 'VARIABLE', status: 'ACTIVE', name: product.name },
  });

  it('locks the SKU once stock movements exist (409 SKU_LOCKED)', async () => {
    const v = variant();
    t.m.productVariant.findFirst.mockResolvedValue(v);
    t.m.inventoryTransaction.count.mockResolvedValue(1);
    const res = await request(t.app)
      .patch(`/api/v1/admin/product-variants/${v.id}`)
      .set(headers)
      .send({ sku: 'NEW-SKU' });
    expect(res.status).toBe(409);
    expect(res.body.error.details[0].code).toBe('SKU_LOCKED');
  });

  it('updates prices with an audit diff and validates against the stored MRP', async () => {
    const v = variant();
    t.m.productVariant.findFirst.mockResolvedValue(v);
    const bad = await request(t.app)
      .patch(`/api/v1/admin/product-variants/${v.id}`)
      .set(headers)
      .send({ sellingPrice: '1999.00' });
    expect(bad.status).toBe(422);
    const res = await request(t.app)
      .patch(`/api/v1/admin/product-variants/${v.id}`)
      .set(headers)
      .send({ sellingPrice: '1399.00' });
    expect(res.status).toBe(200);
    const audit = t.m.auditLog.create.mock.calls.at(-1)?.[0].data;
    expect(audit).toMatchObject({ action: 'UPDATE', entityType: 'ProductVariant' });
    expect(audit.newValues).toMatchObject({ sellingPrice: '1399.00' });
    expect(audit.oldValues).toMatchObject({ sellingPrice: '1499' });
  });

  it('refuses to delete the last variant and variants with history', async () => {
    const v = variant();
    t.m.productVariant.findFirst.mockResolvedValue(v);
    t.m.productVariant.findMany.mockResolvedValueOnce([{ id: v.id, status: 'ACTIVE' }]);
    const last = await request(t.app).delete(`/api/v1/admin/product-variants/${v.id}`).set(headers);
    expect(last.status).toBe(409);
    expect(last.body.error.details[0].code).toBe('LAST_VARIANT');

    t.m.productVariant.findMany.mockResolvedValueOnce([
      { id: v.id, status: 'ACTIVE' },
      { id: 'other', status: 'ACTIVE' },
    ]);
    t.m.orderItem.count.mockResolvedValueOnce(3);
    const history = await request(t.app)
      .delete(`/api/v1/admin/product-variants/${v.id}`)
      .set(headers);
    expect(history.status).toBe(409);
    expect(history.body.error.details[0].code).toBe('VARIANT_HAS_HISTORY');
  });

  it('soft-deletes a variant without history', async () => {
    const v = variant();
    t.m.productVariant.findFirst.mockResolvedValue(v);
    t.m.productVariant.findMany.mockResolvedValueOnce([
      { id: v.id, status: 'ACTIVE' },
      { id: 'other', status: 'ACTIVE' },
    ]);
    const res = await request(t.app).delete(`/api/v1/admin/product-variants/${v.id}`).set(headers);
    expect(res.status).toBe(200);
    expect(t.m.productVariant.update.mock.calls[0]?.[0].data).toMatchObject({
      deletedAt: t.now.value,
    });
    expect(t.m.auditLog.create.mock.calls.at(-1)?.[0].data).toMatchObject({ action: 'DELETE' });
  });
});

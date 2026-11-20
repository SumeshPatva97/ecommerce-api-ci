/**
 * Barcode routes through the real pipeline — MOCKED DB. Real bwip-js / PDFKit rendering:
 * SVG/PNG/PDF content types, preview warnings, label limits, barcode assignment and PRINT audit.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { Decimal } from '../../../../src/lib/money.js';
import { createBarcodesModule } from '../../../../src/modules/barcodes/index.js';
import { filenameFor } from '../../../../src/modules/barcodes/barcodes.service.js';
import { mayNotFit, pdfSafe } from '../../../../src/modules/barcodes/barcodes.render.js';
import { buildModuleTestApp } from '../../../helpers/container.js';
import { expectAdminRoutesGuarded } from '../../../helpers/routeTable.js';

const V1 = '00000000-0000-4000-8000-000000000001';
const V2 = '00000000-0000-4000-8000-000000000002';
const P1 = '00000000-0000-4000-8000-0000000000a1';

function variant(overrides: Record<string, unknown> = {}) {
  return {
    id: V1,
    sku: 'EAR-MEERA-GLD-S',
    barcode: null,
    name: 'Gold / Small',
    mrp: new Decimal('1799'),
    sellingPrice: new Decimal('1499'),
    productId: P1,
    sortOrder: 0,
    product: { name: 'Meera Kundan Jhumka', brand: { name: 'Aura' } },
    ...overrides,
  };
}

function setup() {
  const t = buildModuleTestApp([createBarcodesModule]);
  const viewer = t.staff({ permissions: ['barcodes.view'] });
  const printer = t.staff({ permissions: ['barcodes.view', 'barcodes.create'] });
  return { t, viewer, printer };
}

const binary = (res: unknown, callback: (err: Error | null, body: unknown) => void): void => {
  const stream = res as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c));
  stream.on('end', () => {
    callback(null, Buffer.concat(chunks));
  });
};

describe('barcode routes — guards', () => {
  it('declares permissions on every route', () => {
    const { t } = setup();
    const routes = expectAdminRoutesGuarded(createBarcodesModule(t.container));
    expect(routes.map((r) => `${r.method} ${r.path} ${r.permissions.join(',')}`)).toEqual([
      'GET /product-variants/:variantId/barcode barcodes.view',
      'POST /barcodes/preview barcodes.view',
      'POST /barcodes/labels barcodes.create',
    ]);
  });
});

describe('GET /admin/product-variants/:variantId/barcode', () => {
  it('renders SVG of the SKU (no barcode on file) with private caching', async () => {
    const { t, viewer } = setup();
    t.m.productVariant.findFirst.mockResolvedValue({ sku: 'EAR-MEERA-GLD-S', barcode: null });
    const res = await request(t.app)
      .get(`/api/v1/admin/product-variants/${V1}/barcode`)
      .set(viewer.headers)
      .buffer(true)
      .parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^image\/svg\+xml/);
    expect(res.headers['cache-control']).toBe('private, max-age=86400');
    expect(res.headers['x-barcode-value']).toBe('EAR-MEERA-GLD-S');
    expect((res.body as Buffer).toString('utf8')).toMatch(/^<svg /);
  });

  it('renders PNG of the stored barcode', async () => {
    const { t, viewer } = setup();
    t.m.productVariant.findFirst.mockResolvedValue({ sku: 'EAR-1', barcode: 'SUPPLIER-0042' });
    const res = await request(t.app)
      .get(
        `/api/v1/admin/product-variants/${V1}/barcode?format=png&scale=2&height=12&includeText=false`,
      )
      .set(viewer.headers)
      .buffer(true)
      .parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-barcode-value']).toBe('SUPPLIER-0042');
    expect((res.body as Buffer).subarray(1, 4).toString('ascii')).toBe('PNG');
  });

  it('404s unknown variants and validates the query', async () => {
    const { t, viewer } = setup();
    t.m.productVariant.findFirst.mockResolvedValue(null);
    const missing = await request(t.app)
      .get(`/api/v1/admin/product-variants/${V1}/barcode`)
      .set(viewer.headers);
    expect(missing.status).toBe(404);
    const bad = await request(t.app)
      .get(`/api/v1/admin/product-variants/${V1}/barcode?format=gif&scale=9`)
      .set(viewer.headers);
    expect(bad.status).toBe(422);
    const denied = t.staff({ permissions: ['inventory.view'] });
    expect(
      (await request(t.app).get(`/api/v1/admin/product-variants/${V1}/barcode`).set(denied.headers))
        .status,
    ).toBe(403);
  });
});

describe('POST /admin/barcodes/preview', () => {
  it('returns label lines, SVGs and warnings; expands products', async () => {
    const { t, viewer } = setup();
    t.m.productVariant.findMany.mockResolvedValue([
      variant(),
      variant({
        id: V2,
        sku: 'EAR-MEERA-GLD-M',
        barcode: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123',
        name: 'Gold / Medium',
      }),
    ]);
    const res = await request(t.app)
      .post('/api/v1/admin/barcodes/preview')
      .set(viewer.headers)
      .send({
        layout: 'THERMAL_50x25',
        items: [
          { variantId: V1, copies: 2 },
          { productId: P1, allVariants: true, copiesEach: 1 },
        ],
        fields: { brandName: true, sellingPrice: true },
      });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      layout: 'THERMAL_50x25',
      labelSizeMm: { width: 50, height: 25 },
      totalLabels: 4,
    });
    expect(res.body.data.labels[0]).toMatchObject({
      variantId: V1,
      copies: 3,
      encodedValue: 'EAR-MEERA-GLD-S',
      symbology: 'CODE128',
      caption: 'EAR-MEERA-GLD-S',
      lines: [
        'Aura',
        'Meera Kundan Jhumka',
        'Gold / Small',
        'MRP ₹1799.00 (incl. of all taxes)',
        'Price ₹1499.00',
      ],
    });
    expect(res.body.data.labels[0].svg).toMatch(/^<svg /);
    expect(res.body.data.warnings).toEqual([
      expect.objectContaining({ variantId: V1, code: 'BARCODE_ASSIGNED_FROM_SKU' }),
      expect.objectContaining({ variantId: V2, code: 'BARCODE_MAY_NOT_FIT' }),
    ]);
    expect(t.m.productVariant.updateMany).not.toHaveBeenCalled();
    expect(t.m.auditLog.create).not.toHaveBeenCalled();
  });

  it('rejects unknown variants/products and more than 500 labels', async () => {
    const { t, viewer } = setup();
    t.m.productVariant.findMany.mockResolvedValue([variant()]);
    const unknown = await request(t.app)
      .post('/api/v1/admin/barcodes/preview')
      .set(viewer.headers)
      .send({ items: [{ variantId: V2 }, { productId: V2, allVariants: true }] });
    expect(unknown.status).toBe(422);
    expect((unknown.body.error.details as { field: string }[]).map((d) => d.field)).toEqual([
      'items[0].variantId',
      'items[1].productId',
    ]);
    const tooMany = await request(t.app)
      .post('/api/v1/admin/barcodes/preview')
      .set(viewer.headers)
      .send({
        items: [
          { variantId: V1, copies: 300 },
          { variantId: V1, copies: 201 },
        ],
      });
    expect(tooMany.status).toBe(422);
    expect(tooMany.body.error.details[0]).toMatchObject({
      code: 'TOO_MANY_LABELS',
      meta: { requested: 501, max: 500 },
    });
    const shape = await request(t.app)
      .post('/api/v1/admin/barcodes/preview')
      .set(viewer.headers)
      .send({ items: [{ productId: V1, allVariants: false }] });
    expect(shape.status).toBe(422);
  });
});

describe('POST /admin/barcodes/labels', () => {
  it('returns a PDF, assigns barcode = SKU and audits PRINT', async () => {
    const { t, printer } = setup();
    t.m.productVariant.findMany
      .mockResolvedValueOnce([variant(), variant({ id: V2, sku: 'RNG-2', barcode: 'RNG-2' })])
      .mockResolvedValueOnce([]); // no barcode clash
    const res = await request(t.app)
      .post('/api/v1/admin/barcodes/labels')
      .set(printer.headers)
      .send({
        layout: 'A4_SHEET_65',
        startPosition: 64,
        items: [
          { variantId: V1, copies: 2 },
          { variantId: V2, copies: 1 },
        ],
      })
      .buffer(true)
      .parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="labels-20261119-1200.pdf"',
    );
    expect(res.headers['x-total-labels']).toBe('3');
    expect((res.body as Buffer).subarray(0, 5).toString('ascii')).toBe('%PDF-');

    expect(t.m.productVariant.updateMany).toHaveBeenCalledTimes(1);
    expect(t.m.productVariant.updateMany).toHaveBeenCalledWith({
      where: { id: V1, barcode: null },
      data: { barcode: 'EAR-MEERA-GLD-S', updatedById: printer.ctx.userId },
    });
    const audit = t.m.auditLog.create.mock.calls[0]?.[0].data;
    expect(audit).toMatchObject({
      action: 'PRINT',
      module: 'barcodes',
      entityType: 'ProductVariant',
      actorUserId: printer.ctx.userId,
    });
    expect(audit.newValues._event.metadata).toMatchObject({
      layout: 'A4_SHEET_65',
      startPosition: 64,
      totalLabels: 3,
      variants: [
        { variantId: V1, sku: 'EAR-MEERA-GLD-S', copies: 2 },
        { variantId: V2, sku: 'RNG-2', copies: 1 },
      ],
      barcodesAssigned: [V1],
    });
  });

  it('prints thermal labels for a single variant with a stored barcode', async () => {
    const { t, printer } = setup();
    t.m.productVariant.findMany.mockResolvedValueOnce([variant({ barcode: 'EAR-MEERA-GLD-S' })]);
    const res = await request(t.app)
      .post('/api/v1/admin/barcodes/labels')
      .set(printer.headers)
      .send({ items: [{ variantId: V1 }], fields: { sku: false, mrp: false } })
      .buffer(true)
      .parse(binary);
    expect(res.status).toBe(200);
    expect(t.m.productVariant.updateMany).not.toHaveBeenCalled();
    expect(t.m.auditLog.create.mock.calls[0]?.[0].data.entityId).toBe(V1);
  });

  it('refuses a barcode clash, thermal startPosition and missing permission', async () => {
    const { t, viewer, printer } = setup();
    t.m.productVariant.findMany
      .mockResolvedValueOnce([variant()])
      .mockResolvedValueOnce([{ id: V2, barcode: 'EAR-MEERA-GLD-S' }]);
    const clash = await request(t.app)
      .post('/api/v1/admin/barcodes/labels')
      .set(printer.headers)
      .send({ items: [{ variantId: V1 }] });
    expect(clash.status).toBe(409);
    expect(clash.body.error.details[0].code).toBe('BARCODE_CONFLICT');
    expect(t.m.auditLog.create).not.toHaveBeenCalled();

    const thermal = await request(t.app)
      .post('/api/v1/admin/barcodes/labels')
      .set(printer.headers)
      .send({ layout: 'THERMAL_50x25', startPosition: 3, items: [{ variantId: V1 }] });
    expect(thermal.status).toBe(422);
    expect(thermal.body.error.details[0].field).toBe('startPosition');

    const denied = await request(t.app)
      .post('/api/v1/admin/barcodes/labels')
      .set(viewer.headers)
      .send({ items: [{ variantId: V1 }] });
    expect(denied.status).toBe(403);
  });
});

describe('barcode helpers', () => {
  it('formats IST filenames, PDF-safe text and the fit heuristic', () => {
    expect(filenameFor(new Date('2026-11-19T18:45:00.000Z'))).toBe('labels-20261120-0015.pdf');
    expect(pdfSafe('MRP ₹1799.00')).toBe('MRP Rs. 1799.00');
    expect(mayNotFit('EAR-1', 'THERMAL_50x25')).toBe(false);
    expect(mayNotFit('ABCDEFGHIJKLMNOP', 'A4_SHEET_65')).toBe(true);
  });
});

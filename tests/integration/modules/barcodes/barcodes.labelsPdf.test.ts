/**
 * TC-034 — "Bulk label PDF: N labels, layout per template" (API part).
 *
 * `POST /admin/barcodes/labels` through the real pipeline (MOCKED DB, real bwip-js + PDFKit). The
 * returned PDF is inspected structurally with Node built-ins only (no PDF or barcode library):
 * page objects and their `/MediaBox`, plus the inflated content streams, where PDFKit writes one
 * `… cm /I<n> Do` per barcode image and one `[<hex> …] TJ` per text line (WinAnsi, hex-encoded).
 *
 * Checked: number of labels (pages / images), physical page size, grid position of every label
 * on the A4 65-up sheet, `startPosition` and sheet overflow, and the printed text.
 * NOT checked here: that the bars decode back to the value (needs a barcode decoder — TC-033
 * territory) and how the sheet looks when printed (manual / E2E).
 */
import { inflateSync } from 'node:zlib';

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { Decimal } from '../../../../src/lib/money.js';
import { createBarcodesModule } from '../../../../src/modules/barcodes/index.js';
import { buildModuleTestApp } from '../../../helpers/container.js';

const V1 = '00000000-0000-4000-8000-000000000001';
const V2 = '00000000-0000-4000-8000-000000000002';
const P1 = '00000000-0000-4000-8000-0000000000a1';
const P2 = '00000000-0000-4000-8000-0000000000a2';

/** Both variants already have a barcode, so printing assigns nothing. */
const jhumka = () => ({
  id: V1,
  sku: 'EAR-MEERA-GLD-S',
  barcode: 'EAR-MEERA-GLD-S',
  name: 'Gold / Small',
  mrp: new Decimal('1799'),
  sellingPrice: new Decimal('1499'),
  productId: P1,
  sortOrder: 0,
  product: { name: 'Meera Kundan Jhumka', brand: { name: 'Aura' } },
});
const ring = () => ({
  id: V2,
  sku: 'RNG-TARA-SLV-7',
  barcode: 'SUP-0042',
  name: 'Size 7',
  mrp: new Decimal('1199'),
  sellingPrice: new Decimal('999'),
  productId: P2,
  sortOrder: 0,
  product: { name: 'Tara Silver Ring', brand: null },
});

const binary = (res: unknown, callback: (err: Error | null, body: unknown) => void): void => {
  const stream = res as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c));
  stream.on('end', () => {
    callback(null, Buffer.concat(chunks));
  });
};

async function printLabels(body: Record<string, unknown>) {
  const t = buildModuleTestApp([createBarcodesModule]);
  const printer = t.staff({ permissions: ['barcodes.view', 'barcodes.create'] });
  t.m.productVariant.findMany.mockResolvedValueOnce([jhumka(), ring()]);
  const res = await request(t.app)
    .post('/api/v1/admin/barcodes/labels')
    .set(printer.headers)
    .send(body)
    .buffer(true)
    .parse(binary);
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toBe('application/pdf');
  return { res, pages: inspectPdf(res.body as Buffer) };
}

// ── Minimal structural PDF reader (PDFKit output only) ──────────────────────────────────────────

const PT_PER_MM = 72 / 25.4;
const pt = (mm: number): number => mm * PT_PER_MM;
const EPS = 0.01;

/** Points, origin at the TOP-left of the page. */
interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface PdfText {
  text: string;
  /** Start of the baseline. */
  x: number;
  y: number;
}
interface PdfPage {
  width: number;
  height: number;
  images: Rect[];
  texts: PdfText[];
}

function inspectPdf(pdf: Buffer): PdfPage[] {
  expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  const raw = pdf.toString('latin1'); // 1 char = 1 byte, so string offsets are byte offsets
  const objects = new Map<number, { at: number; source: string }>();
  for (const match of raw.matchAll(/(\d+) 0 obj\n([\s\S]*?)\nendobj/g)) {
    objects.set(Number(match[1]), { at: match.index, source: match[0] });
  }
  const streamOf = (id: number): string => {
    const object = objects.get(id);
    if (object === undefined) throw new Error(`PDF object ${String(id)} not found`);
    const marker = object.source.indexOf('stream\n');
    const length = Number(/\/Length (\d+)/.exec(object.source)?.[1]);
    const start = object.at + marker + 'stream\n'.length;
    return inflateSync(pdf.subarray(start, start + length)).toString('latin1');
  };

  const tree = [...objects.values()].find((o) => o.source.includes('/Type /Pages'));
  const kids = /\/Kids \[([^\]]*)\]/.exec(tree?.source ?? '')?.[1] ?? '';
  return [...kids.matchAll(/(\d+) 0 R/g)].map((kid) => {
    const page = objects.get(Number(kid[1]))?.source ?? '';
    const box = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(page);
    const width = Number(box?.[1]);
    const height = Number(box?.[2]);
    const content = streamOf(Number(/\/Contents (\d+) 0 R/.exec(page)?.[1]));

    // Image: `w 0 0 -h x (top + h) cm` then `/I<n> Do`, in PDFKit's top-left user space.
    const images = [
      ...content.matchAll(/^([\d.]+) 0 0 -([\d.]+) ([\d.]+) ([\d.]+) cm\n\/I\d+ Do$/gm),
    ].map((op): Rect => {
      const h = Number(op[2]);
      return { x: Number(op[3]), y: Number(op[4]) - h, width: Number(op[1]), height: h };
    });
    // Text: `1 0 0 1 x y Tm` (bottom-left origin) … `[<hex> kern <hex> …] TJ`.
    const texts = [
      ...content.matchAll(/^1 0 0 1 ([\d.]+) ([\d.]+) Tm\n\/F\d+ [\d.]+ Tf\n\[(.*)\] TJ$/gm),
    ].map((op): PdfText => ({
      text: [...(op[3] ?? '').matchAll(/<([0-9a-f]*)>/g)]
        .map((chunk) => Buffer.from(chunk[1] ?? '', 'hex').toString('latin1'))
        .join(''),
      x: Number(op[1]),
      y: height - Number(op[2]),
    }));
    return { width, height, images, texts };
  });
}

const inside = (inner: Rect, outer: Rect): boolean =>
  inner.x >= outer.x - EPS &&
  inner.y >= outer.y - EPS &&
  inner.x + inner.width <= outer.x + outer.width + EPS &&
  inner.y + inner.height <= outer.y + outer.height + EPS;

/**
 * The A4 65-up sticker template (barcodes.render.ts header): 38.1 × 21.2 mm labels, 5 columns ×
 * 13 rows, left margin 4.75 mm, top margin 10.7 mm, pitch 40.6 × 21.2 mm. Written out here on
 * purpose — the test pins the template, it does not read it from the implementation.
 */
const A4 = { widthMm: 210, heightMm: 297, columns: 5, rows: 13 } as const;
const A4_LABEL = { widthMm: 38.1, heightMm: 21.2, leftMm: 4.75, topMm: 10.7, pitchXMm: 40.6 };

/** Label cell for a 0-based sheet position (row-major: left → right, then down). */
function a4Cell(slot: number): Rect {
  const column = slot % A4.columns;
  const row = Math.floor(slot / A4.columns);
  return {
    x: pt(A4_LABEL.leftMm + column * A4_LABEL.pitchXMm),
    y: pt(A4_LABEL.topMm + row * A4_LABEL.heightMm),
    width: pt(A4_LABEL.widthMm),
    height: pt(A4_LABEL.heightMm),
  };
}

/** 0-based sheet position whose cell contains the point, or -1. */
function a4SlotAt(x: number, y: number): number {
  for (let slot = 0; slot < A4.columns * A4.rows; slot += 1) {
    if (inside({ x, y, width: 0, height: 0 }, a4Cell(slot))) return slot;
  }
  return -1;
}

const textsBySlot = (page: PdfPage): Map<number, string[]> => {
  const out = new Map<number, string[]>();
  for (const text of page.texts) {
    const slot = a4SlotAt(text.x, text.y);
    out.set(slot, [...(out.get(slot) ?? []), text.text]);
  }
  return out;
};

describe('POST /admin/barcodes/labels — PDF contents (TC-034)', () => {
  it('TC-034: THERMAL_50x25 prints one 50 × 25 mm page per label, copies expanded in request order, each with one barcode and its text', async () => {
    const { res, pages } = await printLabels({
      items: [
        { variantId: V1, copies: 2 },
        { variantId: V2, copies: 1 },
      ],
    });
    expect(res.headers['x-total-labels']).toBe('3');
    expect(pages).toHaveLength(3);
    for (const page of pages) {
      expect(page.width).toBeCloseTo(pt(50), 3);
      expect(page.height).toBeCloseTo(pt(25), 3);
      expect(page.images).toHaveLength(1);
      const [barcode] = page.images;
      expect(barcode !== undefined && barcode.width > 0 && barcode.height > 0).toBe(true);
      // The barcode stays inside the label (1.2 mm padding on every side).
      const printable = {
        x: pt(1.2),
        y: pt(1.2),
        width: page.width - pt(2.4),
        height: page.height - pt(2.4),
      };
      expect(barcode !== undefined && inside(barcode, printable)).toBe(true);
    }
    // Default fields: product name, variant name, MRP line, then the SKU under the barcode
    // (the rupee sign is printed as "Rs." — PDFKit standard fonts are WinAnsi).
    const meera = [
      'Meera Kundan Jhumka',
      'Gold / Small',
      'MRP Rs. 1799.00 (incl. of all taxes)',
      'EAR-MEERA-GLD-S',
    ];
    expect(pages.map((page) => page.texts.map((text) => text.text))).toEqual([
      meera,
      meera,
      ['Tara Silver Ring', 'Size 7', 'MRP Rs. 1199.00 (incl. of all taxes)', 'RNG-TARA-SLV-7'],
    ]);
  });

  it('TC-034: `fields` decide the printed text — mrp:false drops the MRP line, sku:false drops the caption under the barcode', async () => {
    const { pages } = await printLabels({
      items: [{ variantId: V2 }],
      fields: { mrp: false, sku: false },
    });
    expect(pages).toHaveLength(1);
    expect(pages[0]?.images).toHaveLength(1);
    expect(pages[0]?.texts.map((text) => text.text)).toEqual(['Tara Silver Ring', 'Size 7']);
  });

  it('TC-034: A4_SHEET_65 places labels on the 5 × 13 grid from startPosition and continues on a new sheet after position 65', async () => {
    const { res, pages } = await printLabels({
      layout: 'A4_SHEET_65',
      startPosition: 64,
      items: [
        { variantId: V1, copies: 2 },
        { variantId: V2, copies: 1 },
      ],
    });
    expect(res.headers['x-total-labels']).toBe('3');
    expect(pages).toHaveLength(2);
    for (const page of pages) {
      expect(page.width).toBeCloseTo(pt(A4.widthMm), 3);
      expect(page.height).toBeCloseTo(pt(A4.heightMm), 3);
    }
    const [first, second] = pages;
    if (first === undefined || second === undefined) throw new Error('expected two sheets');

    // Sheet 1: positions 64 and 65 (0-based 63, 64 — last row, columns 4 and 5). Sheet 2: position 1.
    expect(first.images).toHaveLength(2);
    expect(second.images).toHaveLength(1);
    expect(first.images.map((image) => a4SlotAt(image.x, image.y))).toEqual([63, 64]);
    expect(second.images.map((image) => a4SlotAt(image.x, image.y))).toEqual([0]);
    for (const [page, slots] of [
      [first, [63, 64]],
      [second, [0]],
    ] as const) {
      page.images.forEach((image, index) => {
        expect(inside(image, a4Cell(slots[index] ?? -1)), `image ${String(index)}`).toBe(true);
      });
    }

    // Every text line is printed inside the cell of its own label.
    const firstTexts = textsBySlot(first);
    const secondTexts = textsBySlot(second);
    expect([...firstTexts.keys()].sort((a, b) => a - b)).toEqual([63, 64]);
    expect([...secondTexts.keys()]).toEqual([0]);
    const meera = expect.arrayContaining([
      'Meera Kundan Jhumka',
      'Gold / Small',
      'EAR-MEERA-GLD-S',
    ]);
    expect(firstTexts.get(63)).toEqual(meera);
    expect(firstTexts.get(64)).toEqual(meera);
    expect(secondTexts.get(0)).toEqual(
      expect.arrayContaining(['Tara Silver Ring', 'Size 7', 'RNG-TARA-SLV-7']),
    );
  });

  it('TC-034: a full A4 sheet holds exactly 65 labels, one per grid cell; label 66 starts sheet 2 at position 1', async () => {
    const { res, pages } = await printLabels({
      layout: 'A4_SHEET_65',
      items: [{ variantId: V1, copies: 66 }],
    });
    expect(res.headers['x-total-labels']).toBe('66');
    expect(pages).toHaveLength(2);
    const [first, second] = pages;
    if (first === undefined || second === undefined) throw new Error('expected two sheets');

    expect(first.images).toHaveLength(65);
    // Row-major fill: draw order is position order, and every cell is used exactly once.
    expect(first.images.map((image) => a4SlotAt(image.x, image.y))).toEqual(
      Array.from({ length: 65 }, (_, slot) => slot),
    );
    first.images.forEach((image, slot) => {
      expect(inside(image, a4Cell(slot)), `position ${String(slot + 1)}`).toBe(true);
    });
    // The grid itself fits on the A4 page.
    const last = a4Cell(64);
    expect(last.x + last.width).toBeLessThanOrEqual(first.width);
    expect(last.y + last.height).toBeLessThanOrEqual(first.height);

    expect(second.images).toHaveLength(1);
    expect(second.images.map((image) => a4SlotAt(image.x, image.y))).toEqual([0]);
  });
});

/**
 * Server-side barcode & label rendering — PRODUCT_VARIANT_AND_INVENTORY_WORKFLOWS.md §14,
 * BACKEND_STRUCTURE.md §18 (PDFKit + bwip-js), API_DOCUMENTATION.md §4.6.
 *
 * PROVISIONAL (OQ-40): Code 128 symbology; layouts `THERMAL_50x25` (one 50×25 mm label per page,
 * roll printers) and `A4_SHEET_65` (65-up 38.1×21.2 mm sticker sheet, 5 × 13). Label content and
 * MRP/legal-metrology wording still to be confirmed by the client.
 */
import bwipjs from 'bwip-js';
import PDFDocument from 'pdfkit';

export const SYMBOLOGY = 'CODE128';

export interface LayoutSpec {
  readonly key: LayoutKey;
  readonly labelWidthMm: number;
  readonly labelHeightMm: number;
  /** Labels per page (1 for roll layouts). */
  readonly perPage: number;
  readonly page: { widthMm: number; heightMm: number };
  readonly columns: number;
  readonly marginLeftMm: number;
  readonly marginTopMm: number;
  readonly pitchXMm: number;
  readonly pitchYMm: number;
}

export const LAYOUT_KEYS = ['THERMAL_50x25', 'A4_SHEET_65'] as const;
export type LayoutKey = (typeof LAYOUT_KEYS)[number];

export const LAYOUTS: Readonly<Record<LayoutKey, LayoutSpec>> = {
  THERMAL_50x25: {
    key: 'THERMAL_50x25',
    labelWidthMm: 50,
    labelHeightMm: 25,
    perPage: 1,
    page: { widthMm: 50, heightMm: 25 },
    columns: 1,
    marginLeftMm: 0,
    marginTopMm: 0,
    pitchXMm: 50,
    pitchYMm: 25,
  },
  A4_SHEET_65: {
    key: 'A4_SHEET_65',
    labelWidthMm: 38.1,
    labelHeightMm: 21.2,
    perPage: 65,
    page: { widthMm: 210, heightMm: 297 },
    columns: 5,
    marginLeftMm: 4.75,
    marginTopMm: 10.7,
    pitchXMm: 40.6,
    pitchYMm: 21.2,
  },
};

const PT_PER_MM = 72 / 25.4;
const mm = (value: number): number => value * PT_PER_MM;
const LABEL_PADDING_MM = 1.2;
/** Narrowest printable bar (≈ 1.5 dots at 203 dpi) used for the fit warning. */
const MIN_MODULE_MM = 0.19;

/** Code 128 width in modules (code set B estimate: start + data + check + stop). */
export function code128Modules(value: string): number {
  return 11 * (value.length + 3) + 2;
}

/** True when the value is likely too long to scan reliably on this layout's label width. */
export function mayNotFit(value: string, layout: LayoutKey): boolean {
  const usable = LAYOUTS[layout].labelWidthMm - 2 * LABEL_PADDING_MM;
  return usable / code128Modules(value) < MIN_MODULE_MM;
}

export interface BarcodeImageOptions {
  readonly scale: number;
  readonly heightMm: number;
  readonly includeText: boolean;
}

function bwipOptions(value: string, options: BarcodeImageOptions): bwipjs.RenderOptions {
  return {
    bcid: 'code128',
    text: value,
    scale: options.scale,
    height: options.heightMm,
    includetext: options.includeText,
    textxalign: 'center',
    paddingwidth: 2,
    paddingheight: 1,
  };
}

export function renderBarcodeSvg(value: string, options: BarcodeImageOptions): string {
  return bwipjs.toSVG(bwipOptions(value, options));
}

export function renderBarcodePng(value: string, options: BarcodeImageOptions): Promise<Buffer> {
  return bwipjs.toBuffer(bwipOptions(value, options));
}

export interface LabelSpec {
  readonly encodedValue: string;
  /** Text lines above the barcode (product, variant, MRP, …). */
  readonly lines: readonly string[];
  /** Human-readable value printed under the barcode (`null` = hidden). */
  readonly caption: string | null;
}

/** PDFKit's standard fonts are WinAnsi — the rupee sign is printed as "Rs.". */
export function pdfSafe(text: string): string {
  return text.replace(/₹\s?/g, 'Rs. ');
}

function drawLabel(
  doc: PDFKit.PDFDocument,
  label: LabelSpec,
  png: Buffer,
  x: number,
  y: number,
  layout: LayoutSpec,
): void {
  const pad = mm(LABEL_PADDING_MM);
  const width = mm(layout.labelWidthMm) - 2 * pad;
  const height = mm(layout.labelHeightMm) - 2 * pad;
  const fontSize = layout.labelHeightMm < 22 ? 5 : 6;
  const lineHeight = fontSize * 1.2;
  const lines = label.lines.slice(0, layout.labelHeightMm < 22 ? 2 : 3);
  let cursor = y + pad;
  doc.font('Helvetica').fontSize(fontSize).fillColor('black');
  for (const line of lines) {
    doc.text(pdfSafe(line), x + pad, cursor, {
      width,
      height: lineHeight,
      align: 'center',
      lineBreak: false,
      ellipsis: true,
    });
    cursor += lineHeight;
  }
  const captionHeight = label.caption === null ? 0 : lineHeight;
  const barcodeHeight = Math.max(mm(4), y + pad + height - cursor - captionHeight);
  doc.image(png, x + pad, cursor, {
    fit: [width, barcodeHeight],
    align: 'center',
    valign: 'center',
  });
  if (label.caption !== null) {
    doc.text(label.caption, x + pad, cursor + barcodeHeight, {
      width,
      height: lineHeight,
      align: 'center',
      lineBreak: false,
    });
  }
}

/**
 * Renders labels at exact physical size. `startPosition` (1-based, A4 only) skips already-used
 * positions on the first sheet.
 */
export async function renderLabelsPdf(
  layoutKey: LayoutKey,
  labels: readonly LabelSpec[],
  options: { startPosition: number; title: string; now: Date },
): Promise<Buffer> {
  const layout = LAYOUTS[layoutKey];
  const doc = new PDFDocument({
    size: [mm(layout.page.widthMm), mm(layout.page.heightMm)],
    margin: 0,
    autoFirstPage: false,
    info: { Title: options.title, Producer: 'ecommerce-api', CreationDate: options.now },
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    doc.on('error', reject);
  });

  const pngs = new Map<string, Buffer>();
  for (const label of labels) {
    if (!pngs.has(label.encodedValue)) {
      pngs.set(
        label.encodedValue,
        await renderBarcodePng(label.encodedValue, { scale: 3, heightMm: 8, includeText: false }),
      );
    }
  }

  let slot = layout.perPage === 1 ? 0 : Math.max(0, options.startPosition - 1);
  let pageOpen = false;
  for (const label of labels) {
    if (!pageOpen || slot >= layout.perPage) {
      doc.addPage();
      pageOpen = true;
      if (slot >= layout.perPage) slot = 0;
    }
    const column = slot % layout.columns;
    const row = Math.floor(slot / layout.columns);
    const x = mm(layout.marginLeftMm + column * layout.pitchXMm);
    const y = mm(layout.marginTopMm + row * layout.pitchYMm);
    const png = pngs.get(label.encodedValue);
    if (png !== undefined) drawLabel(doc, label, png, x, y, layout);
    slot += 1;
  }
  if (!pageOpen) doc.addPage();
  doc.end();
  return done;
}

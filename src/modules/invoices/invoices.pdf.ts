/**
 * Invoice / credit-note PDF (PDFKit, A4 portrait) — TAX_AND_GST_WORKFLOWS.md §16.3–§16.4, §18.3.
 *
 * Rendered ON DEMAND on every download from immutable rows (`invoice_records`, `tax_transactions`,
 * order line/address snapshots): no private file storage is configured, so `pdf_storage_key`
 * stays NULL. Gaps (recorded for owner/CA review):
 * - seller legal name / registered address are not snapshotted on `invoice_records`; they are read
 *   from the CURRENT `tax.seller_*` settings at render time (GSTIN and state come from the row);
 * - UQC and signatory name/signature are not in the approved schema (printed as "NOS" / text).
 *
 * The built-in PDF fonts (WinAnsi) have no ₹ glyph, so amounts print as `Rs. 4,320.00`.
 */
import PDFDocument from 'pdfkit';

import type { Queryable } from '../../core/db/transaction.js';
import { AppError } from '../../core/errors/AppError.js';
import type { InvoiceType } from '../../generated/prisma/enums.js';
import { dec, sum, toMoneyString, type Decimal } from '../../lib/money.js';
import { istParts } from '../../lib/time.js';
import { loadTaxSettings, type TaxSettings } from '../tax/index.js';
import { groupTax, groupsFromRows, type LedgerGroup } from './invoices.ledger.js';

const WINE = '#6d1a36';
const GREY = '#555555';
const LINE = '#cccccc';
const MARGIN = 36;

export interface InvoiceLookup {
  readonly orderId: string;
  readonly type: InvoiceType;
  readonly invoiceNumber?: string | undefined;
}

const DOCUMENT_SELECT = {
  id: true,
  invoiceType: true,
  invoiceNumber: true,
  invoiceDate: true,
  sellerGstin: true,
  sellerStateCode: true,
  buyerGstin: true,
  placeOfSupplyStateCode: true,
  supplyType: true,
  taxableTotal: true,
  taxTotal: true,
  grandTotal: true,
  createdAt: true,
  sellerState: { select: { name: true } },
  posState: { select: { name: true } },
  originalInvoice: { select: { invoiceNumber: true, invoiceDate: true } },
  refund: {
    select: { refundNumber: true, items: { select: { orderItemId: true, quantity: true } } },
  },
  taxTransactions: {
    select: {
      orderItemId: true,
      lineType: true,
      component: true,
      hsnCode: true,
      rate: true,
      taxableValue: true,
      amount: true,
    },
  },
  order: {
    select: {
      orderNumber: true,
      placedAt: true,
      paymentMethod: true,
      roundOff: true,
      customerNameSnapshot: true,
      billingAddressSnapshot: true,
      shippingAddressSnapshot: true,
      buyerLegalName: true,
      items: {
        select: {
          id: true,
          lineNo: true,
          productName: true,
          variantName: true,
          sku: true,
          quantity: true,
        },
      },
    },
  },
} as const;

export interface InvoiceDocumentData {
  readonly id: string;
  readonly invoiceType: InvoiceType;
  readonly invoiceNumber: string;
  readonly invoiceDate: Date;
  readonly sellerGstin: string | null;
  readonly sellerStateCode: string;
  readonly sellerStateName: string;
  readonly buyerGstin: string | null;
  readonly posStateCode: string;
  readonly posStateName: string;
  readonly taxableTotal: Decimal;
  readonly taxTotal: Decimal;
  readonly grandTotal: Decimal;
  readonly roundOff: Decimal;
  readonly originalInvoice: { invoiceNumber: string; invoiceDate: Date } | null;
  readonly refundNumber: string | null;
  readonly order: {
    readonly orderNumber: string;
    readonly placedAt: Date;
    readonly paymentMethod: string;
    readonly customerName: string;
    readonly buyerLegalName: string | null;
    readonly billingAddress: unknown;
    readonly shippingAddress: unknown;
  };
  readonly lines: readonly PdfLine[];
}

export interface PdfLine {
  readonly description: string;
  readonly hsnCode: string;
  readonly quantity: number | null;
  readonly rate: Decimal;
  readonly taxableValue: Decimal;
  readonly components: readonly { component: string; amount: Decimal }[];
  readonly total: Decimal;
}

/** Loads one invoice/credit note of an order (latest of the type unless a number is given). */
export async function loadInvoiceDocument(
  db: Queryable,
  lookup: InvoiceLookup,
): Promise<InvoiceDocumentData> {
  const row = await db.invoiceRecord.findFirst({
    where: {
      orderId: lookup.orderId,
      invoiceType: lookup.type,
      ...(lookup.invoiceNumber === undefined ? {} : { invoiceNumber: lookup.invoiceNumber }),
    },
    orderBy: { createdAt: 'desc' },
    select: DOCUMENT_SELECT,
  });
  if (row === null) {
    throw new AppError(
      'NOT_FOUND',
      lookup.type === 'TAX_INVOICE'
        ? 'Invoice will be available once your order ships.'
        : 'Credit note not found.',
      { details: [{ code: 'INVOICE_NOT_AVAILABLE', message: 'No document of this type exists.' }] },
    );
  }
  const items = new Map(row.order.items.map((i) => [i.id, i]));
  const refundQty = new Map((row.refund?.items ?? []).map((i) => [i.orderItemId, i.quantity]));
  const groups = groupsFromRows(row.taxTransactions);
  const lineNo = (g: LedgerGroup): number =>
    g.orderItemId === null ? Number.MAX_SAFE_INTEGER : (items.get(g.orderItemId)?.lineNo ?? 0);
  const ordered = [...groups].sort(
    (a, b) =>
      (a.lineType === 'ITEM' ? 0 : 1) - (b.lineType === 'ITEM' ? 0 : 1) || lineNo(a) - lineNo(b),
  );
  const lines: PdfLine[] = ordered.map((g) => {
    const item = g.orderItemId === null ? undefined : items.get(g.orderItemId);
    const isItem = g.lineType === 'ITEM';
    const description = isItem
      ? `${item?.productName ?? 'Item'}${item?.variantName ? ` - ${item.variantName}` : ''} (SKU ${item?.sku ?? '-'})`
      : g.lineType === 'SHIPPING'
        ? 'Shipping'
        : 'COD fee';
    const quantity = !isItem
      ? null
      : row.invoiceType === 'CREDIT_NOTE'
        ? (refundQty.get(g.orderItemId ?? '') ?? null)
        : (item?.quantity ?? null);
    return {
      description,
      hsnCode: g.hsnCode,
      quantity,
      rate: g.rate,
      taxableValue: g.taxableValue,
      components: g.components,
      total: g.taxableValue.plus(groupTax(g)),
    };
  });
  return {
    id: row.id,
    invoiceType: row.invoiceType,
    invoiceNumber: row.invoiceNumber,
    invoiceDate: row.invoiceDate,
    sellerGstin: row.sellerGstin,
    sellerStateCode: row.sellerStateCode,
    sellerStateName: row.sellerState.name,
    buyerGstin: row.buyerGstin,
    posStateCode: row.placeOfSupplyStateCode,
    posStateName: row.posState.name,
    taxableTotal: dec(row.taxableTotal),
    taxTotal: dec(row.taxTotal),
    grandTotal: dec(row.grandTotal),
    roundOff: row.invoiceType === 'TAX_INVOICE' ? dec(row.order.roundOff) : dec(0),
    originalInvoice: row.originalInvoice,
    refundNumber: row.refund?.refundNumber ?? null,
    order: {
      orderNumber: row.order.orderNumber,
      placedAt: row.order.placedAt,
      paymentMethod: row.order.paymentMethod,
      customerName: row.order.customerNameSnapshot,
      buyerLegalName: row.order.buyerLegalName,
      billingAddress: row.order.billingAddressSnapshot,
      shippingAddress: row.order.shippingAddressSnapshot,
    },
    lines,
  };
}

/** `INV/2627/000001` → `INV-2627-000001.pdf` (API_DOCUMENTATION §3.10). */
export function pdfFilename(invoiceNumber: string): string {
  return `${invoiceNumber.replace(/[^A-Za-z0-9-]+/g, '-')}.pdf`;
}

/** IST `DD-MM-YYYY`. */
export function istDisplayDate(date: Date): string {
  const { year, month, day } = istParts(date);
  return `${String(day).padStart(2, '0')}-${String(month).padStart(2, '0')}-${String(year)}`;
}

/** Indian digit grouping: `432000.5` → `4,32,000.50`. */
export function formatInr(value: Decimal): string {
  const [intPart = '0', frac = '00'] = toMoneyString(value.abs()).split('.');
  const last3 = intPart.slice(-3);
  const rest = intPart.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${value.isNegative() ? '-' : ''}${rest === '' ? last3 : `${rest},${last3}`}.${frac}`;
}

const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function below1000(n: number): string {
  const parts: string[] = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds > 0) parts.push(`${ONES[hundreds] ?? ''} Hundred`);
  if (rest > 0 && rest < 20) parts.push(ONES[rest] ?? '');
  else if (rest >= 20) {
    parts.push(
      [TENS[Math.floor(rest / 10)] ?? '', ONES[rest % 10] ?? ''].filter(Boolean).join(' '),
    );
  }
  return parts.join(' ');
}

/** Indian-system amount in words: `4320.00` → `Rupees Four Thousand Three Hundred Twenty Only`. */
export function amountInWords(value: Decimal): string {
  const [intStr = '0', paiseStr = '00'] = toMoneyString(value.abs()).split('.');
  let n = Number(intStr);
  const chunks: string[] = [];
  const units: [number, string][] = [
    [10_000_000, 'Crore'],
    [100_000, 'Lakh'],
    [1_000, 'Thousand'],
  ];
  for (const [size, label] of units) {
    const q = Math.floor(n / size);
    if (q > 0) chunks.push(`${q >= 1000 ? amountWordsInt(q) : below1000(q)} ${label}`);
    n %= size;
  }
  if (n > 0) chunks.push(below1000(n));
  const rupees = chunks.length === 0 ? 'Zero' : chunks.join(' ');
  const paise = Number(paiseStr);
  return `Rupees ${rupees}${paise > 0 ? ` and ${below1000(paise)} Paise` : ''} Only`;
}

function amountWordsInt(n: number): string {
  return amountInWords(dec(n))
    .replace(/^Rupees /, '')
    .replace(/ Only$/, '');
}

interface AddressLike {
  fullName?: unknown;
  line1?: unknown;
  line2?: unknown;
  landmark?: unknown;
  city?: unknown;
  stateCode?: unknown;
  pincode?: unknown;
  phone?: unknown;
}

function addressLines(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const a = raw as AddressLike;
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() !== '' ? v : undefined;
  const cityLine = [str(a.city), str(a.pincode)].filter(Boolean).join(' - ');
  return [
    str(a.fullName),
    str(a.line1),
    str(a.line2),
    str(a.landmark),
    cityLine === '' ? undefined : cityLine,
    str(a.stateCode) === undefined ? undefined : `State code: ${String(a.stateCode)}`,
  ].filter((l): l is string => l !== undefined);
}

/** Strips characters outside WinAnsi that the standard fonts cannot draw. */
function printable(text: string): string {
  return Array.from(text)
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 63;
      if (code === 0x2013 || code === 0x2014) return '-';
      if (code === 0x20b9) return 'Rs.';
      return (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) ? ch : '?';
    })
    .join('');
}

export interface RenderOptions {
  /** Staff reprints are labelled (TAX_AND_GST_WORKFLOWS §16.4). */
  readonly reprint?: boolean;
  readonly generatedAt: Date;
}

/** Renders the document to a PDF buffer. */
export async function renderInvoicePdf(
  doc: InvoiceDocumentData,
  seller: Pick<TaxSettings, 'sellerLegalName' | 'sellerAddress'>,
  options: RenderOptions,
): Promise<Buffer> {
  const isCredit = doc.invoiceType === 'CREDIT_NOTE';
  const title = isCredit ? 'CREDIT NOTE' : 'TAX INVOICE';
  const pdf = new PDFDocument({
    size: 'A4',
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    info: { Title: `${title} ${doc.invoiceNumber}`, Creator: 'ecommerce-api' },
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    pdf.on('data', (chunk: Buffer) => chunks.push(chunk));
    pdf.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    pdf.on('error', reject);
  });
  const width = pdf.page.width - 2 * MARGIN;
  const text = (s: string): string => printable(s);

  pdf.fillColor(WINE).font('Helvetica-Bold').fontSize(16).text(title, MARGIN, MARGIN);
  pdf
    .font('Helvetica')
    .fontSize(8)
    .fillColor(GREY)
    .text(options.reprint === true ? 'REPRINT - Duplicate copy' : 'Original for Recipient', {
      align: 'right',
    });
  pdf.moveDown(0.5).fillColor('#000000').font('Helvetica-Bold').fontSize(10);
  pdf.text(text(seller.sellerLegalName ?? 'Seller legal name not configured'));
  pdf.font('Helvetica').fontSize(8);
  if (seller.sellerAddress !== null) {
    const a = seller.sellerAddress;
    pdf.text(text([a.line1, a.line2, `${a.city} - ${a.pincode}`].filter(Boolean).join(', ')));
  }
  pdf.text(
    text(
      `GSTIN: ${doc.sellerGstin ?? 'not registered'} | State: ${doc.sellerStateName} (${doc.sellerStateCode})`,
    ),
  );
  pdf.moveDown(0.6);

  const meta: [string, string][] = [
    [isCredit ? 'Credit note No' : 'Invoice No', doc.invoiceNumber],
    [isCredit ? 'Credit note date' : 'Invoice date', istDisplayDate(doc.invoiceDate)],
    ['Order No', doc.order.orderNumber],
    ['Order date', istDisplayDate(doc.order.placedAt)],
    ['Place of supply', `${doc.posStateName} (${doc.posStateCode})`],
    ['Reverse charge', 'No'],
  ];
  if (doc.originalInvoice !== null) {
    meta.push([
      'Against invoice',
      `${doc.originalInvoice.invoiceNumber} dated ${istDisplayDate(doc.originalInvoice.invoiceDate)}`,
    ]);
  }
  if (doc.refundNumber !== null) meta.push(['Refund reference', doc.refundNumber]);
  for (const [label, value] of meta) pdf.text(text(`${label}: ${value}`));
  pdf.moveDown(0.6);

  const top = pdf.y;
  const half = width / 2 - 6;
  pdf.font('Helvetica-Bold').text('Bill to', MARGIN, top, { width: half });
  pdf.font('Helvetica');
  const billLines = [
    doc.order.buyerLegalName ?? doc.order.customerName,
    ...addressLines(doc.order.billingAddress).slice(1),
    ...(doc.buyerGstin === null ? [] : [`GSTIN: ${doc.buyerGstin}`]),
  ];
  for (const l of billLines) pdf.text(text(l), { width: half });
  const leftBottom = pdf.y;
  pdf.font('Helvetica-Bold').text('Ship to', MARGIN + half + 12, top, { width: half });
  pdf.font('Helvetica');
  for (const l of addressLines(doc.order.shippingAddress)) {
    pdf.text(text(l), MARGIN + half + 12, pdf.y, { width: half });
  }
  pdf.x = MARGIN;
  pdf.y = Math.max(leftBottom, pdf.y) + 10;

  // Line table.
  const componentNames = [
    ...new Set(doc.lines.flatMap((l) => l.components.map((c) => c.component))),
  ];
  const columns: { label: string; w: number; right?: boolean }[] = [
    { label: '#', w: 0.04 },
    { label: 'Description', w: 0.3 },
    { label: 'HSN', w: 0.08 },
    { label: 'Qty', w: 0.05, right: true },
    { label: 'Rate %', w: 0.07, right: true },
    { label: 'Taxable', w: 0.12, right: true },
    ...componentNames.map((c) => ({
      label: c,
      w: 0.22 / Math.max(1, componentNames.length),
      right: true,
    })),
    { label: 'Total', w: 0.12, right: true },
  ];
  const row = (cells: string[], bold: boolean): void => {
    const y = pdf.y;
    let x = MARGIN;
    pdf
      .font(bold ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(7)
      .fillColor('#000000');
    let height = 12;
    columns.forEach((col, i) => {
      const w = col.w * width;
      pdf.text(text(cells[i] ?? ''), x + 2, y, {
        width: w - 4,
        align: col.right ? 'right' : 'left',
      });
      height = Math.max(height, pdf.y - y);
      x += w;
    });
    pdf
      .moveTo(MARGIN, y + height + 1)
      .lineTo(MARGIN + width, y + height + 1)
      .strokeColor(LINE)
      .lineWidth(0.5)
      .stroke();
    pdf.x = MARGIN;
    pdf.y = y + height + 3;
    if (pdf.y > pdf.page.height - MARGIN - 120) pdf.addPage();
  };
  row(
    columns.map((c) => c.label),
    true,
  );
  doc.lines.forEach((l, i) => {
    row(
      [
        String(i + 1),
        l.description,
        l.hsnCode,
        l.quantity === null ? '' : String(l.quantity),
        l.rate.toFixed(2),
        formatInr(l.taxableValue),
        ...componentNames.map((c) => {
          const amount = l.components.find((x) => x.component === c)?.amount;
          return amount === undefined ? '-' : formatInr(amount);
        }),
        formatInr(l.total),
      ],
      false,
    );
  });

  pdf.moveDown(0.5).font('Helvetica').fontSize(8);
  const componentTotals = componentNames.map(
    (c) =>
      `${c} ${formatInr(sum(doc.lines.flatMap((l) => l.components.filter((x) => x.component === c).map((x) => x.amount))))}`,
  );
  pdf.text(
    text(
      [
        `Taxable total ${formatInr(doc.taxableTotal)}`,
        ...componentTotals,
        `Round off ${formatInr(doc.roundOff)}`,
      ].join(' | '),
    ),
  );
  pdf
    .font('Helvetica-Bold')
    .fontSize(10)
    .text(text(`GRAND TOTAL Rs. ${formatInr(doc.grandTotal)}`));
  pdf
    .font('Helvetica')
    .fontSize(8)
    .text(text(`Amount in words: ${amountInWords(doc.grandTotal)}`));
  pdf.text(text(`Payment: ${doc.order.paymentMethod}`));
  pdf.moveDown(1);
  pdf.text(text(`For ${seller.sellerLegalName ?? 'the seller'} - Authorised Signatory`), {
    align: 'right',
  });
  pdf.moveDown(1).fillColor(GREY).fontSize(7);
  pdf.text(
    text(
      `Generated ${istDisplayDate(options.generatedAt)} from the issued document record. Tax computation is illustrative pending review by a qualified tax professional.`,
    ),
  );
  pdf.end();
  return done;
}

/** Loads + renders in one step (settings read at render time — see header note). */
export async function buildInvoicePdf(
  db: Queryable,
  lookup: InvoiceLookup,
  options: RenderOptions,
): Promise<{ pdf: Buffer; filename: string; document: InvoiceDocumentData }> {
  const document = await loadInvoiceDocument(db, lookup);
  const settings = await loadTaxSettings(db);
  const pdf = await renderInvoicePdf(document, settings, options);
  return { pdf, filename: pdfFilename(document.invoiceNumber), document };
}

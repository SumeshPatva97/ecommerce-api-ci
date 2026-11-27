/**
 * Invoices & credit notes (B7) — TAX_AND_GST_WORKFLOWS.md §16–§19.
 * MOCKED DB (tests/helpers/mockDb.ts): verifies ledger maths, numbering calls, row shapes and the
 * PDF output; no SQL is executed.
 */
import { randomUUID } from 'node:crypto';
import { inflateSync } from 'node:zlib';

import { describe, expect, it, vi } from 'vitest';

import type { TxClient } from '../../../../src/core/db/transaction.js';
import { createLogger } from '../../../../src/core/logger/logger.js';
import { Decimal } from '../../../../src/lib/money.js';
import { createAuditService } from '../../../../src/modules/audit/audit.service.js';
import {
  amountInWords,
  buildInvoicePdf,
  formatInr,
  invoiceGroups,
  issueCreditNote,
  issueInvoiceForOrder,
  pdfFilename,
  prorateGroup,
  remainingGroups,
  renderInvoicePdf,
  type InvoiceDocumentData,
  type LedgerGroup,
} from '../../../../src/modules/invoices/index.js';
import { createNotificationService } from '../../../../src/modules/notifications/index.js';
import { advanceOrderForShipment } from '../../../../src/modules/shipping/index.js';
import { createMockDb } from '../../../helpers/mockDb.js';
import { testConfig } from '../../../helpers/testApp.js';

const NOW = new Date('2026-11-19T06:30:00.000Z'); // FY 2026-27 → "2627"
const ORDER_ID = '0b9a7c1e-1111-4a2b-9c3d-000000000001';
const L1 = '0b9a7c1e-1111-4a2b-9c3d-0000000000a1';
const L2 = '0b9a7c1e-1111-4a2b-9c3d-0000000000a2';

/** Worked example A (TAX_AND_GST §12): mixed-rate cart, intra-state, inclusive, ₹100 shipping. */
function exampleOrder(over: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    orderNumber: 'ORD-261119-00001',
    status: 'SHIPPED',
    userId: randomUUID(),
    paymentMethod: 'ONLINE',
    supplyType: 'INTRA_STATE' as const,
    pricesIncludeTax: true,
    shippingCharge: new Decimal('100.00'),
    shippingDiscount: new Decimal('0.00'),
    taxableTotal: new Decimal('3909.50'),
    cgstTotal: new Decimal('205.25'),
    sgstTotal: new Decimal('205.25'),
    utgstTotal: new Decimal('0.00'),
    igstTotal: new Decimal('0.00'),
    grandTotal: new Decimal('4320.00'),
    sellerGstinSnapshot: '27ABCDE1234F1Z5',
    sellerStateCodeSnapshot: '27',
    buyerGstin: null,
    placeOfSupplyStateCode: '27',
    customerPhoneSnapshot: null,
    user: { firstName: 'Riya', email: 'riya@example.com', phone: '+919812345678' },
    items: [
      {
        id: L1,
        hsnCode: '7113',
        quantity: 1,
        taxRate: new Decimal('3.00'),
        taxableValue: new Decimal('1909.51'),
        lineTotal: new Decimal('1966.79'),
        utgstRate: new Decimal('0'),
        cgstAmount: new Decimal('28.64'),
        sgstAmount: new Decimal('28.64'),
        utgstAmount: new Decimal('0'),
        igstAmount: new Decimal('0'),
      },
      {
        id: L2,
        hsnCode: '9999',
        quantity: 2,
        taxRate: new Decimal('18.00'),
        taxableValue: new Decimal('1909.49'),
        lineTotal: new Decimal('2253.21'),
        utgstRate: new Decimal('0'),
        cgstAmount: new Decimal('171.86'),
        sgstAmount: new Decimal('171.86'),
        utgstAmount: new Decimal('0'),
        igstAmount: new Decimal('0'),
      },
    ],
    ...over,
  };
}

const tx = (db: unknown): TxClient => db as TxClient;

interface DocData {
  taxableTotal: Decimal;
  taxTotal: Decimal;
  grandTotal: Decimal;
  invoiceDate: Date;
  [key: string]: unknown;
}
const money = (d: Decimal): string => d.toFixed(2);
const comp = (g: LedgerGroup, c: string): string =>
  money(g.components.find((x) => x.component === c)?.amount ?? new Decimal(-1));

describe('invoice ledger (pure)', () => {
  it('splits goods per line and re-allocates shipping PROPORTIONALLY (worked example A)', () => {
    const groups = invoiceGroups(exampleOrder());
    expect(groups.map((g) => `${g.lineType}:${g.orderItemId ?? '-'}`)).toEqual([
      `ITEM:${L1}`,
      `ITEM:${L2}`,
      `SHIPPING:${L1}`,
      `SHIPPING:${L2}`,
    ]);
    const [, , s1, s2] = groups;
    expect(s1 && [money(s1.taxableValue), comp(s1, 'CGST'), comp(s1, 'SGST')]).toEqual([
      '45.25',
      '0.68',
      '0.68',
    ]);
    expect(s2 && [money(s2.taxableValue), comp(s2, 'CGST'), money(s2.rate)]).toEqual([
      '45.25',
      '4.07',
      '18.00',
    ]);
  });

  it('falls back to one residual shipping row when the split cannot be reproduced', () => {
    const groups = invoiceGroups(
      exampleOrder({ taxableTotal: new Decimal('3909.00'), cgstTotal: new Decimal('205.00') }),
    );
    const shipping = groups.filter((g) => g.lineType === 'SHIPPING');
    expect(shipping).toHaveLength(1);
    expect(shipping[0]?.orderItemId).toBeNull();
    expect(shipping[0] && money(shipping[0].taxableValue)).toBe('90.00');
  });

  it('uses IGST only for inter-state orders', () => {
    const order = exampleOrder({
      supplyType: 'INTER_STATE',
      cgstTotal: new Decimal('0'),
      sgstTotal: new Decimal('0'),
      igstTotal: new Decimal('410.50'),
      items: exampleOrder().items.map((i) => ({
        ...i,
        igstAmount: i.cgstAmount.plus(i.sgstAmount),
        cgstAmount: new Decimal(0),
        sgstAmount: new Decimal(0),
      })),
    });
    const groups = invoiceGroups(order);
    expect(new Set(groups.flatMap((g) => g.components.map((c) => c.component)))).toEqual(
      new Set(['IGST']),
    );
  });

  it('pro-rates a partial credit and gives the remainder to the last unit (§18.4)', () => {
    const [, l2] = invoiceGroups(exampleOrder());
    if (l2 === undefined) throw new Error('missing line');
    const first = prorateGroup(l2, l2, new Decimal(1).dividedBy(2), false);
    expect([money(first.taxableValue), comp(first, 'CGST'), comp(first, 'SGST')]).toEqual([
      '954.75',
      '85.93',
      '85.93',
    ]);
    const [remaining] = remainingGroups([l2], [first]);
    if (remaining === undefined) throw new Error('missing remainder');
    const last = prorateGroup(l2, remaining, new Decimal(1).dividedBy(2), true);
    expect([money(last.taxableValue), comp(last, 'CGST')]).toEqual(['954.74', '85.93']);
  });
});

describe('issueInvoiceForOrder', () => {
  function setup(order = exampleOrder()) {
    const { db, m } = createMockDb();
    m.invoiceRecord.findFirst.mockResolvedValue(null);
    m.order.findUnique.mockResolvedValue(order);
    m.notification.findUnique.mockResolvedValue(null);
    return { db, m };
  }

  it('allocates a gap-free INV number in the same transaction and writes the ledger', async () => {
    const { db, m } = setup();
    const issued = await issueInvoiceForOrder(tx(db), ORDER_ID, NOW, {
      storefrontUrl: 'https://shop.example',
    });
    expect(issued).toMatchObject({ invoiceNumber: 'INV/2627/000001', created: true });
    // lock order row, then lock/create the INVOICE sequence row
    expect(m.$queryRaw).toHaveBeenCalledTimes(2);
    expect(m.numberSequence.create.mock.calls[0]?.[0].data).toMatchObject({
      sequenceKey: 'INVOICE',
      periodKey: '2627',
      isGapFree: true,
    });
    const data = m.invoiceRecord.create.mock.calls[0]?.[0].data as DocData;
    expect(data).toMatchObject({
      invoiceType: 'TAX_INVOICE',
      financialYear: '2627',
      sequenceNo: 1,
      pdfStorageKey: null,
      sellerStateCode: '27',
    });
    expect(money(data.taxableTotal)).toBe('3909.50');
    expect(money(data.taxTotal)).toBe('410.50');
    expect(data.invoiceDate.toISOString()).toBe('2026-11-19T00:00:00.000Z');
    const rows = m.taxTransaction.createMany.mock.calls[0]?.[0].data as {
      documentType: string;
      amount: Decimal;
      component: string;
    }[];
    expect(rows).toHaveLength(8);
    expect(rows.every((r) => r.documentType === 'TAX_INVOICE')).toBe(true);
    const events = m.notification.create.mock.calls.map((c): unknown => c[0].data.event);
    expect(events).toEqual(['INVOICE_AVAILABLE']);
  });

  it('continues an existing FY series (next_value 42 → INV/2627/000042)', async () => {
    const { db, m } = setup();
    m.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ next_value: 42 }]);
    const issued = await issueInvoiceForOrder(tx(db), ORDER_ID, NOW);
    expect(issued?.invoiceNumber).toBe('INV/2627/000042');
    expect(m.numberSequence.update.mock.calls[0]?.[0].data).toEqual({ nextValue: 43 });
  });

  it('is idempotent: one invoice per order (OQ-67)', async () => {
    const { db, m } = setup();
    m.invoiceRecord.findFirst.mockResolvedValue({
      id: randomUUID(),
      invoiceNumber: 'INV/2627/000007',
      invoiceType: 'TAX_INVOICE',
    });
    const issued = await issueInvoiceForOrder(tx(db), ORDER_ID, NOW);
    expect(issued).toMatchObject({ invoiceNumber: 'INV/2627/000007', created: false });
    expect(m.invoiceRecord.create).not.toHaveBeenCalled();
  });

  it('audits a newly issued invoice once (invoice.issued), never on the idempotent re-call', async () => {
    const { db, m } = setup();
    const record = vi.fn(() => Promise.resolve());
    const actor = { type: 'WEBHOOK', loginType: 'WEBHOOK' } as const;
    await issueInvoiceForOrder(tx(db), ORDER_ID, NOW, { audit: { service: { record }, actor } });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.anything(),
      actor,
      expect.objectContaining({
        action: 'CREATE',
        module: 'invoices',
        entityType: 'InvoiceRecord',
        eventKey: 'invoice.issued',
        after: expect.objectContaining({
          invoiceNumber: 'INV/2627/000001',
          taxableTotal: '3909.50',
          taxTotal: '410.50',
        }),
        metadata: expect.objectContaining({ entityLabel: 'INV/2627/000001' }),
      }),
    );
    m.invoiceRecord.findFirst.mockResolvedValue({
      id: randomUUID(),
      invoiceNumber: 'INV/2627/000001',
      invoiceType: 'TAX_INVOICE',
    });
    await issueInvoiceForOrder(tx(db), ORDER_ID, NOW, { audit: { service: { record }, actor } });
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('refuses cancelled / unpaid orders', async () => {
    const { db } = setup(exampleOrder({ status: 'CANCELLED' }));
    await expect(issueInvoiceForOrder(tx(db), ORDER_ID, NOW)).rejects.toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
    });
  });
});

describe('issueCreditNote', () => {
  const INVOICE_ID = randomUUID();
  function ledgerRows() {
    return invoiceGroups(exampleOrder()).flatMap((g) =>
      g.components.map((c) => ({
        orderItemId: g.orderItemId,
        lineType: g.lineType,
        component: c.component,
        hsnCode: g.hsnCode,
        rate: g.rate,
        taxableValue: g.taxableValue,
        amount: c.amount,
      })),
    );
  }
  function setup() {
    const { db, m } = createMockDb();
    m.invoiceRecord.findFirst
      .mockResolvedValueOnce({
        id: INVOICE_ID,
        sellerGstin: '27ABCDE1234F1Z5',
        sellerStateCode: '27',
        buyerGstin: null,
        placeOfSupplyStateCode: '27',
        supplyType: 'INTRA_STATE',
        taxTransactions: ledgerRows(),
      })
      .mockResolvedValueOnce(null);
    m.invoiceRecord.findMany.mockResolvedValue([]);
    m.orderItem.findMany.mockResolvedValue([
      { id: L1, quantity: 1 },
      { id: L2, quantity: 2 },
    ]);
    return { db, m };
  }

  it('returns null when the order has no invoice (§18.1)', async () => {
    const { db, m } = createMockDb();
    m.invoiceRecord.findFirst.mockResolvedValue(null);
    const cn = await issueCreditNote(tx(db), {
      orderId: ORDER_ID,
      refundId: null,
      scope: { kind: 'FULL' },
      now: NOW,
    });
    expect(cn).toBeNull();
    expect(m.invoiceRecord.create).not.toHaveBeenCalled();
  });

  it('full credit note: CN/2627/000001, positive totals, NEGATIVE ledger rows', async () => {
    const { db, m } = setup();
    const refundId = randomUUID();
    const cn = await issueCreditNote(tx(db), {
      orderId: ORDER_ID,
      refundId,
      scope: { kind: 'FULL' },
      now: NOW,
    });
    expect(cn).toMatchObject({ invoiceNumber: 'CN/2627/000001', invoiceType: 'CREDIT_NOTE' });
    expect(m.numberSequence.create.mock.calls[0]?.[0].data.sequenceKey).toBe('CREDIT_NOTE');
    const data = m.invoiceRecord.create.mock.calls[0]?.[0].data as DocData;
    expect(data).toMatchObject({ originalInvoiceId: INVOICE_ID, refundId });
    expect([money(data.taxableTotal), money(data.taxTotal), money(data.grandTotal)]).toEqual([
      '3909.50',
      '410.50',
      '4320.00',
    ]);
    const rows = m.taxTransaction.createMany.mock.calls[0]?.[0].data as {
      amount: Decimal;
      taxableValue: Decimal;
      documentType: string;
    }[];
    expect(rows.every((r) => r.documentType === 'CREDIT_NOTE' && r.amount.lte(0))).toBe(true);
    expect(rows.every((r) => r.taxableValue.isNegative())).toBe(true);
  });

  it('partial credit note pro-rates 1 of 2 units', async () => {
    const { db, m } = setup();
    await issueCreditNote(tx(db), {
      orderId: ORDER_ID,
      refundId: randomUUID(),
      scope: {
        kind: 'PARTIAL',
        items: [{ orderItemId: L2, quantity: 1 }],
        shippingAmount: new Decimal(0),
      },
      now: NOW,
    });
    const rows = m.taxTransaction.createMany.mock.calls[0]?.[0].data as {
      component: string;
      amount: Decimal;
      taxableValue: Decimal;
    }[];
    expect(rows.map((r) => [r.component, money(r.taxableValue), money(r.amount)])).toEqual([
      ['CGST', '-954.75', '-85.93'],
      ['SGST', '-954.75', '-85.93'],
    ]);
  });
});

describe('invoice PDF', () => {
  const doc: InvoiceDocumentData = {
    id: randomUUID(),
    invoiceType: 'TAX_INVOICE',
    invoiceNumber: 'INV/2627/000001',
    invoiceDate: new Date('2026-11-19T00:00:00.000Z'),
    sellerGstin: '27ABCDE1234F1Z5',
    sellerStateCode: '27',
    sellerStateName: 'Maharashtra',
    buyerGstin: null,
    posStateCode: '27',
    posStateName: 'Maharashtra',
    taxableTotal: new Decimal('3909.50'),
    taxTotal: new Decimal('410.50'),
    grandTotal: new Decimal('4320.00'),
    roundOff: new Decimal('0'),
    originalInvoice: null,
    refundNumber: null,
    order: {
      orderNumber: 'ORD-261119-00001',
      placedAt: NOW,
      paymentMethod: 'ONLINE',
      customerName: 'Riya Sharma',
      buyerLegalName: null,
      billingAddress: {
        fullName: 'Riya Sharma',
        line1: '12 MG Road',
        city: 'Pune',
        pincode: '411001',
      },
      shippingAddress: {
        fullName: 'Riya Sharma',
        line1: '12 MG Road',
        city: 'Pune',
        pincode: '411001',
      },
    },
    lines: [
      {
        description: 'Silver ring (SKU RNG-7)',
        hsnCode: '7113',
        quantity: 1,
        rate: new Decimal('3'),
        taxableValue: new Decimal('1909.51'),
        components: [
          { component: 'CGST', amount: new Decimal('28.64') },
          { component: 'SGST', amount: new Decimal('28.64') },
        ],
        total: new Decimal('1966.79'),
      },
    ],
  };

  it('renders a PDF whose metadata carries the document number', async () => {
    const pdf = await renderInvoicePdf(
      doc,
      { sellerLegalName: 'Example Jewels Pvt Ltd', sellerAddress: null },
      { generatedAt: NOW, reprint: true },
    );
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.toString('latin1')).toContain('INV/2627/000001');
  });

  it('formats numbers, words and filenames the Indian way', () => {
    expect(formatInr(new Decimal('432000.5'))).toBe('4,32,000.50');
    expect(formatInr(new Decimal('999'))).toBe('999.00');
    expect(amountInWords(new Decimal('4320'))).toBe(
      'Rupees Four Thousand Three Hundred Twenty Only',
    );
    expect(amountInWords(new Decimal('1250000.50'))).toBe(
      'Rupees Twelve Lakh Fifty Thousand and Fifty Paise Only',
    );
    expect(pdfFilename('INV/2627/000001')).toBe('INV-2627-000001.pdf');
  });
});

describe('FR-TAX-013 invoice PDF content (per-line components and totals)', () => {
  interface PdfRun {
    readonly x: number;
    readonly y: number;
    readonly text: string;
  }

  /**
   * Text runs drawn on the page. PDFKit Flate-compresses the content stream; `node:zlib` (built in,
   * no extra dependency) inflates it and every `[<hex> kern <hex> …] TJ` operator — WinAnsi hex
   * strings of the standard Helvetica fonts — is one drawn run at the preceding `Tm` position.
   */
  function pdfRuns(pdf: Buffer): PdfRun[] {
    const runs: PdfRun[] = [];
    for (const stream of pdf.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
      let content: string;
      try {
        content = inflateSync(Buffer.from(stream[1] ?? '', 'latin1')).toString('latin1');
      } catch {
        continue; // not a Flate content stream
      }
      for (const block of content.matchAll(/BT\s([\s\S]*?)\sET/g)) {
        const body = block[1] ?? '';
        const tm = /1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm/.exec(body);
        const tj = /\[(.*)\] TJ/.exec(body);
        if (tm === null || tj === null) continue;
        const text = [...(tj[1] ?? '').matchAll(/<([0-9a-f]*)>/gi)]
          .map((hex) => Buffer.from(hex[1] ?? '', 'hex').toString('latin1'))
          .join('');
        runs.push({ x: Number(tm[1]), y: Number(tm[2]), text });
      }
    }
    return runs;
  }

  /** Runs sharing a baseline, top of page first, cells left to right (table rows → cell arrays). */
  function pdfRows(runs: readonly PdfRun[]): string[][] {
    const byY = new Map<number, PdfRun[]>();
    for (const run of runs) byY.set(run.y, [...(byY.get(run.y) ?? []), run]);
    return [...byY.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([, cells]) => [...cells].sort((a, b) => a.x - b.x).map((c) => c.text));
  }

  /** Lines printed under a block heading (`Bill to` / `Ship to`), down to the line table. */
  function blockLines(runs: readonly PdfRun[], heading: string): string[] {
    const head = runs.find((r) => r.text === heading);
    const table = runs.find((r) => r.text === '#');
    if (head === undefined || table === undefined) throw new Error(`"${heading}" block not found`);
    return runs
      .filter((r) => Math.abs(r.x - head.x) < 0.01 && r.y < head.y && r.y > table.y)
      .sort((a, b) => b.y - a.y)
      .map((r) => r.text);
  }

  const INVOICE_ID = '0b9a7c1e-1111-4a2b-9c3d-0000000000f1';

  /** One `tax_transactions` row (line × component) as selected by the PDF loader. */
  const ledger = (
    orderItemId: string | null,
    lineType: 'ITEM' | 'SHIPPING',
    component: 'CGST' | 'SGST' | 'IGST',
    hsnCode: string,
    rate: string,
    taxableValue: string,
    amount: string,
  ) => ({
    orderItemId,
    lineType,
    component,
    hsnCode,
    rate: new Decimal(rate),
    taxableValue: new Decimal(taxableValue),
    amount: new Decimal(amount),
  });

  /** `invoice_records` row + relations for worked example A (₹4,320.00, mixed 3 % / 18 % cart). */
  function invoiceRow(over: Record<string, unknown> = {}) {
    return {
      id: INVOICE_ID,
      invoiceType: 'TAX_INVOICE',
      invoiceNumber: 'INV/2627/000001',
      invoiceDate: new Date('2026-11-19T00:00:00.000Z'),
      sellerGstin: '27ABCDE1234F1Z5',
      sellerStateCode: '27',
      buyerGstin: null,
      placeOfSupplyStateCode: '27',
      supplyType: 'INTRA_STATE',
      taxableTotal: new Decimal('3909.50'),
      taxTotal: new Decimal('410.50'),
      grandTotal: new Decimal('4320.00'),
      createdAt: NOW,
      sellerState: { name: 'Maharashtra' },
      posState: { name: 'Maharashtra' },
      originalInvoice: null,
      refund: null,
      // Stored order is irrelevant: the document sorts goods by line number, then shipping.
      taxTransactions: [
        ledger(L2, 'SHIPPING', 'CGST', '9999', '18.00', '45.25', '4.07'),
        ledger(L2, 'SHIPPING', 'SGST', '9999', '18.00', '45.25', '4.07'),
        ledger(L2, 'ITEM', 'CGST', '9999', '18.00', '1909.49', '171.86'),
        ledger(L2, 'ITEM', 'SGST', '9999', '18.00', '1909.49', '171.86'),
        ledger(L1, 'SHIPPING', 'CGST', '7113', '3.00', '45.25', '0.68'),
        ledger(L1, 'SHIPPING', 'SGST', '7113', '3.00', '45.25', '0.68'),
        ledger(L1, 'ITEM', 'CGST', '7113', '3.00', '1909.51', '28.64'),
        ledger(L1, 'ITEM', 'SGST', '7113', '3.00', '1909.51', '28.64'),
      ],
      order: {
        orderNumber: 'ORD-261118-00001',
        placedAt: new Date('2026-11-17T19:00:00.000Z'), // 18 Nov 00:30 IST
        paymentMethod: 'ONLINE',
        roundOff: new Decimal('0.00'),
        customerNameSnapshot: 'Riya Sharma',
        buyerLegalName: null,
        billingAddressSnapshot: {
          fullName: 'Riya Sharma',
          line1: '12 MG Road',
          city: 'Pune',
          pincode: '411001',
          stateCode: '27',
        },
        shippingAddressSnapshot: {
          fullName: 'Asha Sharma',
          line1: '4 Lake View',
          line2: 'Baner',
          city: 'Pune',
          pincode: '411045',
          stateCode: '27',
        },
        items: [
          {
            id: L1,
            lineNo: 1,
            productName: 'Silver ring',
            variantName: 'Size 7',
            sku: 'RNG-7',
            quantity: 1,
          },
          {
            id: L2,
            lineNo: 2,
            productName: 'Gift hamper',
            variantName: null,
            sku: 'HMP-2',
            quantity: 2,
          },
        ],
      },
      ...over,
    };
  }

  function setup(row: Record<string, unknown>) {
    const { db, m } = createMockDb();
    m.invoiceRecord.findFirst.mockResolvedValue(row);
    // Seller legal name / address are read from the current tax settings at render time.
    m.setting.findMany.mockResolvedValue([
      { settingKey: 'tax.seller_legal_name', value: 'Example Jewels Pvt Ltd' },
      {
        settingKey: 'tax.seller_address',
        value: { line1: '1 Zaveri Bazaar', city: 'Mumbai', pincode: '400002' },
      },
    ]);
    return { db, m };
  }

  const lineView = (document: InvoiceDocumentData) =>
    document.lines.map((l) => ({
      description: l.description,
      hsnCode: l.hsnCode,
      quantity: l.quantity,
      rate: l.rate.toFixed(2),
      taxableValue: money(l.taxableValue),
      components: l.components.map((c) => `${c.component} ${money(c.amount)}`),
      total: money(l.total),
    }));

  it('FR-TAX-013: intra-state tax invoice prints seller/buyer blocks, number/date and per-line HSN, taxable value, CGST/SGST and totals', async () => {
    const { db, m } = setup(invoiceRow());
    const { pdf, filename, document } = await buildInvoicePdf(
      db,
      { orderId: ORDER_ID, type: 'TAX_INVOICE' },
      { generatedAt: NOW },
    );
    expect(m.invoiceRecord.findFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { orderId: ORDER_ID, invoiceType: 'TAX_INVOICE' },
      orderBy: { createdAt: 'desc' },
    });
    expect(filename).toBe('INV-2627-000001.pdf');

    // 1) Document model handed to the renderer: one line per (order line × line type); line total
    //    = taxable + its components: 1909.51 + 28.64 + 28.64 = 1966.79; 1909.49 + 171.86 + 171.86
    //    = 2253.21; shipping 45.25 + 0.68 + 0.68 = 46.61 and 45.25 + 4.07 + 4.07 = 53.39.
    expect(lineView(document)).toEqual([
      {
        description: 'Silver ring - Size 7 (SKU RNG-7)',
        hsnCode: '7113',
        quantity: 1,
        rate: '3.00',
        taxableValue: '1909.51',
        components: ['CGST 28.64', 'SGST 28.64'],
        total: '1966.79',
      },
      {
        description: 'Gift hamper (SKU HMP-2)',
        hsnCode: '9999',
        quantity: 2,
        rate: '18.00',
        taxableValue: '1909.49',
        components: ['CGST 171.86', 'SGST 171.86'],
        total: '2253.21',
      },
      {
        description: 'Shipping',
        hsnCode: '7113',
        quantity: null,
        rate: '3.00',
        taxableValue: '45.25',
        components: ['CGST 0.68', 'SGST 0.68'],
        total: '46.61',
      },
      {
        description: 'Shipping',
        hsnCode: '9999',
        quantity: null,
        rate: '18.00',
        taxableValue: '45.25',
        components: ['CGST 4.07', 'SGST 4.07'],
        total: '53.39',
      },
    ]);
    // The lines add up to the document totals: 1909.51 + 1909.49 + 45.25 + 45.25 = 3909.50;
    // 1966.79 + 2253.21 + 46.61 + 53.39 = 4320.00 = taxable 3909.50 + tax 410.50.
    expect(money(document.lines.reduce((a, l) => a.plus(l.taxableValue), new Decimal(0)))).toBe(
      money(document.taxableTotal),
    );
    expect(money(document.lines.reduce((a, l) => a.plus(l.total), new Decimal(0)))).toBe(
      money(document.grandTotal),
    );
    expect([
      money(document.taxableTotal),
      money(document.taxTotal),
      money(document.grandTotal),
    ]).toEqual(['3909.50', '410.50', '4320.00']);

    // 2) Text actually drawn in the PDF.
    const runs = pdfRuns(pdf);
    const texts = runs.map((r) => r.text);
    const rows = pdfRows(runs);
    expect(texts).toContain('TAX INVOICE');
    expect(texts).toContain('Original for Recipient');
    // Seller block.
    expect(texts).toContain('Example Jewels Pvt Ltd');
    expect(texts).toContain('1 Zaveri Bazaar, Mumbai - 400002');
    expect(texts).toContain('GSTIN: 27ABCDE1234F1Z5 | State: Maharashtra (27)');
    // Invoice number / dates (IST) / place of supply.
    expect(texts).toContain('Invoice No: INV/2627/000001');
    expect(texts).toContain('Invoice date: 19-11-2026');
    expect(texts).toContain('Order No: ORD-261118-00001');
    expect(texts).toContain('Order date: 18-11-2026');
    expect(texts).toContain('Place of supply: Maharashtra (27)');
    // Buyer blocks.
    expect(blockLines(runs, 'Bill to')).toEqual([
      'Riya Sharma',
      '12 MG Road',
      'Pune - 411001',
      'State code: 27',
    ]);
    expect(blockLines(runs, 'Ship to')).toEqual([
      'Asha Sharma',
      '4 Lake View',
      'Baner',
      'Pune - 411045',
      'State code: 27',
    ]);
    // Line table: header + one row per line with HSN, rate, taxable value, each component, total.
    const header = rows.findIndex((r) => r[0] === '#');
    expect(rows.slice(header, header + 5)).toEqual([
      ['#', 'Description', 'HSN', 'Qty', 'Rate %', 'Taxable', 'CGST', 'SGST', 'Total'],
      [
        '1',
        'Silver ring - Size 7 (SKU RNG-7)',
        '7113',
        '1',
        '3.00',
        '1,909.51',
        '28.64',
        '28.64',
        '1,966.79',
      ],
      [
        '2',
        'Gift hamper (SKU HMP-2)',
        '9999',
        '2',
        '18.00',
        '1,909.49',
        '171.86',
        '171.86',
        '2,253.21',
      ],
      // Shipping lines carry no quantity (blank cell → nothing drawn).
      ['3', 'Shipping', '7113', '3.00', '45.25', '0.68', '0.68', '46.61'],
      ['4', 'Shipping', '9999', '18.00', '45.25', '4.07', '4.07', '53.39'],
    ]);
    // Totals: CGST 28.64 + 171.86 + 0.68 + 4.07 = 205.25 (same for SGST).
    expect(texts).toContain('Taxable total 3,909.50 | CGST 205.25 | SGST 205.25 | Round off 0.00');
    expect(texts).toContain('GRAND TOTAL Rs. 4,320.00');
    expect(texts).toContain('Amount in words: Rupees Four Thousand Three Hundred Twenty Only');
    expect(texts).toContain('Payment: ONLINE');
    expect(texts).toContain('For Example Jewels Pvt Ltd - Authorised Signatory');
    expect(texts.join('\n')).not.toContain('IGST');
  });

  it('FR-TAX-013: inter-state tax invoice prints a single IGST component, buyer GSTIN and round-off', async () => {
    // Inter-state supply (Maharashtra → Karnataka): IGST 57.28 + 343.72 on goods, one residual
    // shipping row 90.50 + 9.10. Taxable 1909.51 + 1909.49 + 90.50 = 3909.50; IGST
    // 57.28 + 343.72 + 9.10 = 410.10; 3909.50 + 410.10 = 4319.60, round-off +0.40 → 4320.00.
    const base = invoiceRow();
    const { db } = setup(
      invoiceRow({
        supplyType: 'INTER_STATE',
        buyerGstin: '29AAACS1234K1Z6',
        placeOfSupplyStateCode: '29',
        posState: { name: 'Karnataka' },
        taxTotal: new Decimal('410.10'),
        grandTotal: new Decimal('4320.00'),
        taxTransactions: [
          ledger(null, 'SHIPPING', 'IGST', '7113', '10.06', '90.50', '9.10'),
          ledger(L1, 'ITEM', 'IGST', '7113', '3.00', '1909.51', '57.28'),
          ledger(L2, 'ITEM', 'IGST', '9999', '18.00', '1909.49', '343.72'),
        ],
        order: {
          ...base.order,
          buyerLegalName: 'Sharma Traders LLP',
          paymentMethod: 'COD',
          roundOff: new Decimal('0.40'),
          shippingAddressSnapshot: {
            fullName: 'Asha Sharma',
            line1: '7 Residency Road',
            city: 'Bengaluru',
            pincode: '560025',
            stateCode: '29',
          },
        },
      }),
    );
    const { pdf, document } = await buildInvoicePdf(
      db,
      { orderId: ORDER_ID, type: 'TAX_INVOICE', invoiceNumber: 'INV/2627/000001' },
      { generatedAt: NOW, reprint: true },
    );
    expect(lineView(document)).toEqual([
      {
        description: 'Silver ring - Size 7 (SKU RNG-7)',
        hsnCode: '7113',
        quantity: 1,
        rate: '3.00',
        taxableValue: '1909.51',
        components: ['IGST 57.28'],
        total: '1966.79', // 1909.51 + 57.28
      },
      {
        description: 'Gift hamper (SKU HMP-2)',
        hsnCode: '9999',
        quantity: 2,
        rate: '18.00',
        taxableValue: '1909.49',
        components: ['IGST 343.72'],
        total: '2253.21', // 1909.49 + 343.72
      },
      {
        description: 'Shipping',
        hsnCode: '7113',
        quantity: null,
        rate: '10.06',
        taxableValue: '90.50',
        components: ['IGST 9.10'],
        total: '99.60', // 90.50 + 9.10
      },
    ]);
    expect([
      money(document.taxableTotal),
      money(document.taxTotal),
      money(document.roundOff),
      money(document.grandTotal),
    ]).toEqual(['3909.50', '410.10', '0.40', '4320.00']);

    const runs = pdfRuns(pdf);
    const texts = runs.map((r) => r.text);
    const rows = pdfRows(runs);
    expect(texts).toContain('REPRINT - Duplicate copy');
    expect(texts).toContain('Place of supply: Karnataka (29)');
    // B2B buyer: legal name replaces the customer name and the GSTIN closes the block.
    expect(blockLines(runs, 'Bill to')).toEqual([
      'Sharma Traders LLP',
      '12 MG Road',
      'Pune - 411001',
      'State code: 27',
      'GSTIN: 29AAACS1234K1Z6',
    ]);
    expect(blockLines(runs, 'Ship to')).toEqual([
      'Asha Sharma',
      '7 Residency Road',
      'Bengaluru - 560025',
      'State code: 29',
    ]);
    const header = rows.findIndex((r) => r[0] === '#');
    expect(rows.slice(header, header + 4)).toEqual([
      ['#', 'Description', 'HSN', 'Qty', 'Rate %', 'Taxable', 'IGST', 'Total'],
      [
        '1',
        'Silver ring - Size 7 (SKU RNG-7)',
        '7113',
        '1',
        '3.00',
        '1,909.51',
        '57.28',
        '1,966.79',
      ],
      ['2', 'Gift hamper (SKU HMP-2)', '9999', '2', '18.00', '1,909.49', '343.72', '2,253.21'],
      ['3', 'Shipping', '7113', '10.06', '90.50', '9.10', '99.60'],
    ]);
    // IGST total 57.28 + 343.72 + 9.10 = 410.10; no CGST / SGST anywhere on the document.
    expect(texts).toContain('Taxable total 3,909.50 | IGST 410.10 | Round off 0.40');
    expect(texts).toContain('GRAND TOTAL Rs. 4,320.00');
    expect(texts).toContain('Payment: COD');
    expect(texts.join('\n')).not.toMatch(/CGST|SGST/);
  });
});

describe('shipping → SHIPPED issues the invoice (narrow shipping.orders change)', () => {
  it('advanceOrderForShipment PACKED → SHIPPED writes the TAX_INVOICE in the same transaction', async () => {
    const { db, m } = createMockDb();
    m.order.findUnique.mockResolvedValue({
      ...exampleOrder({ status: 'PACKED' }),
      shippedAt: null,
      customerEmailSnapshot: 'riya@example.com',
      items: exampleOrder().items.map((i) => ({
        ...i,
        quantityShipped: i.quantity,
        quantityCancelled: 0,
      })),
      shipments: [{ status: 'SHIPPED' }],
    });
    m.invoiceRecord.findFirst.mockResolvedValue(null);
    m.notification.findUnique.mockResolvedValue(null);
    const logger = createLogger(testConfig());
    const result = await advanceOrderForShipment(
      tx(db),
      {
        audit: createAuditService(logger, () => NOW),
        notifications: createNotificationService({ clock: () => NOW }),
        storefrontUrl: 'https://shop.example',
      },
      {
        orderId: ORDER_ID,
        shipmentStatus: 'SHIPPED',
        actor: { type: 'STAFF', userId: randomUUID() },
        now: NOW,
      },
    );
    expect(result.steps).toEqual(['SHIPPED']);
    expect(m.invoiceRecord.create.mock.calls[0]?.[0].data.invoiceNumber).toBe('INV/2627/000001');
    expect(m.taxTransaction.createMany).toHaveBeenCalledTimes(1);
    // GST_AND_INVOICE_DATABASE_DESIGN §7: issuance is audited in the same transaction, attributed to
    // the actor who triggered SHIPPED.
    const audits = m.auditLog.create.mock.calls.map(
      (c) => (c[0] as { data: { action: string; module: string; actorType: string } }).data,
    );
    expect(audits).toContainEqual(
      expect.objectContaining({ action: 'CREATE', module: 'invoices', actorType: 'STAFF' }),
    );
  });
});

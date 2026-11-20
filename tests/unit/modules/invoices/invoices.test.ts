/**
 * Invoices & credit notes (B7) — TAX_AND_GST_WORKFLOWS.md §16–§19.
 * MOCKED DB (tests/helpers/mockDb.ts): verifies ledger maths, numbering calls, row shapes and the
 * PDF output; no SQL is executed.
 */
import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { TxClient } from '../../../../src/core/db/transaction.js';
import { createLogger } from '../../../../src/core/logger/logger.js';
import { Decimal } from '../../../../src/lib/money.js';
import { createAuditService } from '../../../../src/modules/audit/audit.service.js';
import {
  amountInWords,
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

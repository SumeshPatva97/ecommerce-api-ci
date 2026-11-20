/**
 * Tax invoices & credit notes (B7) — TAX_AND_GST_WORKFLOWS.md §16–§19,
 * GST_AND_INVOICE_DATABASE_DESIGN.md §5–§7, BACKEND_STRUCTURE.md §10.
 *
 * - `issueInvoiceForOrder(tx, orderId, now)`: one TAX_INVOICE per order (PROVISIONAL OQ-67),
 *   issued when the order reaches SHIPPED (PROVISIONAL OQ-48 — `tax.invoice_trigger = ON_SHIPPED`).
 *   Idempotent (returns the existing invoice). Number `INV/2627/000001` allocated with
 *   `allocateNumber(tx, 'INVOICE', now)` in the SAME transaction that inserts the row → gap-free.
 * - `issueCreditNote(tx, …)`: CREDIT_NOTE (`CN/2627/…`) against the order's invoice for a full
 *   cancellation or a refund (pro-rated per §18.4); no invoice → no credit note (§18.1).
 *   Idempotent per refund.
 * - Ledger: `tax_transactions` rows per (line × component), credit notes stored NEGATIVE (§19);
 *   `invoice_records` totals stay positive (presentation, §18.3).
 *
 * PDF storage is NOT available (no private file storage configured): `pdf_storage_key` stays NULL
 * and the PDF is rendered on demand from the immutable `invoice_records` / `tax_transactions` /
 * order snapshot rows (see invoices.pdf.ts). The caller must already hold the order row lock or
 * this module takes it (`SELECT … FOR UPDATE`).
 */
import { randomUUID } from 'node:crypto';

import { allocateNumber } from '../../core/db/sequences.js';
import type { Queryable, TxClient } from '../../core/db/transaction.js';
import { AppError } from '../../core/errors/AppError.js';
import type { InvoiceType } from '../../generated/prisma/enums.js';
import { dec, toMoneyString, type Decimal } from '../../lib/money.js';
import { financialYearCode, istParts } from '../../lib/time.js';
import type { AuditActor, AuditService } from '../audit/audit.service.js';
import { createNotificationService } from '../notifications/index.js';
import {
  documentTotals,
  groupKey,
  groupTax,
  groupsFromRows,
  invoiceGroups,
  isEmptyGroup,
  ledgerRows,
  prorateGroup,
  remainingGroups,
  type LedgerGroup,
} from './invoices.ledger.js';

export interface IssuedDocument {
  readonly id: string;
  readonly invoiceNumber: string;
  readonly invoiceType: InvoiceType;
  readonly created: boolean;
}

export interface IssueOptions {
  /** When set, `INVOICE_AVAILABLE` is enqueued for a newly issued invoice. */
  readonly storefrontUrl?: string | undefined;
  /**
   * When set, a newly issued invoice writes a `CREATE` audit row (`invoice.issued`) in the same
   * transaction (GST_AND_INVOICE_DATABASE_DESIGN §7). `actor` = who triggered the SHIPPED
   * transition (staff, courier webhook or system).
   */
  readonly audit?:
    { readonly service: Pick<AuditService, 'record'>; readonly actor: AuditActor } | undefined;
}

/** Statuses in which an order can never carry a (new) tax invoice. */
const NOT_INVOICEABLE = new Set(['PENDING_PAYMENT', 'PAYMENT_FAILED', 'CANCELLED']);

const LEDGER_ROW_SELECT = {
  orderItemId: true,
  lineType: true,
  component: true,
  hsnCode: true,
  rate: true,
  taxableValue: true,
  amount: true,
} as const;

/** IST calendar date as a UTC-midnight `Date` for `@db.Date` columns. */
export function istDocumentDate(now: Date): Date {
  const { year, month, day } = istParts(now);
  return new Date(Date.UTC(year, month - 1, day));
}

function sequenceOf(number: string): number {
  return Number(number.split('/').at(-1));
}

async function lockOrder(tx: TxClient, orderId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId} FOR UPDATE`;
}

async function writeLedger(
  tx: TxClient,
  doc: {
    id: string;
    type: InvoiceType;
    orderId: string;
    refundId: string | null;
    supplyType: 'INTRA_STATE' | 'INTER_STATE';
    posStateCode: string;
    date: Date;
    fy: string;
  },
  groups: readonly LedgerGroup[],
): Promise<void> {
  const rows = ledgerRows(groups, doc.type === 'CREDIT_NOTE' ? -1 : 1);
  await tx.taxTransaction.createMany({
    data: rows.map((r) => ({
      id: randomUUID(),
      invoiceRecordId: doc.id,
      documentType: doc.type,
      orderId: doc.orderId,
      orderItemId: r.orderItemId,
      refundId: doc.refundId,
      lineType: r.lineType,
      component: r.component,
      supplyType: doc.supplyType,
      placeOfSupplyStateCode: doc.posStateCode,
      hsnCode: r.hsnCode,
      taxableValue: r.taxableValue,
      rate: r.rate,
      amount: r.amount,
      taxDate: doc.date,
      financialYear: doc.fy,
    })),
  });
}

/**
 * Issues the order's TAX_INVOICE inside the caller's transaction (idempotent). Returns `null` only
 * for an order without lines (nothing to invoice).
 */
export async function issueInvoiceForOrder(
  tx: TxClient,
  orderId: string,
  now: Date,
  options: IssueOptions = {},
): Promise<IssuedDocument | null> {
  await lockOrder(tx, orderId);
  const existing = await tx.invoiceRecord.findFirst({
    where: { orderId, invoiceType: 'TAX_INVOICE' },
    select: { id: true, invoiceNumber: true, invoiceType: true },
  });
  if (existing !== null) return { ...existing, created: false };

  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      userId: true,
      paymentMethod: true,
      supplyType: true,
      pricesIncludeTax: true,
      shippingCharge: true,
      shippingDiscount: true,
      taxableTotal: true,
      cgstTotal: true,
      sgstTotal: true,
      utgstTotal: true,
      igstTotal: true,
      grandTotal: true,
      sellerGstinSnapshot: true,
      sellerStateCodeSnapshot: true,
      buyerGstin: true,
      placeOfSupplyStateCode: true,
      customerPhoneSnapshot: true,
      user: { select: { firstName: true, email: true, phone: true } },
      items: {
        orderBy: { lineNo: 'asc' },
        select: {
          id: true,
          hsnCode: true,
          quantity: true,
          taxRate: true,
          taxableValue: true,
          lineTotal: true,
          utgstRate: true,
          cgstAmount: true,
          sgstAmount: true,
          utgstAmount: true,
          igstAmount: true,
        },
      },
    },
  });
  if (order === null) throw new AppError('NOT_FOUND', 'Order not found.');
  if (NOT_INVOICEABLE.has(order.status)) {
    throw new AppError(
      'INVALID_STATE_TRANSITION',
      'An invoice cannot be issued for an order in this state.',
      {
        details: [
          {
            field: 'status',
            message: 'Order not invoiceable.',
            meta: { currentStatus: order.status },
          },
        ],
      },
    );
  }
  if (order.items.length === 0) return null;

  const groups = invoiceGroups(order);
  const totals = documentTotals(groups);
  const invoiceNumber = await allocateNumber(tx, 'INVOICE', now);
  const fy = financialYearCode(now);
  const date = istDocumentDate(now);
  const id = randomUUID();
  await tx.invoiceRecord.create({
    data: {
      id,
      invoiceType: 'TAX_INVOICE',
      invoiceNumber,
      financialYear: fy,
      sequenceNo: sequenceOf(invoiceNumber),
      orderId: order.id,
      invoiceDate: date,
      sellerGstin: order.sellerGstinSnapshot,
      sellerStateCode: order.sellerStateCodeSnapshot,
      buyerGstin: order.buyerGstin,
      placeOfSupplyStateCode: order.placeOfSupplyStateCode,
      supplyType: order.supplyType,
      taxableTotal: totals.taxableTotal,
      taxTotal: totals.taxTotal,
      grandTotal: order.grandTotal,
      // No private file storage configured: PDFs are rendered on demand from this row.
      pdfStorageKey: null,
      createdAt: now,
    },
  });
  await writeLedger(
    tx,
    {
      id,
      type: 'TAX_INVOICE',
      orderId: order.id,
      refundId: null,
      supplyType: order.supplyType,
      posStateCode: order.placeOfSupplyStateCode,
      date,
      fy,
    },
    groups,
  );

  if (options.audit !== undefined) {
    await options.audit.service.record(tx, options.audit.actor, {
      action: 'CREATE',
      module: 'invoices',
      entityType: 'InvoiceRecord',
      entityId: id,
      after: {
        invoiceType: 'TAX_INVOICE',
        invoiceNumber,
        financialYear: fy,
        orderId: order.id,
        taxableTotal: toMoneyString(totals.taxableTotal),
        taxTotal: toMoneyString(totals.taxTotal),
        grandTotal: toMoneyString(order.grandTotal),
      },
      diff: false,
      eventKey: 'invoice.issued',
      metadata: { entityLabel: invoiceNumber, orderNumber: order.orderNumber },
    });
  }

  if (options.storefrontUrl !== undefined) {
    await createNotificationService({ clock: () => now }).enqueue(tx, {
      event: 'INVOICE_AVAILABLE',
      channels: ['EMAIL'],
      recipientUserId: order.userId,
      to: { email: order.user.email, phone: order.user.phone ?? order.customerPhoneSnapshot },
      entityType: 'ORDER',
      entityId: order.id,
      discriminator: id,
      variables: {
        firstName: order.user.firstName,
        orderNumber: order.orderNumber,
        orderUrl: `${options.storefrontUrl}/orders/${order.orderNumber}`,
        amount: toMoneyString(order.grandTotal),
        paymentMethod: order.paymentMethod,
        invoiceNumber,
      },
    });
  }
  return { id, invoiceNumber, invoiceType: 'TAX_INVOICE', created: true };
}

export type CreditNoteScope =
  | { readonly kind: 'FULL' }
  | {
      readonly kind: 'PARTIAL';
      readonly items: readonly { readonly orderItemId: string; readonly quantity: number }[];
      /** Shipping amount refunded (tax-inclusive value). */
      readonly shippingAmount: Decimal;
    };

export interface IssueCreditNoteInput {
  readonly orderId: string;
  readonly refundId: string | null;
  readonly scope: CreditNoteScope;
  readonly now: Date;
}

function partialGroups(
  original: readonly LedgerGroup[],
  remaining: readonly LedgerGroup[],
  scope: Extract<CreditNoteScope, { kind: 'PARTIAL' }>,
  quantities: ReadonlyMap<string, number>,
  creditedUnits: ReadonlyMap<string, number>,
): LedgerGroup[] {
  const out: LedgerGroup[] = [];
  const remainingOf = (g: LedgerGroup): LedgerGroup | undefined =>
    remaining.find((r) => groupKey(r) === groupKey(g));
  for (const line of scope.items) {
    const orig = original.find((g) => g.lineType === 'ITEM' && g.orderItemId === line.orderItemId);
    const rem = orig === undefined ? undefined : remainingOf(orig);
    const n = quantities.get(line.orderItemId) ?? 0;
    if (orig === undefined || rem === undefined || n === 0) continue;
    const left = n - (creditedUnits.get(line.orderItemId) ?? 0);
    out.push(prorateGroup(orig, rem, dec(line.quantity).dividedBy(n), line.quantity >= left));
  }
  if (scope.shippingAmount.greaterThan(0)) {
    const shipping = original.filter((g) => g.lineType === 'SHIPPING');
    const gross = (gs: readonly LedgerGroup[]): Decimal =>
      gs.reduce((acc, g) => acc.plus(g.taxableValue).plus(groupTax(g)), dec(0));
    const shippingRemaining = shipping
      .map(remainingOf)
      .filter((g): g is LedgerGroup => g !== undefined);
    const origGross = gross(shipping);
    if (!origGross.isZero()) {
      const final = scope.shippingAmount.greaterThanOrEqualTo(gross(shippingRemaining));
      const fraction = scope.shippingAmount.dividedBy(origGross);
      for (const g of shipping) {
        const rem = remainingOf(g);
        if (rem !== undefined) out.push(prorateGroup(g, rem, fraction, final));
      }
    }
  }
  return out;
}

/**
 * Issues a CREDIT_NOTE against the order's TAX_INVOICE inside the caller's transaction.
 * Returns `null` when the order has no invoice (§18.1) or nothing remains to credit.
 */
export async function issueCreditNote(
  tx: TxClient,
  input: IssueCreditNoteInput,
): Promise<IssuedDocument | null> {
  const invoice = await tx.invoiceRecord.findFirst({
    where: { orderId: input.orderId, invoiceType: 'TAX_INVOICE' },
    select: {
      id: true,
      sellerGstin: true,
      sellerStateCode: true,
      buyerGstin: true,
      placeOfSupplyStateCode: true,
      supplyType: true,
      taxTransactions: { select: LEDGER_ROW_SELECT },
    },
  });
  if (invoice === null) return null;
  if (input.refundId !== null) {
    const existing = await tx.invoiceRecord.findFirst({
      where: { refundId: input.refundId, invoiceType: 'CREDIT_NOTE' },
      select: { id: true, invoiceNumber: true, invoiceType: true },
    });
    if (existing !== null) return { ...existing, created: false };
  }
  const prior = await tx.invoiceRecord.findMany({
    where: { originalInvoiceId: invoice.id, invoiceType: 'CREDIT_NOTE' },
    select: { refundId: true, taxTransactions: { select: LEDGER_ROW_SELECT } },
  });
  const original = groupsFromRows(invoice.taxTransactions);
  const credited = prior.flatMap((p) => groupsFromRows(p.taxTransactions));
  const remaining = remainingGroups(original, credited);

  let groups: LedgerGroup[];
  if (input.scope.kind === 'FULL') {
    groups = remaining;
  } else {
    const priorRefundIds = prior.map((p) => p.refundId).filter((r): r is string => r !== null);
    const [items, priorItems] = await Promise.all([
      tx.orderItem.findMany({
        where: { orderId: input.orderId },
        select: { id: true, quantity: true },
      }),
      priorRefundIds.length === 0
        ? Promise.resolve([])
        : tx.refundItem.findMany({
            where: { refundId: { in: priorRefundIds } },
            select: { orderItemId: true, quantity: true },
          }),
    ]);
    const creditedUnits = new Map<string, number>();
    for (const p of priorItems) {
      creditedUnits.set(p.orderItemId, (creditedUnits.get(p.orderItemId) ?? 0) + p.quantity);
    }
    groups = partialGroups(
      original,
      remaining,
      input.scope,
      new Map(items.map((i) => [i.id, i.quantity])),
      creditedUnits,
    );
  }
  groups = groups.filter((g) => !isEmptyGroup(g));
  if (groups.length === 0) return null;

  const totals = documentTotals(groups);
  const number = await allocateNumber(tx, 'CREDIT_NOTE', input.now);
  const fy = financialYearCode(input.now);
  const date = istDocumentDate(input.now);
  const id = randomUUID();
  await tx.invoiceRecord.create({
    data: {
      id,
      invoiceType: 'CREDIT_NOTE',
      invoiceNumber: number,
      financialYear: fy,
      sequenceNo: sequenceOf(number),
      orderId: input.orderId,
      refundId: input.refundId,
      originalInvoiceId: invoice.id,
      invoiceDate: date,
      sellerGstin: invoice.sellerGstin,
      sellerStateCode: invoice.sellerStateCode,
      buyerGstin: invoice.buyerGstin,
      placeOfSupplyStateCode: invoice.placeOfSupplyStateCode,
      supplyType: invoice.supplyType,
      taxableTotal: totals.taxableTotal,
      taxTotal: totals.taxTotal,
      grandTotal: totals.taxableTotal.plus(totals.taxTotal),
      pdfStorageKey: null,
      createdAt: input.now,
    },
  });
  await writeLedger(
    tx,
    {
      id,
      type: 'CREDIT_NOTE',
      orderId: input.orderId,
      refundId: input.refundId,
      supplyType: invoice.supplyType,
      posStateCode: invoice.placeOfSupplyStateCode,
      date,
      fy,
    },
    groups,
  );
  return { id, invoiceNumber: number, invoiceType: 'CREDIT_NOTE', created: true };
}

/** `{ invoiceNumber, type, issuedAt }` summaries for order detail DTOs. */
export async function listOrderDocuments(
  db: Queryable,
  orderId: string,
): Promise<{ id: string; invoiceNumber: string; type: InvoiceType; issuedAt: string }[]> {
  const rows = await db.invoiceRecord.findMany({
    where: { orderId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, invoiceNumber: true, invoiceType: true, createdAt: true },
  });
  return rows.map((r) => ({
    id: r.id,
    invoiceNumber: r.invoiceNumber,
    type: r.invoiceType,
    issuedAt: r.createdAt.toISOString(),
  }));
}

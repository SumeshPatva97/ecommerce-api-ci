/**
 * GST family — TAX_AND_GST_WORKFLOWS.md §19–§20, REPORTING_AND_ANALYTICS.md §5.14–§5.18:
 * `gst-summary`, `gst-hsn`, `gst-b2c`, `gst-b2b`, `gst-credit-notes`. Built ONLY from
 * `tax_transactions` + `invoice_records` (G6), filtered on the IST document date (`tax_date` /
 * `invoice_date`, DATE columns) or a `period=YYYY-MM`. Require `tax.view` (R-14).
 *
 * Rules: credit notes are negative (sign forced from `document_type`, whichever sign the ledger
 * stores); taxable totals use only rows with `component IN ('CGST','IGST')` because the taxable
 * value repeats on every component row (§19).
 *
 * Columns are illustrative pending CA review (API_DOCUMENTATION §4.17). Not captured by the
 * approved schema, so not reported: UQC (HSN summary) and reverse-charge flags (always "N").
 * PROVISIONAL (OQ-24): B2B only when setting `tax.b2b_enabled` is true (default false).
 * PROVISIONAL: B2CL threshold from setting `tax.b2cl_threshold` (default ₹1,00,000.00).
 */
import { Prisma } from '../../generated/prisma/client.js';
import type { Queryable } from '../../core/db/transaction.js';
import { MONEY_PATTERN } from '../../lib/money.js';
import { and, normalizeRow, pagedQuery, rangeOf, toDec, toInt, toStr } from './reports.sql.js';
import type {
  ReportColumn,
  ReportContext,
  ReportDefinition,
  ReportOutput,
  Row,
} from './reports.types.js';

const never = (): boolean => false;

export const GST_FOOTER =
  'Prepared for review by a qualified tax professional; verify before filing.';
export const GST_NOTICE = 'GST report columns are illustrative pending CA review.';
export const B2B_SETTING_KEY = 'tax.b2b_enabled';
export const B2CL_SETTING_KEY = 'tax.b2cl_threshold';
export const DEFAULT_B2CL_THRESHOLD = '100000.00';

/** Ledger value with the credit-note sign applied. */
function signed(expr: string): Prisma.Sql {
  return Prisma.raw(
    `(CASE WHEN t.document_type = 'CREDIT_NOTE' THEN -ABS(${expr}) ELSE ABS(${expr}) END)`,
  );
}

const COMPONENTS = Prisma.sql`
  SUM(CASE WHEN t.component IN ('CGST', 'IGST') THEN ${signed('t.taxable_value')} ELSE 0 END) AS taxableValue,
  SUM(CASE WHEN t.component = 'CGST' THEN ${signed('t.amount')} ELSE 0 END) AS cgst,
  SUM(CASE WHEN t.component = 'SGST' THEN ${signed('t.amount')} ELSE 0 END) AS sgst,
  SUM(CASE WHEN t.component = 'UTGST' THEN ${signed('t.amount')} ELSE 0 END) AS utgst,
  SUM(CASE WHEN t.component = 'IGST' THEN ${signed('t.amount')} ELSE 0 END) AS igst,
  SUM(${signed('t.amount')}) AS totalTax`;

/** Line tax rate: the order line's total rate, else the ledger rate. */
const RATE = Prisma.sql`COALESCE(oi.tax_rate, t.rate)`;
const COMPONENT_SUMS = ['taxableValue', 'cgst', 'sgst', 'utgst', 'igst', 'totalTax'];

function gstWhere(ctx: ReportContext): Prisma.Sql[] {
  const range = rangeOf(ctx.range);
  const p = ctx.params;
  const out: Prisma.Sql[] = [Prisma.sql`t.tax_date >= ${range.from} AND t.tax_date <= ${range.to}`];
  if (p.supplyType !== undefined) out.push(Prisma.sql`t.supply_type = ${p.supplyType}`);
  if (p.stateCode !== undefined)
    out.push(Prisma.sql`t.place_of_supply_state_code = ${p.stateCode}`);
  if (p.hsn !== undefined) out.push(Prisma.sql`t.hsn_code = ${p.hsn}`);
  if (p.rate !== undefined) out.push(Prisma.sql`${RATE} = ${p.rate}`);
  return out;
}

const LEDGER = Prisma.sql`tax_transactions t LEFT JOIN order_items oi ON oi.id = t.order_item_id`;

async function settingValue(db: Queryable, key: string): Promise<unknown> {
  const row = await db.setting.findUnique({ where: { settingKey: key }, select: { value: true } });
  return row?.value;
}

export async function b2bEnabled(db: Queryable): Promise<boolean> {
  return (await settingValue(db, B2B_SETTING_KEY)) === true;
}

export async function b2clThreshold(db: Queryable): Promise<string> {
  const value = await settingValue(db, B2CL_SETTING_KEY);
  if (typeof value === 'string' && MONEY_PATTERN.test(value)) return value;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value.toFixed(2);
  return DEFAULT_B2CL_THRESHOLD;
}

/** B2CL invoice predicate on an `invoice_records` alias (inter-state B2C above the threshold). */
function isB2cl(a: 'ir' | 'orig', threshold: string): Prisma.Sql {
  const c = (col: string): Prisma.Sql => Prisma.raw(`${a}.${col}`);
  return Prisma.sql`(${c('invoice_type')} = 'TAX_INVOICE' AND ${c('buyer_gstin')} IS NULL
    AND ${c('supply_type')} = 'INTER_STATE' AND ${c('grand_total')} > ${threshold})`;
}

const COMPONENT_COLUMNS: readonly ReportColumn[] = [
  { key: 'taxableValue', label: 'Taxable value', type: 'money' },
  { key: 'cgst', label: 'CGST', type: 'money' },
  { key: 'sgst', label: 'SGST', type: 'money' },
  { key: 'utgst', label: 'UTGST', type: 'money' },
  { key: 'igst', label: 'IGST', type: 'money' },
  { key: 'totalTax', label: 'Total tax', type: 'money' },
];

// gst-summary ----------------------------------------------------------------------------------

const SUMMARY_COLUMNS: readonly ReportColumn[] = [
  { key: 'section', label: 'Section', type: 'string' },
  { key: 'supplyType', label: 'Supply type', type: 'string' },
  { key: 'documents', label: 'Documents', type: 'int' },
  ...COMPONENT_COLUMNS,
];
const STATE_COLUMNS: readonly ReportColumn[] = [
  { key: 'posState', label: 'Place of supply', type: 'string' },
  { key: 'taxableValue', label: 'Taxable value', type: 'money' },
  { key: 'igst', label: 'IGST', type: 'money' },
];
const SERIES_COLUMNS: readonly ReportColumn[] = [
  { key: 'documentType', label: 'Document type', type: 'string' },
  { key: 'firstNumber', label: 'First number', type: 'string' },
  { key: 'lastNumber', label: 'Last number', type: 'string' },
  { key: 'count', label: 'Total issued', type: 'int' },
];

const SECTIONS = [
  { key: 'INVOICES', doc: 'TAX_INVOICE' },
  { key: 'CREDIT_NOTES', doc: 'CREDIT_NOTE' },
] as const;
const SUPPLY_TYPES = ['INTRA_STATE', 'INTER_STATE'] as const;
const AMOUNT_KEYS = ['taxableValue', 'cgst', 'sgst', 'utgst', 'igst', 'totalTax'] as const;

async function runGstSummary(ctx: ReportContext): Promise<ReportOutput> {
  const range = rangeOf(ctx.range);
  const where = and(gstWhere(ctx));
  const [ledger, stateWise, series, recon] = await Promise.all([
    ctx.db.$queryRaw<Row[]>(Prisma.sql`
      SELECT t.document_type AS documentType, t.supply_type AS supplyType,
             COUNT(DISTINCT t.invoice_record_id) AS documents, ${COMPONENTS}
      FROM ${LEDGER} WHERE ${where}
      GROUP BY t.document_type, t.supply_type`),
    ctx.db.$queryRaw<Row[]>(Prisma.sql`
      SELECT t.place_of_supply_state_code AS posState, ${COMPONENTS}
      FROM ${LEDGER} JOIN invoice_records ir ON ir.id = t.invoice_record_id
      WHERE ${where} AND t.supply_type = 'INTER_STATE' AND ir.buyer_gstin IS NULL
      GROUP BY t.place_of_supply_state_code
      ORDER BY t.place_of_supply_state_code`),
    ctx.db.$queryRaw<Row[]>(Prisma.sql`
      SELECT ir.invoice_type AS documentType, MIN(ir.invoice_number) AS firstNumber,
             MAX(ir.invoice_number) AS lastNumber, COUNT(*) AS count
      FROM invoice_records ir
      WHERE ir.invoice_date >= ${range.from} AND ir.invoice_date <= ${range.to}
      GROUP BY ir.invoice_type ORDER BY ir.invoice_type`),
    ctx.db.$queryRaw<Row[]>(Prisma.sql`
      SELECT
        SUM(CASE WHEN ir.invoice_type = 'CREDIT_NOTE' THEN -ABS(ir.taxable_total) ELSE ir.taxable_total END) AS taxableValue,
        SUM(CASE WHEN ir.invoice_type = 'CREDIT_NOTE' THEN -ABS(ir.tax_total) ELSE ir.tax_total END) AS totalTax
      FROM invoice_records ir
      WHERE ir.invoice_date >= ${range.from} AND ir.invoice_date <= ${range.to}`),
  ]);

  const find = (doc: string, supply: string): Row | undefined =>
    ledger.find((r) => toStr(r.documentType) === doc && toStr(r.supplyType) === supply);
  const rows: Row[] = [];
  const net: Record<string, Record<string, ReturnType<typeof toDec>>> = {};
  const netDocs: Record<string, number> = {};
  for (const section of SECTIONS) {
    for (const supply of SUPPLY_TYPES) {
      const r = find(section.doc, supply) ?? {};
      rows.push(
        normalizeRow(SUMMARY_COLUMNS, {
          ...r,
          section: section.key,
          supplyType: supply,
          documents: r.documents ?? 0,
          ...Object.fromEntries(AMOUNT_KEYS.map((k) => [k, r[k] ?? 0])),
        }),
      );
      const target = (net[supply] ??= Object.fromEntries(AMOUNT_KEYS.map((k) => [k, toDec(0)])));
      for (const k of AMOUNT_KEYS) target[k] = (target[k] ?? toDec(0)).plus(toDec(r[k]));
      netDocs[supply] = (netDocs[supply] ?? 0) + toInt(r.documents);
    }
  }
  const total: Record<string, ReturnType<typeof toDec>> = Object.fromEntries(
    AMOUNT_KEYS.map((k) => [k, toDec(0)]),
  );
  for (const supply of SUPPLY_TYPES) {
    const values = net[supply] ?? {};
    rows.push(
      normalizeRow(SUMMARY_COLUMNS, {
        ...values,
        section: 'NET',
        supplyType: supply,
        documents: netDocs[supply] ?? 0,
      }),
    );
    for (const k of AMOUNT_KEYS) total[k] = (total[k] ?? toDec(0)).plus(values[k] ?? toDec(0));
  }

  const notices = [GST_NOTICE];
  const reconRow = recon[0] ?? {};
  const mismatch =
    !toDec(reconRow.taxableValue).equals(total.taxableValue ?? toDec(0)) ||
    !toDec(reconRow.totalTax).equals(total.totalTax ?? toDec(0));
  if (mismatch) {
    notices.push(
      'RECONCILIATION_MISMATCH: tax_transactions totals differ from invoice_records totals for this period (A3).',
    );
  }
  const stateRows = stateWise.map((r) => normalizeRow(STATE_COLUMNS, r));
  const seriesRows = series.map((r) => normalizeRow(SERIES_COLUMNS, r));
  return {
    columns: SUMMARY_COLUMNS,
    rows,
    totals: normalizeRow(SUMMARY_COLUMNS, {
      ...total,
      section: 'NET',
      supplyType: 'ALL',
      documents: null,
    }),
    totalItems: rows.length,
    paginated: false,
    notices,
    extra: {
      reconciliation: {
        matches: !mismatch,
        invoiceRecords: normalizeRow(COMPONENT_COLUMNS, reconRow),
      },
      stateWise: stateRows,
      documentSeries: seriesRows,
    },
    extraSheets: [
      { name: 'State-wise (inter-state B2C)', columns: STATE_COLUMNS, rows: stateRows },
      { name: 'Document series', columns: SERIES_COLUMNS, rows: seriesRows },
    ],
  };
}

// gst-hsn --------------------------------------------------------------------------------------

const HSN_COLUMNS: readonly ReportColumn[] = [
  { key: 'hsn', label: 'HSN', type: 'string' },
  { key: 'description', label: 'Description', type: 'string' },
  { key: 'rate', label: 'Rate', type: 'percent' },
  { key: 'totalQuantity', label: 'Total quantity', type: 'int' },
  { key: 'totalValue', label: 'Total value', type: 'money' },
  ...COMPONENT_COLUMNS,
];

async function runGstHsn(ctx: ReportContext): Promise<ReportOutput> {
  // Quantity: invoice lines use the order-line quantity; credit notes the refunded quantity (−).
  const base = Prisma.sql`
    SELECT t.hsn_code AS hsn, MAX(h.description) AS description, ${RATE} AS rate,
           SUM(CASE WHEN t.component IN ('CGST', 'IGST') AND t.line_type = 'ITEM'
                    THEN (CASE WHEN t.document_type = 'CREDIT_NOTE' THEN -ABS(COALESCE(ri.quantity, 0))
                               ELSE COALESCE(oi.quantity, 0) END)
                    ELSE 0 END) AS totalQuantity,
           ${COMPONENTS}
    FROM ${LEDGER}
    LEFT JOIN refund_items ri ON ri.refund_id = t.refund_id AND ri.order_item_id = t.order_item_id
    LEFT JOIN hsn_codes h ON h.hsn_code = t.hsn_code
    WHERE ${and(gstWhere(ctx))}
    GROUP BY t.hsn_code, ${RATE}`;
  const { rows, totalItems, sums } = await pagedQuery(
    ctx.db,
    base,
    Prisma.sql`x.hsn ASC, x.rate ASC`,
    ['totalQuantity', ...COMPONENT_SUMS],
    ctx.paging,
  );
  const withTotal = (r: Row): Row => ({
    ...r,
    totalValue: toDec(r.taxableValue).plus(toDec(r.totalTax)),
  });
  return {
    columns: HSN_COLUMNS,
    rows: rows.map((r) => normalizeRow(HSN_COLUMNS, withTotal(r))),
    totals: normalizeRow(HSN_COLUMNS, { ...withTotal(sums), hsn: null }),
    totalItems,
    paginated: true,
    notices: [GST_NOTICE, 'UQC is not captured in the approved schema; add it before filing.'],
  };
}

// gst-b2c --------------------------------------------------------------------------------------

const B2C_COLUMNS: readonly ReportColumn[] = [
  { key: 'section', label: 'Section', type: 'string' },
  { key: 'invoiceNumber', label: 'Invoice number', type: 'string' },
  { key: 'invoiceDate', label: 'Invoice date', type: 'date' },
  { key: 'invoiceValue', label: 'Invoice value', type: 'money' },
  { key: 'posState', label: 'Place of supply', type: 'string' },
  { key: 'supplyType', label: 'Supply type', type: 'string' },
  { key: 'rate', label: 'Rate', type: 'percent' },
  ...COMPONENT_COLUMNS,
];

async function runGstB2c(ctx: ReportContext): Promise<ReportOutput> {
  const threshold = await b2clThreshold(ctx.db);
  const where = and(gstWhere(ctx));
  const b2cl = Prisma.sql`
    SELECT 'B2CL' AS section, ir.invoice_number AS invoiceNumber, ir.invoice_date AS invoiceDate,
           ir.grand_total AS invoiceValue, ir.place_of_supply_state_code AS posState,
           ir.supply_type AS supplyType, c.rate AS rate, c.taxableValue AS taxableValue,
           c.cgst AS cgst, c.sgst AS sgst, c.utgst AS utgst, c.igst AS igst, c.totalTax AS totalTax
    FROM (SELECT t.invoice_record_id, ${RATE} AS rate, ${COMPONENTS}
          FROM ${LEDGER} WHERE ${where} AND t.document_type = 'TAX_INVOICE'
          GROUP BY t.invoice_record_id, ${RATE}) c
    JOIN invoice_records ir ON ir.id = c.invoice_record_id
    WHERE ${isB2cl('ir', threshold)}`;
  // B2CS: all other B2C supplies, net of their credit notes (B2CL-linked credit notes → CDNUR).
  const b2cs = Prisma.sql`
    SELECT 'B2CS' AS section, NULL AS invoiceNumber, NULL AS invoiceDate, NULL AS invoiceValue,
           t.place_of_supply_state_code AS posState, t.supply_type AS supplyType, ${RATE} AS rate,
           ${COMPONENTS}
    FROM ${LEDGER}
    JOIN invoice_records ir ON ir.id = t.invoice_record_id
    LEFT JOIN invoice_records orig ON orig.id = ir.original_invoice_id
    WHERE ${where} AND ir.buyer_gstin IS NULL AND NOT ${isB2cl('ir', threshold)}
      AND NOT (ir.invoice_type = 'CREDIT_NOTE' AND orig.id IS NOT NULL AND ${isB2cl('orig', threshold)})
    GROUP BY t.place_of_supply_state_code, t.supply_type, ${RATE}`;
  const section = ctx.params.section;
  const base =
    section === 'b2cl' ? b2cl : section === 'b2cs' ? b2cs : Prisma.sql`${b2cl} UNION ALL ${b2cs}`;
  const { rows, totalItems, sums } = await pagedQuery(
    ctx.db,
    base,
    Prisma.sql`x.section ASC, x.invoiceDate ASC, x.invoiceNumber ASC, x.posState ASC, x.rate ASC`,
    ['invoiceValue', ...COMPONENT_SUMS],
    ctx.paging,
  );
  return {
    columns: B2C_COLUMNS,
    rows: rows.map((r) => normalizeRow(B2C_COLUMNS, r)),
    totals: normalizeRow(B2C_COLUMNS, { ...sums, section: null }),
    totalItems,
    paginated: true,
    notices: [GST_NOTICE],
    extra: { b2clThreshold: threshold, section: section ?? 'all' },
  };
}

// gst-b2b --------------------------------------------------------------------------------------

const B2B_COLUMNS: readonly ReportColumn[] = [
  { key: 'buyerGstin', label: 'Buyer GSTIN', type: 'string' },
  { key: 'buyerName', label: 'Buyer name', type: 'string' },
  { key: 'invoiceNumber', label: 'Invoice number', type: 'string' },
  { key: 'invoiceDate', label: 'Invoice date', type: 'date' },
  { key: 'invoiceValue', label: 'Invoice value', type: 'money' },
  { key: 'posState', label: 'Place of supply', type: 'string' },
  { key: 'reverseCharge', label: 'Reverse charge', type: 'string' },
  { key: 'rate', label: 'Rate', type: 'percent' },
  ...COMPONENT_COLUMNS,
];

async function runGstB2b(ctx: ReportContext): Promise<ReportOutput> {
  if (!(await b2bEnabled(ctx.db))) {
    return {
      columns: B2B_COLUMNS,
      rows: [],
      totals: null,
      totalItems: 0,
      paginated: true,
      notices: ['B2B disabled (OQ-24).'],
      extra: { b2bEnabled: false },
    };
  }
  const base = Prisma.sql`
    SELECT ir.buyer_gstin AS buyerGstin, o.buyer_legal_name AS buyerName,
           ir.invoice_number AS invoiceNumber, ir.invoice_date AS invoiceDate,
           ir.grand_total AS invoiceValue, ir.place_of_supply_state_code AS posState,
           'N' AS reverseCharge, c.rate AS rate, c.taxableValue AS taxableValue, c.cgst AS cgst,
           c.sgst AS sgst, c.utgst AS utgst, c.igst AS igst, c.totalTax AS totalTax
    FROM (SELECT t.invoice_record_id, ${RATE} AS rate, ${COMPONENTS}
          FROM ${LEDGER} WHERE ${and(gstWhere(ctx))} AND t.document_type = 'TAX_INVOICE'
          GROUP BY t.invoice_record_id, ${RATE}) c
    JOIN invoice_records ir ON ir.id = c.invoice_record_id
    JOIN orders o ON o.id = ir.order_id
    WHERE ir.buyer_gstin IS NOT NULL`;
  const { rows, totalItems, sums } = await pagedQuery(
    ctx.db,
    base,
    Prisma.sql`x.invoiceDate ASC, x.invoiceNumber ASC, x.rate ASC`,
    COMPONENT_SUMS,
    ctx.paging,
  );
  return {
    columns: B2B_COLUMNS,
    rows: rows.map((r) => normalizeRow(B2B_COLUMNS, r)),
    totals: normalizeRow(B2B_COLUMNS, sums),
    totalItems,
    paginated: true,
    notices: [GST_NOTICE],
    extra: { b2bEnabled: true },
  };
}

// gst-credit-notes -----------------------------------------------------------------------------

const CN_COLUMNS: readonly ReportColumn[] = [
  { key: 'creditNoteNumber', label: 'Credit note number', type: 'string' },
  { key: 'creditNoteDate', label: 'Credit note date', type: 'date' },
  { key: 'originalInvoiceNumber', label: 'Original invoice', type: 'string' },
  { key: 'originalInvoiceDate', label: 'Original invoice date', type: 'date' },
  { key: 'buyerGstin', label: 'Buyer GSTIN', type: 'string' },
  { key: 'category', label: 'Category', type: 'string' },
  { key: 'posState', label: 'Place of supply', type: 'string' },
  { key: 'supplyType', label: 'Supply type', type: 'string' },
  ...COMPONENT_COLUMNS,
  { key: 'reason', label: 'Reason', type: 'string' },
];

async function runGstCreditNotes(ctx: ReportContext): Promise<ReportOutput> {
  const threshold = await b2clThreshold(ctx.db);
  const base = Prisma.sql`
    SELECT ir.invoice_number AS creditNoteNumber, ir.invoice_date AS creditNoteDate,
           orig.invoice_number AS originalInvoiceNumber, orig.invoice_date AS originalInvoiceDate,
           ir.buyer_gstin AS buyerGstin,
           CASE WHEN ir.buyer_gstin IS NOT NULL THEN 'CDNR'
                WHEN orig.id IS NOT NULL AND ${isB2cl('orig', threshold)} THEN 'CDNUR'
                ELSE 'B2CS' END AS category,
           ir.place_of_supply_state_code AS posState, ir.supply_type AS supplyType,
           c.taxableValue AS taxableValue, c.cgst AS cgst, c.sgst AS sgst, c.utgst AS utgst,
           c.igst AS igst, c.totalTax AS totalTax, r.reason_code AS reason
    FROM (SELECT t.invoice_record_id, ${COMPONENTS}
          FROM ${LEDGER} WHERE ${and(gstWhere(ctx))} AND t.document_type = 'CREDIT_NOTE'
          GROUP BY t.invoice_record_id) c
    JOIN invoice_records ir ON ir.id = c.invoice_record_id
    LEFT JOIN invoice_records orig ON orig.id = ir.original_invoice_id
    LEFT JOIN refunds r ON r.id = ir.refund_id`;
  const { rows, totalItems, sums } = await pagedQuery(
    ctx.db,
    base,
    Prisma.sql`x.creditNoteDate ASC, x.creditNoteNumber ASC`,
    COMPONENT_SUMS,
    ctx.paging,
  );
  return {
    columns: CN_COLUMNS,
    rows: rows.map((r) => normalizeRow(CN_COLUMNS, r)),
    totals: normalizeRow(CN_COLUMNS, sums),
    totalItems,
    paginated: true,
    notices: [GST_NOTICE],
  };
}

function gst(
  key: ReportDefinition['key'],
  title: string,
  run: ReportDefinition['run'],
): ReportDefinition {
  return {
    key,
    title,
    version: '1.0',
    domainPermissions: ['tax.view'],
    dateMode: 'required',
    maxRangeDays: 366,
    timeSeries: false,
    customerData: false,
    containsPii: never,
    footer: GST_FOOTER,
    run,
  };
}

export const GST_REPORTS: readonly ReportDefinition[] = [
  gst('gst-summary', 'GST summary', runGstSummary),
  gst('gst-hsn', 'GST HSN summary', runGstHsn),
  gst('gst-b2c', 'GST B2C supplies', runGstB2c),
  gst('gst-b2b', 'GST B2B supplies', runGstB2b),
  gst('gst-credit-notes', 'GST credit notes', runGstCreditNotes),
];

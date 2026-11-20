/**
 * Sales family — REPORTING_AND_ANALYTICS.md §4.2–§4.4, §5.1–§5.3: `sales`, `orders`,
 * `order-status`. Figures come from order snapshots (G2); refunds reduce revenue on their own
 * completion date (G5).
 *
 * PROVISIONAL (OQ-54): sales recognised on `orders.confirmed_at` (IST); refunds on
 * `refunds.completed_at`; `basis=transaction` default, `basis=current` drops currently-CANCELLED
 * orders and their refunds.
 */
import { Prisma } from '../../generated/prisma/client.js';
import { OrderStatus, PaymentStatus } from '../../generated/prisma/enums.js';
import type { Queryable } from '../../core/db/transaction.js';
import { Decimal, ZERO } from '../../lib/money.js';
import {
  changePercent,
  comparisonRange,
  defaultGroupBy,
  rollUp,
  type Metrics,
} from './reports.buckets.js';
import { canSeeCustomers, maskEmail, maskName } from './reports.mask.js';
import { enumList, makeRange, type ReportParams } from './reports.params.js';
import {
  and,
  ident,
  istDay,
  normalizeRow,
  pagedQuery,
  rangeOf,
  ratio,
  salesOrderWhere,
  toDec,
  toInt,
  toIso,
  toStr,
} from './reports.sql.js';
import type {
  ReportColumn,
  ReportContext,
  ReportDefinition,
  ReportOutput,
  ReportRange,
  Row,
} from './reports.types.js';

const ORDER_STATUSES = Object.values(OrderStatus);
const PAYMENT_STATUSES = Object.values(PaymentStatus);
const never = (): boolean => false;

// sales ----------------------------------------------------------------------------------------

export const SALES_METRICS = [
  'orders',
  'units',
  'grossSales',
  'itemDiscounts',
  'couponDiscounts',
  'shipping',
  'taxableValue',
  'cgst',
  'sgst',
  'utgst',
  'igst',
  'tax',
  'roundOff',
  'orderValue',
  'refunds',
  'refundTaxable',
  'unpaidCancellations',
  'unpaidCancellationsTaxable',
] as const;
export type SalesMetric = (typeof SALES_METRICS)[number];

const SALES_COLUMNS: readonly ReportColumn[] = [
  { key: 'bucket', label: 'Period', type: 'string' },
  { key: 'isPartial', label: 'Partial period', type: 'boolean' },
  { key: 'orders', label: 'Orders', type: 'int' },
  { key: 'units', label: 'Units', type: 'int' },
  { key: 'grossSales', label: 'Gross sales', type: 'money' },
  { key: 'itemDiscounts', label: 'Item discounts', type: 'money' },
  { key: 'couponDiscounts', label: 'Coupon discounts', type: 'money' },
  { key: 'netSales', label: 'Net sales', type: 'money' },
  { key: 'shipping', label: 'Shipping (net)', type: 'money' },
  { key: 'taxableValue', label: 'Taxable value', type: 'money' },
  { key: 'cgst', label: 'CGST', type: 'money' },
  { key: 'sgst', label: 'SGST', type: 'money' },
  { key: 'utgst', label: 'UTGST', type: 'money' },
  { key: 'igst', label: 'IGST', type: 'money' },
  { key: 'tax', label: 'Tax', type: 'money' },
  { key: 'roundOff', label: 'Round-off', type: 'money' },
  { key: 'orderValue', label: 'Order value', type: 'money' },
  { key: 'refunds', label: 'Refunds', type: 'money' },
  { key: 'unpaidCancellations', label: 'Unpaid cancellations', type: 'money' },
  { key: 'netRevenue', label: 'Net revenue', type: 'money' },
  { key: 'netRevenueExTax', label: 'Net revenue (ex tax)', type: 'money' },
  { key: 'aov', label: 'AOV', type: 'money' },
];

/** Order-level filters shared by the sales queries (alias `o`). */
function orderFilters(params: ReportParams): Prisma.Sql[] {
  const out: Prisma.Sql[] = [];
  if (params.paymentMethod !== undefined)
    out.push(Prisma.sql`o.payment_method = ${params.paymentMethod}`);
  if (params.stateCode !== undefined) {
    out.push(Prisma.sql`o.place_of_supply_state_code = ${params.stateCode}`);
  }
  return out;
}

/** Per-IST-day sales metrics (orders by `confirmed_at`, refunds by `completed_at`). */
export async function salesPerDay(
  db: Queryable,
  range: { start: Date; end: Date },
  params: Pick<ReportParams, 'basis' | 'paymentMethod' | 'stateCode'>,
): Promise<Map<string, Partial<Metrics<SalesMetric>>>> {
  const filters = orderFilters(params as ReportParams);
  const day = istDay('o.confirmed_at');
  const refundDay = istDay('r.completed_at');
  const cancelDay = istDay('o.cancelled_at');
  const [orders, refunds, unpaid] = await Promise.all([
    db.$queryRaw<Row[]>(Prisma.sql`
      SELECT ${day} AS day, COUNT(*) AS orders, SUM(o.total_quantity) AS units,
             SUM(o.subtotal) AS grossSales, SUM(o.item_discount_total) AS itemDiscounts,
             SUM(o.coupon_discount_total) AS couponDiscounts,
             SUM(o.shipping_charge - o.shipping_discount) AS shipping,
             SUM(o.taxable_total) AS taxableValue, SUM(o.cgst_total) AS cgst,
             SUM(o.sgst_total) AS sgst, SUM(o.utgst_total) AS utgst, SUM(o.igst_total) AS igst,
             SUM(o.tax_total) AS tax, SUM(o.round_off) AS roundOff, SUM(o.grand_total) AS orderValue
      FROM orders o
      WHERE ${and([salesOrderWhere(range, params.basis), ...filters])}
      GROUP BY day`),
    db.$queryRaw<Row[]>(Prisma.sql`
      SELECT ${refundDay} AS day, SUM(r.amount) AS refunds, SUM(r.taxable_value) AS refundTaxable
      FROM refunds r JOIN orders o ON o.id = r.order_id
      WHERE ${and([
        Prisma.sql`r.status = 'COMPLETED' AND r.completed_at >= ${range.start} AND r.completed_at < ${range.end}`,
        Prisma.sql`o.status NOT IN ('PENDING_PAYMENT', 'PAYMENT_FAILED')`,
        ...(params.basis === 'current' ? [Prisma.sql`o.status <> 'CANCELLED'`] : []),
        ...filters,
      ])}
      GROUP BY day`),
    // Unpaid COD cancellations: only meaningful on the transaction basis (OQ-06, R7).
    params.basis === 'current' || params.paymentMethod === 'ONLINE'
      ? Promise.resolve([] as Row[])
      : db.$queryRaw<Row[]>(Prisma.sql`
      SELECT ${cancelDay} AS day, SUM(o.grand_total) AS unpaidCancellations,
             SUM(o.taxable_total) AS unpaidCancellationsTaxable
      FROM orders o
      WHERE ${and([
        Prisma.sql`o.payment_method = 'COD' AND o.status = 'CANCELLED' AND o.confirmed_at IS NOT NULL`,
        Prisma.sql`o.cancelled_at >= ${range.start} AND o.cancelled_at < ${range.end}`,
        Prisma.sql`NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.captured_at IS NOT NULL)`,
        ...filters,
      ])}
      GROUP BY day`),
  ]);
  const perDay = new Map<string, Partial<Metrics<SalesMetric>>>();
  const merge = (rows: readonly Row[], keys: readonly SalesMetric[]): void => {
    for (const row of rows) {
      const day = toStr(row.day);
      if (day === null) continue;
      const entry = perDay.get(day) ?? {};
      for (const k of keys) entry[k] = (entry[k] ?? ZERO).plus(toDec(row[k]));
      perDay.set(day, entry);
    }
  };
  merge(orders, SALES_METRICS.slice(0, 14));
  merge(refunds, ['refunds', 'refundTaxable']);
  merge(unpaid, ['unpaidCancellations', 'unpaidCancellationsTaxable']);
  return perDay;
}

/** Derived metrics (§4.2) from summed base metrics. */
export function deriveSales(m: Metrics<SalesMetric>): Record<string, Decimal | null> {
  const discounts = m.itemDiscounts.plus(m.couponDiscounts);
  const netSales = m.grossSales.minus(discounts);
  return {
    ...m,
    discounts,
    netSales,
    netRevenue: m.orderValue.minus(m.refunds).minus(m.unpaidCancellations),
    netRevenueExTax: m.taxableValue.minus(m.refundTaxable).minus(m.unpaidCancellationsTaxable),
    aov: ratio(m.orderValue, m.orders) ?? ZERO,
  };
}

async function runSales(ctx: ReportContext): Promise<ReportOutput> {
  const range = rangeOf(ctx.range);
  const groupBy = ctx.params.groupBy ?? defaultGroupBy(range.days);
  const perDay = await salesPerDay(ctx.db, range, ctx.params);
  const { series, totals } = rollUp(perDay, SALES_METRICS, range, groupBy);
  const rows = series.map(({ bucket, values }) =>
    normalizeRow(SALES_COLUMNS, {
      ...deriveSales(values),
      bucket: bucket.key,
      isPartial: bucket.isPartial,
    }),
  );
  const totalsRow = normalizeRow(SALES_COLUMNS, {
    ...deriveSales(totals),
    bucket: null,
    isPartial: null,
  });
  let comparison: Record<string, unknown> | undefined;
  if (ctx.params.compare !== undefined) {
    const cmp = comparisonRange(range, ctx.params.compare);
    const cmpRange: ReportRange = makeRange(cmp.from, cmp.to);
    const previous = rollUp(
      await salesPerDay(ctx.db, cmpRange, ctx.params),
      SALES_METRICS,
      cmpRange,
      'none',
    ).totals;
    const cur = deriveSales(totals);
    const prev = deriveSales(previous);
    const pct = (k: string): string | null => changePercent(cur[k] ?? ZERO, prev[k] ?? ZERO);
    comparison = {
      compare: ctx.params.compare,
      from: cmp.from,
      to: cmp.to,
      totals: normalizeRow(SALES_COLUMNS, { ...prev, bucket: null, isPartial: null }),
      changePercent: {
        orders: pct('orders'),
        orderValue: pct('orderValue'),
        netSales: pct('netSales'),
        netRevenue: pct('netRevenue'),
      },
    };
  }
  return {
    columns: SALES_COLUMNS,
    rows,
    totals: totalsRow,
    totalItems: rows.length,
    paginated: false,
    extra: {
      groupBy,
      basis: ctx.params.basis,
      ...(comparison === undefined ? {} : { comparison }),
    },
  };
}

// orders (register) ----------------------------------------------------------------------------

const ORDER_DATE_FIELDS = {
  placed: 'o.placed_at',
  confirmed: 'o.confirmed_at',
  delivered: 'o.delivered_at',
  cancelled: 'o.cancelled_at',
} as const;

const ORDERS_COLUMNS: readonly ReportColumn[] = [
  { key: 'orderNumber', label: 'Order number', type: 'string' },
  { key: 'placedAt', label: 'Placed at', type: 'datetime' },
  { key: 'confirmedAt', label: 'Confirmed at', type: 'datetime' },
  { key: 'status', label: 'Status', type: 'string' },
  { key: 'paymentMethod', label: 'Payment method', type: 'string' },
  { key: 'paymentStatus', label: 'Payment status', type: 'string' },
  { key: 'customerName', label: 'Customer', type: 'string' },
  { key: 'customerEmail', label: 'Customer email', type: 'string' },
  { key: 'itemCount', label: 'Items', type: 'int' },
  { key: 'units', label: 'Units', type: 'int' },
  { key: 'subtotal', label: 'Subtotal', type: 'money' },
  { key: 'discounts', label: 'Discounts', type: 'money' },
  { key: 'shipping', label: 'Shipping', type: 'money' },
  { key: 'tax', label: 'Tax', type: 'money' },
  { key: 'grandTotal', label: 'Grand total', type: 'money' },
  { key: 'refundedTotal', label: 'Refunded', type: 'money' },
  { key: 'invoiceNumber', label: 'Invoice number', type: 'string' },
  { key: 'couponCode', label: 'Coupon', type: 'string' },
  { key: 'shippingState', label: 'Shipping state', type: 'string' },
];
const ORDERS_SUMS = [
  'itemCount',
  'units',
  'subtotal',
  'discounts',
  'shipping',
  'tax',
  'grandTotal',
  'refundedTotal',
];

async function runOrders(ctx: ReportContext): Promise<ReportOutput> {
  const range = rangeOf(ctx.range);
  const p = ctx.params;
  const dateCol = ident(
    p.dateField !== undefined && p.dateField in ORDER_DATE_FIELDS
      ? ORDER_DATE_FIELDS[p.dateField as keyof typeof ORDER_DATE_FIELDS]
      : ORDER_DATE_FIELDS.placed,
  );
  const statuses = enumList(p.status, ORDER_STATUSES, 'status');
  const paymentStatuses = enumList(p.paymentStatus, PAYMENT_STATUSES, 'paymentStatus');
  const where: Prisma.Sql[] = [
    Prisma.sql`${dateCol} >= ${range.start} AND ${dateCol} < ${range.end}`,
  ];
  // PENDING_PAYMENT / PAYMENT_FAILED appear only when explicitly filtered (§5.2).
  where.push(
    statuses === undefined
      ? Prisma.sql`o.status NOT IN ('PENDING_PAYMENT', 'PAYMENT_FAILED')`
      : Prisma.sql`o.status IN (${Prisma.join(statuses)})`,
  );
  if (paymentStatuses !== undefined)
    where.push(Prisma.sql`o.payment_status IN (${Prisma.join(paymentStatuses)})`);
  where.push(...orderFilters(p));
  if (p.couponId !== undefined) where.push(Prisma.sql`o.coupon_id = ${p.couponId}`);
  if (p.q !== undefined) {
    where.push(
      Prisma.sql`(o.order_number = ${p.q.toUpperCase()} OR o.customer_email_snapshot = ${p.q.toLowerCase()})`,
    );
  }
  const base = Prisma.sql`
    SELECT o.id AS orderId, o.order_number AS orderNumber, o.placed_at AS placedAt,
           o.confirmed_at AS confirmedAt, o.status AS status, o.payment_method AS paymentMethod,
           o.payment_status AS paymentStatus, o.customer_name_snapshot AS customerName,
           o.customer_email_snapshot AS customerEmail, o.item_count AS itemCount,
           o.total_quantity AS units, o.subtotal AS subtotal,
           (o.item_discount_total + o.coupon_discount_total) AS discounts,
           (o.shipping_charge - o.shipping_discount) AS shipping, o.tax_total AS tax,
           o.grand_total AS grandTotal, o.refunded_total AS refundedTotal,
           (SELECT ir.invoice_number FROM invoice_records ir
             WHERE ir.order_id = o.id AND ir.invoice_type = 'TAX_INVOICE'
             ORDER BY ir.created_at ASC LIMIT 1) AS invoiceNumber,
           o.coupon_code_snapshot AS couponCode, o.place_of_supply_state_code AS shippingState
    FROM orders o WHERE ${and(where)}`;
  const { rows, totalItems, sums } = await pagedQuery(
    ctx.db,
    base,
    Prisma.sql`x.placedAt DESC, x.orderNumber DESC`,
    ORDERS_SUMS,
    ctx.paging,
  );
  const unmasked = canSeeCustomers(ctx.viewer);
  return {
    columns: ORDERS_COLUMNS,
    rows: rows.map((row) =>
      normalizeRow(ORDERS_COLUMNS, {
        ...row,
        customerName: unmasked ? row.customerName : maskName(toStr(row.customerName)),
        customerEmail: unmasked ? row.customerEmail : maskEmail(toStr(row.customerEmail)),
      }),
    ),
    totals: normalizeRow(ORDERS_COLUMNS, { ...sums, orderNumber: null }),
    totalItems,
    paginated: true,
  };
}

// order-status ---------------------------------------------------------------------------------

const OPEN_STATUSES = [
  'PENDING_PAYMENT',
  'CONFIRMED',
  'PROCESSING',
  'PACKED',
  'SHIPPED',
  'OUT_FOR_DELIVERY',
  'CANCELLATION_REQUESTED',
  'RETURN_REQUESTED',
];

const STATUS_COLUMNS: readonly ReportColumn[] = [
  { key: 'status', label: 'Status', type: 'string' },
  { key: 'count', label: 'Orders', type: 'int' },
  { key: 'percent', label: 'Share of total', type: 'percent' },
  { key: 'orderValue', label: 'Order value', type: 'money' },
  { key: 'avgHoursInStatus', label: 'Avg hours in status', type: 'decimal' },
  { key: 'oldestOpenAgeHours', label: 'Oldest open age (hours)', type: 'decimal' },
];

async function runOrderStatus(ctx: ReportContext): Promise<ReportOutput> {
  const range = rangeOf(ctx.range);
  const p = ctx.params;
  const statuses = enumList(p.status, ORDER_STATUSES, 'status');
  let raw: Row[];
  if (p.mode === 'transitions') {
    raw = await ctx.db.$queryRaw<Row[]>(Prisma.sql`
      SELECT h.to_status AS status, COUNT(*) AS count,
             AVG(TIMESTAMPDIFF(SECOND, h.created_at, h.next_at)) / 3600 AS avgHoursInStatus
      FROM (
        SELECT h1.to_status, h1.created_at,
               LEAD(h1.created_at) OVER (PARTITION BY h1.order_id ORDER BY h1.created_at, h1.id) AS next_at
        FROM order_status_history h1
        WHERE h1.event_type = 'STATUS_CHANGE' AND h1.to_status IS NOT NULL
          AND h1.order_id IN (SELECT h2.order_id FROM order_status_history h2
                              WHERE h2.created_at >= ${range.start} AND h2.created_at < ${range.end})
      ) h
      WHERE ${and([
        Prisma.sql`h.created_at >= ${range.start} AND h.created_at < ${range.end}`,
        ...(statuses === undefined ? [] : [Prisma.sql`h.to_status IN (${Prisma.join(statuses)})`]),
      ])}
      GROUP BY h.to_status`);
  } else {
    raw = await ctx.db.$queryRaw<Row[]>(Prisma.sql`
      SELECT o.status AS status, COUNT(*) AS count, SUM(o.grand_total) AS orderValue,
             MIN(CASE WHEN o.status IN (${Prisma.join(OPEN_STATUSES)}) THEN o.placed_at END) AS oldestOpenAt
      FROM orders o
      WHERE ${and([
        Prisma.sql`o.placed_at >= ${range.start} AND o.placed_at < ${range.end}`,
        ...(statuses === undefined ? [] : [Prisma.sql`o.status IN (${Prisma.join(statuses)})`]),
        ...orderFilters(p),
      ])}
      GROUP BY o.status`);
  }
  const total = raw.reduce((acc, r) => acc + toInt(r.count), 0);
  const order = (s: unknown): number => ORDER_STATUSES.indexOf(toStr(s) as OrderStatus);
  const rows = [...raw]
    .sort((a, b) => order(a.status) - order(b.status))
    .map((r) => {
      const oldest = toIso(r.oldestOpenAt);
      return normalizeRow(STATUS_COLUMNS, {
        status: r.status,
        count: r.count,
        percent: ratio(new Decimal(toInt(r.count)), new Decimal(total), 100),
        orderValue: p.mode === 'transitions' ? null : r.orderValue,
        avgHoursInStatus: r.avgHoursInStatus ?? null,
        oldestOpenAgeHours:
          oldest === null
            ? null
            : new Decimal(ctx.now.getTime() - Date.parse(oldest)).div(3_600_000),
      });
    });
  const orderValue = raw.reduce((acc, r) => acc.plus(toDec(r.orderValue)), ZERO);
  return {
    columns: STATUS_COLUMNS,
    rows,
    totals: normalizeRow(STATUS_COLUMNS, {
      count: total,
      percent: total === 0 ? null : 100,
      orderValue: p.mode === 'transitions' ? null : orderValue,
    }),
    totalItems: rows.length,
    paginated: false,
    extra: { mode: p.mode },
  };
}

export const SALES_REPORTS: readonly ReportDefinition[] = [
  {
    key: 'sales',
    title: 'Sales summary',
    version: '1.0',
    domainPermissions: [],
    dateMode: 'required',
    maxRangeDays: 1096,
    timeSeries: true,
    customerData: false,
    containsPii: never,
    run: runSales,
  },
  {
    key: 'orders',
    title: 'Order register',
    version: '1.0',
    domainPermissions: [],
    dateMode: 'required',
    maxRangeDays: 366,
    timeSeries: false,
    customerData: false,
    // Unmasked customer name/email only when the viewer holds customers.view (G9, §10).
    containsPii: canSeeCustomers,
    run: runOrders,
  },
  {
    key: 'order-status',
    title: 'Order status distribution',
    version: '1.0',
    domainPermissions: [],
    dateMode: 'required',
    maxRangeDays: 366,
    timeSeries: false,
    customerData: false,
    containsPii: never,
    run: runOrderStatus,
  },
];

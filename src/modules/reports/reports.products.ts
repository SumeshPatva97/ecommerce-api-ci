/**
 * Product family — REPORTING_AND_ANALYTICS.md §5.4–§5.7: `product-sales`, `category-sales`,
 * `brand-sales`, `best-sellers`. Line-level sums over `order_items` of sales orders S (§4.2),
 * identity by FK, display names from the latest snapshot (G2, R3). Category / brand attribution
 * uses `order_items.category_id_snapshot` / `brand_id_snapshot` (category at time of sale);
 * `depth` roll-up follows the current tree of that snapshot category.
 *
 * Refunded units/amounts are attributed to the sale's period (line cohort), via completed
 * refunds' `refund_items`.
 */
import { Prisma } from '../../generated/prisma/client.js';
import { Decimal, ZERO } from '../../lib/money.js';
import { comparisonRange } from './reports.buckets.js';
import { makeRange, type ReportParams } from './reports.params.js';
import {
  and,
  inCategoryTree,
  normalizeRow,
  pagedQuery,
  rangeOf,
  ratio,
  salesOrderWhere,
  toDec,
  toInt,
  toStr,
} from './reports.sql.js';
import type {
  ReportColumn,
  ReportContext,
  ReportDefinition,
  ReportOutput,
  Row,
} from './reports.types.js';

const never = (): boolean => false;

/** Latest snapshot value of `column` within the group (20-char timestamp prefix trick). */
function latest(column: string): Prisma.Sql {
  if (!/^[a-z_.]+$/.test(column)) throw new Error('bad column');
  return Prisma.raw(
    `SUBSTRING(MAX(CONCAT(DATE_FORMAT(o.confirmed_at, '%Y%m%d%H%i%s%f'), COALESCE(${column}, ''))), 21)`,
  );
}

const REFUNDED_LINES = Prisma.sql`LEFT JOIN (
    SELECT ri.order_item_id, SUM(ri.quantity) AS qty, SUM(ri.amount) AS amount
    FROM refund_items ri JOIN refunds r ON r.id = ri.refund_id AND r.status = 'COMPLETED'
    GROUP BY ri.order_item_id) rf ON rf.order_item_id = oi.id`;

/** Line filters on alias `oi` (category includes descendants). */
function itemFilters(p: ReportParams): Prisma.Sql[] {
  const out: Prisma.Sql[] = [];
  if (p.categoryId !== undefined) out.push(inCategoryTree('oi.category_id_snapshot', p.categoryId));
  if (p.brandId !== undefined) out.push(Prisma.sql`oi.brand_id_snapshot = ${p.brandId}`);
  if (p.collectionId !== undefined) {
    out.push(
      Prisma.sql`oi.product_id IN (SELECT cp.product_id FROM collection_products cp WHERE cp.collection_id = ${p.collectionId})`,
    );
  }
  if (p.productId !== undefined) out.push(Prisma.sql`oi.product_id = ${p.productId}`);
  if (p.variantId !== undefined) out.push(Prisma.sql`oi.variant_id = ${p.variantId}`);
  return out;
}

const LINE_METRICS = Prisma.sql`SUM(oi.quantity) AS units,
  SUM(oi.unit_price * oi.quantity) AS grossSales,
  SUM(oi.promotion_discount + oi.coupon_discount) AS discounts,
  SUM(oi.line_total) AS netSales, SUM(oi.taxable_value) AS taxableValue,
  SUM(oi.tax_amount) AS tax, COUNT(DISTINCT oi.order_id) AS orders`;

function linesFrom(ctx: ReportContext, extraJoin: Prisma.Sql = Prisma.empty): Prisma.Sql {
  const range = rangeOf(ctx.range);
  return Prisma.sql`FROM order_items oi JOIN orders o ON o.id = oi.order_id ${extraJoin}
    WHERE ${and([salesOrderWhere(range, ctx.params.basis), ...itemFilters(ctx.params)])}`;
}

// product-sales --------------------------------------------------------------------------------

const PRODUCT_COLUMNS: readonly ReportColumn[] = [
  { key: 'productId', label: 'Product ID', type: 'string' },
  { key: 'productName', label: 'Product', type: 'string' },
  { key: 'units', label: 'Units', type: 'int' },
  { key: 'grossSales', label: 'Gross sales', type: 'money' },
  { key: 'discounts', label: 'Discounts', type: 'money' },
  { key: 'netSales', label: 'Net sales', type: 'money' },
  { key: 'taxableValue', label: 'Taxable value', type: 'money' },
  { key: 'tax', label: 'Tax', type: 'money' },
  { key: 'refundedUnits', label: 'Refunded units', type: 'int' },
  { key: 'refundedAmount', label: 'Refunded amount', type: 'money' },
  { key: 'netUnits', label: 'Net units', type: 'int' },
  { key: 'orders', label: 'Orders', type: 'int' },
  { key: 'avgSellingPrice', label: 'Avg selling price', type: 'money' },
];
const VARIANT_COLUMNS: readonly ReportColumn[] = [
  { key: 'productId', label: 'Product ID', type: 'string' },
  { key: 'productName', label: 'Product', type: 'string' },
  { key: 'variantId', label: 'Variant ID', type: 'string' },
  { key: 'sku', label: 'SKU', type: 'string' },
  { key: 'variantName', label: 'Variant', type: 'string' },
  ...PRODUCT_COLUMNS.slice(2),
];
const PRODUCT_SUMS = [
  'units',
  'grossSales',
  'discounts',
  'netSales',
  'taxableValue',
  'tax',
  'refundedUnits',
  'refundedAmount',
];

function deriveLine(row: Row): Row {
  const units = toInt(row.units);
  const refundedUnits = toInt(row.refundedUnits);
  return {
    ...row,
    netUnits: units - refundedUnits,
    avgSellingPrice: ratio(toDec(row.netSales), new Decimal(units)),
  };
}

async function runProductSales(ctx: ReportContext): Promise<ReportOutput> {
  const variantLevel = ctx.params.level === 'variant';
  const columns = variantLevel ? VARIANT_COLUMNS : PRODUCT_COLUMNS;
  const base = Prisma.sql`
    SELECT oi.product_id AS productId, ${latest('oi.product_name')} AS productName,
      ${
        variantLevel
          ? Prisma.sql`oi.variant_id AS variantId, ${latest('oi.sku')} AS sku, ${latest('oi.variant_name')} AS variantName,`
          : Prisma.empty
      }
      ${LINE_METRICS},
      SUM(COALESCE(rf.qty, 0)) AS refundedUnits, SUM(COALESCE(rf.amount, 0)) AS refundedAmount
    ${linesFrom(ctx, REFUNDED_LINES)}
    GROUP BY oi.product_id${variantLevel ? Prisma.sql`, oi.variant_id` : Prisma.empty}`;
  const orderBy =
    ctx.params.sort === 'revenue_desc'
      ? Prisma.sql`x.netSales DESC, x.units DESC, x.productName ASC`
      : Prisma.sql`x.units DESC, x.netSales DESC, x.productName ASC`;
  const { rows, totalItems, sums } = await pagedQuery(
    ctx.db,
    base,
    orderBy,
    PRODUCT_SUMS,
    ctx.paging,
  );
  return {
    columns,
    rows: rows.map((r) => normalizeRow(columns, deriveLine(r))),
    totals: normalizeRow(columns, { ...deriveLine(sums), orders: null }),
    totalItems,
    paginated: true,
    extra: { level: ctx.params.level },
  };
}

// category-sales / brand-sales -----------------------------------------------------------------

const GROUP_SUMS = ['units', 'grossSales', 'discounts', 'netSales', 'taxableValue'];

function groupColumns(kind: 'category' | 'brand'): readonly ReportColumn[] {
  return [
    kind === 'category'
      ? { key: 'categoryId', label: 'Category ID', type: 'string' }
      : { key: 'brandId', label: 'Brand ID', type: 'string' },
    kind === 'category'
      ? { key: 'categoryPath', label: 'Category', type: 'string' }
      : { key: 'brandName', label: 'Brand', type: 'string' },
    { key: 'units', label: 'Units', type: 'int' },
    { key: 'grossSales', label: 'Gross sales', type: 'money' },
    { key: 'discounts', label: 'Discounts', type: 'money' },
    { key: 'netSales', label: 'Net sales', type: 'money' },
    { key: 'taxableValue', label: 'Taxable value', type: 'money' },
    { key: 'share', label: 'Share of net sales', type: 'percent' },
    { key: 'orders', label: 'Orders', type: 'int' },
  ];
}
const CATEGORY_COLUMNS = groupColumns('category');
const BRAND_COLUMNS = groupColumns('brand');

async function categoryLabels(
  ctx: ReportContext,
  paths: readonly string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(paths.flatMap((p) => p.split('/').filter((s) => s !== '')))];
  if (ids.length === 0) return new Map();
  const cats = await ctx.db.category.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
  });
  return new Map(cats.map((c) => [c.id, c.name]));
}

async function runCategorySales(ctx: ReportContext): Promise<ReportOutput> {
  const depth = ctx.params.depth;
  // Group key: the snapshot category, or its ancestor at `depth` (path `/root/child/self/`).
  // `depth` is a validated 1–3 integer: inlined so SELECT and GROUP BY use the same expression.
  const groupKey =
    depth === undefined
      ? Prisma.sql`oi.category_id_snapshot`
      : Prisma.sql`COALESCE(NULLIF(SUBSTRING_INDEX(SUBSTRING_INDEX(c.path, '/', ${Prisma.raw(String(Math.trunc(depth) + 1))}), '/', -1), ''), oi.category_id_snapshot)`;
  const base = Prisma.sql`
    SELECT g.categoryId AS categoryId, COALESCE(ca.name, g.snapshotName) AS categoryName,
           ca.path AS categoryTreePath, g.units AS units, g.grossSales AS grossSales,
           g.discounts AS discounts, g.netSales AS netSales, g.taxableValue AS taxableValue,
           g.orders AS orders
    FROM (
      SELECT ${groupKey} AS categoryId, ${latest('oi.category_name_snapshot')} AS snapshotName,
             ${LINE_METRICS}
      ${linesFrom(ctx, Prisma.sql`LEFT JOIN categories c ON c.id = oi.category_id_snapshot`)}
      GROUP BY ${groupKey}
    ) g LEFT JOIN categories ca ON ca.id = g.categoryId`;
  const { rows, totalItems, sums } = await pagedQuery(
    ctx.db,
    base,
    Prisma.sql`x.netSales DESC, x.categoryName ASC`,
    GROUP_SUMS,
    ctx.paging,
  );
  const labels = await categoryLabels(
    ctx,
    rows.map((r) => toStr(r.categoryTreePath) ?? ''),
  );
  const totalNet = toDec(sums.netSales);
  return {
    columns: CATEGORY_COLUMNS,
    rows: rows.map((r) => {
      const path = toStr(r.categoryTreePath);
      const label =
        path === null
          ? toStr(r.categoryName)
          : path
              .split('/')
              .filter((s) => s !== '')
              .map((id) => labels.get(id) ?? '?')
              .join(' > ');
      return normalizeRow(CATEGORY_COLUMNS, {
        ...r,
        categoryPath: label,
        share: ratio(toDec(r.netSales), totalNet, 100),
      });
    }),
    totals: normalizeRow(CATEGORY_COLUMNS, { ...sums, share: totalNet.isZero() ? null : 100 }),
    totalItems,
    paginated: true,
    notices: ['Attributed by category at time of sale (order line snapshot).'],
    extra: { depth: depth ?? null },
  };
}

async function runBrandSales(ctx: ReportContext): Promise<ReportOutput> {
  const base = Prisma.sql`
    SELECT oi.brand_id_snapshot AS brandId,
           COALESCE(NULLIF(${latest('oi.brand_name_snapshot')}, ''), 'No brand') AS brandName,
           ${LINE_METRICS}
    ${linesFrom(ctx)}
    GROUP BY oi.brand_id_snapshot`;
  const { rows, totalItems, sums } = await pagedQuery(
    ctx.db,
    base,
    Prisma.sql`x.netSales DESC, x.brandName ASC`,
    GROUP_SUMS,
    ctx.paging,
  );
  const totalNet = toDec(sums.netSales);
  return {
    columns: BRAND_COLUMNS,
    rows: rows.map((r) =>
      normalizeRow(BRAND_COLUMNS, {
        ...r,
        brandName: r.brandId === null ? 'No brand' : r.brandName,
        share: ratio(toDec(r.netSales), totalNet, 100),
      }),
    ),
    totals: normalizeRow(BRAND_COLUMNS, { ...sums, share: totalNet.isZero() ? null : 100 }),
    totalItems,
    paginated: true,
  };
}

// best-sellers ---------------------------------------------------------------------------------

export const BEST_SELLER_DEFAULT_LIMIT = 20;

const BEST_COLUMNS: readonly ReportColumn[] = [
  { key: 'rank', label: 'Rank', type: 'int' },
  { key: 'productId', label: 'Product ID', type: 'string' },
  { key: 'productName', label: 'Product', type: 'string' },
  { key: 'netUnits', label: 'Net units', type: 'int' },
  { key: 'netSales', label: 'Net sales', type: 'money' },
  { key: 'trendPercent', label: 'Trend vs previous period', type: 'percent' },
  { key: 'available', label: 'Available stock', type: 'int' },
  { key: 'productStatus', label: 'Product status', type: 'string' },
  { key: 'pinned', label: 'Pinned', type: 'boolean' },
];

function bestSellersBase(ctx: ReportContext, range: { start: Date; end: Date }): Prisma.Sql {
  return Prisma.sql`
    SELECT oi.product_id AS productId, ${latest('oi.product_name')} AS productName,
           SUM(oi.quantity) - SUM(COALESCE(rf.qty, 0)) AS netUnits,
           SUM(oi.line_total) - SUM(COALESCE(rf.amount, 0)) AS netSales
    FROM order_items oi JOIN orders o ON o.id = oi.order_id ${REFUNDED_LINES}
    WHERE ${and([salesOrderWhere(range, ctx.params.basis), ...itemFilters(ctx.params)])}
    GROUP BY oi.product_id`;
}

/**
 * PROVISIONAL (OQ-50): rank by net units (Σ qty − refunded qty) desc, ties by net sales desc then
 * name asc; `metric=revenue` ranks by net sales first.
 */
async function runBestSellers(ctx: ReportContext): Promise<ReportOutput> {
  const range = rangeOf(ctx.range);
  const top = ctx.params.limit ?? BEST_SELLER_DEFAULT_LIMIT;
  const orderBy =
    ctx.params.metric === 'revenue'
      ? Prisma.sql`x.netSales DESC, x.netUnits DESC, x.productName ASC`
      : Prisma.sql`x.netUnits DESC, x.netSales DESC, x.productName ASC`;
  const rows = await ctx.db.$queryRaw<Row[]>(
    Prisma.sql`SELECT x.* FROM (${bestSellersBase(ctx, range)}) x ORDER BY ${orderBy} LIMIT ${top}`,
  );
  const ids = rows.map((r) => toStr(r.productId)).filter((id): id is string => id !== null);
  const previous = new Map<string, Decimal>();
  const current = new Map<string, Row>();
  if (ids.length > 0) {
    const cmp = comparisonRange(range, 'previous_period');
    const cmpRange = makeRange(cmp.from, cmp.to);
    const [prevRows, stock] = await Promise.all([
      ctx.db.$queryRaw<Row[]>(
        Prisma.sql`SELECT x.productId AS productId, x.netUnits AS netUnits
          FROM (${bestSellersBase(ctx, cmpRange)}) x WHERE x.productId IN (${Prisma.join(ids)})`,
      ),
      ctx.db.$queryRaw<Row[]>(Prisma.sql`
        SELECT p.id AS productId, p.status AS productStatus, p.is_best_seller_pinned AS pinned,
               (SELECT SUM(COALESCE(i.quantity_on_hand, 0) - COALESCE(i.quantity_reserved, 0))
                  FROM product_variants v LEFT JOIN inventory i ON i.variant_id = v.id
                  WHERE v.product_id = p.id AND v.deleted_at IS NULL) AS available
        FROM products p WHERE p.id IN (${Prisma.join(ids)})`),
    ]);
    for (const r of prevRows) previous.set(toStr(r.productId) ?? '', toDec(r.netUnits));
    for (const r of stock) current.set(toStr(r.productId) ?? '', r);
  }
  const out = rows.map((r, i) => {
    const id = toStr(r.productId) ?? '';
    const prev = previous.get(id) ?? ZERO;
    const now = toDec(r.netUnits);
    const info = current.get(id);
    return normalizeRow(BEST_COLUMNS, {
      ...r,
      rank: i + 1,
      trendPercent: prev.isZero() ? null : now.minus(prev).div(prev.abs()).times(100),
      available: info?.available ?? 0,
      productStatus: info?.productStatus ?? null,
      pinned: info?.pinned ?? false,
    });
  });
  return {
    columns: BEST_COLUMNS,
    rows: out,
    totals: null,
    totalItems: out.length,
    paginated: false,
    extra: { metric: ctx.params.metric ?? 'units', limit: top },
  };
}

export const PRODUCT_REPORTS: readonly ReportDefinition[] = [
  {
    key: 'product-sales',
    title: 'Product & variant sales',
    version: '1.0',
    domainPermissions: [],
    dateMode: 'required',
    maxRangeDays: 366,
    timeSeries: false,
    customerData: false,
    containsPii: never,
    run: runProductSales,
  },
  {
    key: 'category-sales',
    title: 'Category sales',
    version: '1.0',
    domainPermissions: [],
    dateMode: 'required',
    maxRangeDays: 366,
    timeSeries: false,
    customerData: false,
    containsPii: never,
    run: runCategorySales,
  },
  {
    key: 'brand-sales',
    title: 'Brand sales',
    version: '1.0',
    domainPermissions: [],
    dateMode: 'required',
    maxRangeDays: 366,
    timeSeries: false,
    customerData: false,
    containsPii: never,
    run: runBrandSales,
  },
  {
    key: 'best-sellers',
    title: 'Best sellers',
    version: '1.0',
    domainPermissions: [],
    dateMode: 'optional',
    maxRangeDays: 366,
    timeSeries: false,
    customerData: false,
    containsPii: never,
    run: runBestSellers,
  },
];

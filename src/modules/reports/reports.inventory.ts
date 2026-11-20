/**
 * Inventory family (current state) — REPORTING_AND_ANALYTICS.md §4.6, §5.8, §5.9:
 * `inventory-valuation`, `low-stock`. Both need `inventory.view` (cost data is sensitive, R-14).
 *
 * PROVISIONAL (OQ-65): valuation at current `product_variants.cost_price` (GST-exclusive), not
 * FIFO / weighted average; uses `quantity_on_hand` (not available). Historical "as-of" valuation
 * needs nightly snapshots (OQ-81) — not available.
 * PROVISIONAL (OQ-47): low when `available ≤ COALESCE(inventory.low_stock_threshold, global
 * default)`; global default from settings via the inventory module.
 */
import { Prisma } from '../../generated/prisma/client.js';
import { VariantStatus } from '../../generated/prisma/enums.js';
import { Decimal } from '../../lib/money.js';
import { istDayRange } from '../../lib/time.js';
import { loadLowStockDefault } from '../inventory/inventory.stock.js';
import { enumList, istToday, shiftDate, type ReportParams } from './reports.params.js';
import {
  and,
  inCategoryTree,
  normalizeRow,
  pagedQuery,
  salesOrderWhere,
  toInt,
} from './reports.sql.js';
import type {
  ReportColumn,
  ReportContext,
  ReportDefinition,
  ReportOutput,
} from './reports.types.js';

const never = (): boolean => false;
const ON_HAND = Prisma.sql`COALESCE(i.quantity_on_hand, 0)`;
const AVAILABLE = Prisma.sql`(COALESCE(i.quantity_on_hand, 0) - COALESCE(i.quantity_reserved, 0))`;
const FROM_VARIANTS = Prisma.sql`FROM product_variants v
  JOIN products p ON p.id = v.product_id
  LEFT JOIN inventory i ON i.variant_id = v.id`;

function productFilters(p: ReportParams): Prisma.Sql[] {
  const out: Prisma.Sql[] = [];
  if (p.categoryId !== undefined) out.push(inCategoryTree('p.category_id', p.categoryId));
  if (p.brandId !== undefined) out.push(Prisma.sql`p.brand_id = ${p.brandId}`);
  return out;
}

// inventory-valuation --------------------------------------------------------------------------

const VALUATION_COLUMNS: readonly ReportColumn[] = [
  { key: 'sku', label: 'SKU', type: 'string' },
  { key: 'productName', label: 'Product', type: 'string' },
  { key: 'variantName', label: 'Variant', type: 'string' },
  { key: 'variantStatus', label: 'Variant status', type: 'string' },
  { key: 'onHand', label: 'On hand', type: 'int' },
  { key: 'reserved', label: 'Reserved', type: 'int' },
  { key: 'available', label: 'Available', type: 'int' },
  { key: 'costPrice', label: 'Cost price', type: 'money' },
  { key: 'costValue', label: 'Cost value', type: 'money' },
  { key: 'sellingPrice', label: 'Selling price', type: 'money' },
  { key: 'retailValue', label: 'Retail value', type: 'money' },
  { key: 'missingCost', label: 'Missing cost', type: 'boolean' },
  { key: 'deleted', label: 'Deleted', type: 'boolean' },
  { key: 'lastMovementAt', label: 'Last movement', type: 'datetime' },
];

async function runValuation(ctx: ReportContext): Promise<ReportOutput> {
  const p = ctx.params;
  const statuses = enumList(p.status, Object.values(VariantStatus), 'status');
  const where: Prisma.Sql[] = [
    // Soft-deleted variants still holding stock are included and flagged (§4.6).
    Prisma.sql`((v.deleted_at IS NULL AND p.deleted_at IS NULL) OR ${ON_HAND} > 0)`,
    ...productFilters(p),
  ];
  if (!p.includeZero) where.push(Prisma.sql`${ON_HAND} <> 0`);
  if (statuses !== undefined) where.push(Prisma.sql`v.status IN (${Prisma.join(statuses)})`);
  if (p.missingCostOnly) where.push(Prisma.sql`v.cost_price IS NULL`);
  const base = Prisma.sql`
    SELECT v.id AS variantId, v.sku AS sku, p.id AS productId, p.name AS productName,
           v.name AS variantName, v.status AS variantStatus, ${ON_HAND} AS onHand,
           COALESCE(i.quantity_reserved, 0) AS reserved, ${AVAILABLE} AS available,
           v.cost_price AS costPrice, ${ON_HAND} * v.cost_price AS costValue,
           v.selling_price AS sellingPrice, ${ON_HAND} * v.selling_price AS retailValue,
           CASE WHEN v.cost_price IS NULL THEN 1 ELSE 0 END AS missingCost,
           CASE WHEN v.deleted_at IS NOT NULL OR p.deleted_at IS NOT NULL THEN 1 ELSE 0 END AS deleted,
           i.last_movement_at AS lastMovementAt
    ${FROM_VARIANTS} WHERE ${and(where)}`;
  const { rows, totalItems, sums } = await pagedQuery(
    ctx.db,
    base,
    Prisma.sql`x.sku ASC`,
    ['onHand', 'reserved', 'available', 'costValue', 'retailValue', 'missingCost'],
    ctx.paging,
  );
  const variantsMissingCost = toInt(sums.missingCost);
  return {
    columns: VALUATION_COLUMNS,
    rows: rows.map((r) => normalizeRow(VALUATION_COLUMNS, r)),
    totals: normalizeRow(VALUATION_COLUMNS, { ...sums, missingCost: null }),
    totalItems,
    paginated: true,
    notices: [
      'Valued at current cost price (GST-exclusive); variants without a cost price are excluded from the cost total.',
    ],
    extra: { variantsMissingCost, costingMethod: 'CURRENT_COST' },
  };
}

// low-stock ------------------------------------------------------------------------------------

const LOW_STOCK_COLUMNS: readonly ReportColumn[] = [
  { key: 'sku', label: 'SKU', type: 'string' },
  { key: 'productName', label: 'Product', type: 'string' },
  { key: 'variantName', label: 'Variant', type: 'string' },
  { key: 'available', label: 'Available', type: 'int' },
  { key: 'effectiveThreshold', label: 'Threshold', type: 'int' },
  { key: 'onHand', label: 'On hand', type: 'int' },
  { key: 'reserved', label: 'Reserved', type: 'int' },
  { key: 'unitsSoldLast30d', label: 'Units sold (30 days)', type: 'int' },
  { key: 'daysOfCover', label: 'Days of cover', type: 'string' },
  { key: 'status', label: 'Status', type: 'string' },
];

/** `available / (sold30 / 30)`, 2 dp; "∞" when nothing sold (§5.9). */
export function daysOfCover(available: number, sold30: number): string {
  if (sold30 <= 0) return '∞';
  return new Decimal(Math.max(0, available))
    .div(new Decimal(sold30).div(30))
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .toFixed(2);
}

async function runLowStock(ctx: ReportContext): Promise<ReportOutput> {
  const p = ctx.params;
  const globalDefault = await loadLowStockDefault(ctx.db);
  const threshold = Prisma.sql`COALESCE(i.low_stock_threshold, ${globalDefault})`;
  const salesWindow = {
    start: istDayRange(shiftDate(istToday(ctx.now), -29)).start,
    end: ctx.now,
  };
  const where: Prisma.Sql[] = [
    Prisma.sql`v.deleted_at IS NULL AND p.deleted_at IS NULL`,
    Prisma.sql`${AVAILABLE} <= ${threshold}`,
    ...productFilters(p),
  ];
  if (!p.includeOutOfStock) where.push(Prisma.sql`${AVAILABLE} > 0`);
  const base = Prisma.sql`
    SELECT v.id AS variantId, v.sku AS sku, p.name AS productName, v.name AS variantName,
           ${AVAILABLE} AS available, ${threshold} AS effectiveThreshold, ${ON_HAND} AS onHand,
           COALESCE(i.quantity_reserved, 0) AS reserved, COALESCE(s.sold, 0) AS unitsSoldLast30d
    ${FROM_VARIANTS}
    LEFT JOIN (
      SELECT oi.variant_id, SUM(oi.quantity) AS sold
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE ${salesOrderWhere(salesWindow, 'transaction')}
      GROUP BY oi.variant_id) s ON s.variant_id = v.id
    WHERE ${and(where)}`;
  const { rows, totalItems, sums } = await pagedQuery(
    ctx.db,
    base,
    Prisma.sql`x.available ASC, x.sku ASC`,
    ['available', 'onHand', 'reserved', 'unitsSoldLast30d'],
    ctx.paging,
  );
  return {
    columns: LOW_STOCK_COLUMNS,
    rows: rows.map((r) => {
      const available = toInt(r.available);
      return normalizeRow(LOW_STOCK_COLUMNS, {
        ...r,
        daysOfCover: daysOfCover(available, toInt(r.unitsSoldLast30d)),
        status: available <= 0 ? 'OUT_OF_STOCK' : 'LOW_STOCK',
      });
    }),
    totals: normalizeRow(LOW_STOCK_COLUMNS, sums),
    totalItems,
    paginated: true,
    extra: { globalThreshold: globalDefault },
  };
}

export const INVENTORY_REPORTS: readonly ReportDefinition[] = [
  {
    key: 'inventory-valuation',
    title: 'Inventory valuation',
    version: '1.0',
    domainPermissions: ['inventory.view'],
    dateMode: 'none',
    maxRangeDays: 0,
    timeSeries: false,
    customerData: false,
    containsPii: never,
    run: runValuation,
  },
  {
    key: 'low-stock',
    title: 'Low stock',
    version: '1.0',
    domainPermissions: ['inventory.view'],
    dateMode: 'none',
    maxRangeDays: 0,
    timeSeries: false,
    customerData: false,
    containsPii: never,
    run: runLowStock,
  },
];

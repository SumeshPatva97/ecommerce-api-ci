/**
 * Marketing family — REPORTING_AND_ANALYTICS.md §5.12, §5.13: `coupons`, `promotions`.
 *
 * Coupons: one redemption per order (usage rows of orders confirmed in range); restored
 * redemptions (OQ-15, usage RELEASED after confirmation) are counted in `released` and subtracted
 * in `netRedemptions`. Promotions: attribution by `order_items.promotion_id` snapshot; unit lift is
 * indicative (no control group).
 */
import { Prisma } from '../../generated/prisma/client.js';
import { CouponStatus } from '../../generated/prisma/enums.js';
import { Decimal } from '../../lib/money.js';
import { enumList } from './reports.params.js';
import {
  and,
  normalizeRow,
  pagedQuery,
  rangeOf,
  ratio,
  salesOrderWhere,
  toBool,
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

// coupons --------------------------------------------------------------------------------------

const COUPON_COLUMNS: readonly ReportColumn[] = [
  { key: 'code', label: 'Code', type: 'string' },
  { key: 'discountType', label: 'Discount type', type: 'string' },
  { key: 'value', label: 'Value', type: 'decimal' },
  { key: 'couponStatus', label: 'Status', type: 'string' },
  { key: 'redemptions', label: 'Redemptions', type: 'int' },
  { key: 'reservedNow', label: 'Reserved now', type: 'int' },
  { key: 'released', label: 'Released', type: 'int' },
  { key: 'netRedemptions', label: 'Net redemptions', type: 'int' },
  { key: 'uniqueCustomers', label: 'Unique customers', type: 'int' },
  { key: 'discountGiven', label: 'Discount given', type: 'money' },
  { key: 'ordersValue', label: 'Orders value', type: 'money' },
  { key: 'avgDiscountPerOrder', label: 'Avg discount per order', type: 'money' },
  { key: 'usageLimit', label: 'Usage limit', type: 'string' },
  { key: 'remaining', label: 'Remaining', type: 'string' },
  { key: 'revenuePerRupeeDiscount', label: 'Revenue per rupee of discount', type: 'decimal' },
];

function deriveCoupon(row: Row): Row {
  const net = toInt(row.netRedemptions);
  const limited =
    toBool(row.usageLimitEnabled) && row.usageLimit !== null && row.usageLimit !== undefined;
  return {
    ...row,
    avgDiscountPerOrder: ratio(toDec(row.discountGiven), new Decimal(net)),
    usageLimit: limited ? String(toInt(row.usageLimit)) : 'Unlimited',
    remaining: limited
      ? String(Math.max(0, toInt(row.usageLimit) - toInt(row.usedCount)))
      : 'Unlimited',
    revenuePerRupeeDiscount: ratio(toDec(row.ordersValue), toDec(row.discountGiven)),
  };
}

async function runCoupons(ctx: ReportContext): Promise<ReportOutput> {
  const range = rangeOf(ctx.range);
  const p = ctx.params;
  const statuses = enumList(p.status, Object.values(CouponStatus), 'status');
  const where: Prisma.Sql[] = [];
  if (p.couponId !== undefined) where.push(Prisma.sql`c.id = ${p.couponId}`);
  if (statuses !== undefined) where.push(Prisma.sql`c.status IN (${Prisma.join(statuses)})`);
  const base = Prisma.sql`
    SELECT c.id AS couponId, c.code AS code, c.discount_type AS discountType,
           c.discount_value AS value, c.status AS couponStatus,
           c.usage_limit_enabled AS usageLimitEnabled, c.usage_limit AS usageLimit,
           c.used_count AS usedCount, u.redemptions AS redemptions, u.released AS released,
           u.redemptions - u.released AS netRedemptions, u.uniqueCustomers AS uniqueCustomers,
           u.discountGiven AS discountGiven, u.ordersValue AS ordersValue,
           (SELECT COUNT(*) FROM coupon_usage cr
             WHERE cr.coupon_id = c.id AND cr.status = 'RESERVED') AS reservedNow
    FROM coupons c
    JOIN (
      SELECT cu.coupon_id, COUNT(*) AS redemptions,
             SUM(CASE WHEN cu.status = 'RELEASED' THEN 1 ELSE 0 END) AS released,
             COUNT(DISTINCT CASE WHEN cu.status = 'REDEEMED' THEN cu.user_id END) AS uniqueCustomers,
             SUM(CASE WHEN cu.status = 'REDEEMED' THEN o.coupon_discount_total ELSE 0 END) AS discountGiven,
             SUM(CASE WHEN cu.status = 'REDEEMED' THEN o.grand_total ELSE 0 END) AS ordersValue
      FROM coupon_usage cu JOIN orders o ON o.id = cu.order_id
      WHERE cu.status IN ('REDEEMED', 'RELEASED') AND ${salesOrderWhere(range, 'transaction')}
      GROUP BY cu.coupon_id
    ) u ON u.coupon_id = c.id
    WHERE ${and(where)}`;
  const { rows, totalItems, sums } = await pagedQuery(
    ctx.db,
    base,
    Prisma.sql`x.discountGiven DESC, x.code ASC`,
    ['redemptions', 'released', 'netRedemptions', 'discountGiven', 'ordersValue'],
    ctx.paging,
  );
  return {
    columns: COUPON_COLUMNS,
    rows: rows.map((r) => normalizeRow(COUPON_COLUMNS, deriveCoupon(r))),
    totals: normalizeRow(COUPON_COLUMNS, {
      ...sums,
      avgDiscountPerOrder: ratio(toDec(sums.discountGiven), toDec(sums.netRedemptions)),
      revenuePerRupeeDiscount: ratio(toDec(sums.ordersValue), toDec(sums.discountGiven)),
    }),
    totalItems,
    paginated: true,
  };
}

// promotions -----------------------------------------------------------------------------------

const PROMOTION_COLUMNS: readonly ReportColumn[] = [
  { key: 'promotionId', label: 'Promotion ID', type: 'string' },
  { key: 'name', label: 'Promotion', type: 'string' },
  { key: 'scope', label: 'Scope', type: 'string' },
  { key: 'promotionStatus', label: 'Status', type: 'string' },
  { key: 'startsAt', label: 'Starts at', type: 'datetime' },
  { key: 'endsAt', label: 'Ends at', type: 'datetime' },
  { key: 'ordersWithPromotion', label: 'Orders', type: 'int' },
  { key: 'unitsPromoted', label: 'Units', type: 'int' },
  { key: 'discountGiven', label: 'Discount given', type: 'money' },
  { key: 'promotedNetSales', label: 'Net sales', type: 'money' },
  { key: 'baselineUnits', label: 'Baseline units', type: 'int' },
  { key: 'unitLift', label: 'Unit lift (indicative)', type: 'string' },
];

/** `(promoted − baseline) / baseline × 100` (2 dp) or "n/a" when the baseline is 0 (§5.13). */
export function unitLift(promoted: number, baseline: number): string {
  if (baseline <= 0) return 'n/a';
  return new Decimal(promoted - baseline)
    .div(baseline)
    .times(100)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .toFixed(2);
}

async function runPromotions(ctx: ReportContext): Promise<ReportOutput> {
  const range = rangeOf(ctx.range);
  const p = ctx.params;
  const where: Prisma.Sql[] = [];
  if (p.promotionId !== undefined) where.push(Prisma.sql`p.id = ${p.promotionId}`);
  if (p.scope !== undefined) where.push(Prisma.sql`p.scope = ${p.scope}`);
  const promoted = Prisma.sql`order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE ${salesOrderWhere(range, p.basis)} AND oi.promotion_id IS NOT NULL`;
  const base = Prisma.sql`
    SELECT p.id AS promotionId, p.name AS name, p.scope AS scope, p.status AS promotionStatus,
           p.starts_at AS startsAt, p.ends_at AS endsAt,
           s.ordersWithPromotion AS ordersWithPromotion, s.unitsPromoted AS unitsPromoted,
           s.discountGiven AS discountGiven, s.promotedNetSales AS promotedNetSales
    FROM promotions p
    JOIN (
      SELECT oi.promotion_id, COUNT(DISTINCT oi.order_id) AS ordersWithPromotion,
             SUM(oi.quantity) AS unitsPromoted, SUM(oi.promotion_discount) AS discountGiven,
             SUM(oi.line_total) AS promotedNetSales
      FROM ${promoted}
      GROUP BY oi.promotion_id
    ) s ON s.promotion_id = p.id
    WHERE ${and(where)}`;
  const { rows, totalItems, sums } = await pagedQuery(
    ctx.db,
    base,
    Prisma.sql`x.discountGiven DESC, x.name ASC`,
    ['ordersWithPromotion', 'unitsPromoted', 'discountGiven', 'promotedNetSales'],
    ctx.paging,
  );
  const ids = rows.map((r) => toStr(r.promotionId)).filter((id): id is string => id !== null);
  const baseline = new Map<string, number>();
  if (ids.length > 0) {
    // Same variants, equal-length period immediately before the promotion window.
    const baseRows = await ctx.db.$queryRaw<Row[]>(Prisma.sql`
      SELECT pv.promotion_id AS promotionId, SUM(oi2.quantity) AS baselineUnits
      FROM (SELECT DISTINCT oi.promotion_id, oi.variant_id FROM ${promoted}
            AND oi.promotion_id IN (${Prisma.join(ids)})) pv
      JOIN promotions pr ON pr.id = pv.promotion_id AND pr.starts_at IS NOT NULL
      JOIN order_items oi2 ON oi2.variant_id = pv.variant_id
      JOIN orders o2 ON o2.id = oi2.order_id
       AND o2.status NOT IN ('PENDING_PAYMENT', 'PAYMENT_FAILED')
       AND o2.confirmed_at < pr.starts_at
       AND o2.confirmed_at >= DATE_SUB(pr.starts_at, INTERVAL
             TIMESTAMPDIFF(SECOND, pr.starts_at, COALESCE(pr.ends_at, ${range.end})) SECOND)
      GROUP BY pv.promotion_id`);
    for (const r of baseRows) baseline.set(toStr(r.promotionId) ?? '', toInt(r.baselineUnits));
  }
  return {
    columns: PROMOTION_COLUMNS,
    rows: rows.map((r) => {
      const id = toStr(r.promotionId) ?? '';
      const base0 = baseline.get(id) ?? 0;
      return normalizeRow(PROMOTION_COLUMNS, {
        ...r,
        baselineUnits: base0,
        unitLift: unitLift(toInt(r.unitsPromoted), base0),
      });
    }),
    totals: normalizeRow(PROMOTION_COLUMNS, sums),
    totalItems,
    paginated: true,
    notices: ['Unit lift is indicative (no control group).'],
  };
}

export const MARKETING_REPORTS: readonly ReportDefinition[] = [
  {
    key: 'coupons',
    title: 'Coupon performance',
    version: '1.0',
    domainPermissions: [],
    dateMode: 'required',
    maxRangeDays: 366,
    timeSeries: false,
    customerData: false,
    containsPii: never,
    run: runCoupons,
  },
  {
    key: 'promotions',
    title: 'Promotion performance',
    version: '1.0',
    domainPermissions: [],
    dateMode: 'required',
    maxRangeDays: 366,
    timeSeries: false,
    customerData: false,
    containsPii: never,
    run: runPromotions,
  },
];

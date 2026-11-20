/**
 * Dashboard summary — REPORTING_AND_ANALYTICS.md §6, API_DOCUMENTATION.md §4.2.
 *
 * Route permission `dashboard.view`; each widget is returned only when the caller also holds the
 * underlying module permission — unauthorised widgets are OMITTED, never zeroed (§6 PROPOSED).
 * Cached 60 s per (range, effective widget permission set) in the shared key-value store.
 * PROVISIONAL (OQ-54): sales figures recognised on `confirmed_at` (IST), excluding
 * PENDING_PAYMENT / PAYMENT_FAILED.
 */
import { createHash } from 'node:crypto';

import { Prisma } from '../../generated/prisma/client.js';
import type { AppContainer } from '../../container.js';
import type { Queryable } from '../../core/db/transaction.js';
import { Decimal, ZERO, dec, toMoneyString } from '../../lib/money.js';
import { loadLowStockDefault } from '../inventory/inventory.stock.js';
import { hasPermission, type AuthContext } from '../rbac/permission.service.js';
import { changePercent, rollUp } from '../reports/reports.buckets.js';
import { istToday, makeRange, shiftDate, resolveReportRange } from '../reports/reports.params.js';
import { SALES_METRICS, deriveSales, salesPerDay } from '../reports/reports.sales.js';
import { toDec, toInt, toStr } from '../reports/reports.sql.js';
import type { ReportRange } from '../reports/reports.types.js';
import type { DashboardQuery } from './dashboard.schemas.js';

export const DASHBOARD_CACHE_TTL_SECONDS = 60;
export const DASHBOARD_MAX_RANGE_DAYS = 366;

const NON_SALE = ['PENDING_PAYMENT', 'PAYMENT_FAILED'] as const;

interface WidgetContext {
  readonly db: Queryable;
  readonly now: Date;
  readonly range: ReportRange;
}

interface Widget {
  /** Response key. */
  readonly key: string;
  /** Module permission required on top of `dashboard.view`. */
  readonly permission: string;
  load(ctx: WidgetContext): Promise<unknown>;
}

function salesWhere(range: { start: Date; end: Date }): Prisma.OrderWhereInput {
  return { confirmedAt: { gte: range.start, lt: range.end }, status: { notIn: [...NON_SALE] } };
}

async function salesTotals(db: Queryable, range: { start: Date; end: Date }) {
  const agg = await db.order.aggregate({
    where: salesWhere(range),
    _count: { _all: true },
    _sum: { subtotal: true, itemDiscountTotal: true, couponDiscountTotal: true, grandTotal: true },
  });
  const orders = agg._count._all;
  const gross = dec(agg._sum.subtotal ?? 0);
  const net = gross
    .minus(dec(agg._sum.itemDiscountTotal ?? 0))
    .minus(dec(agg._sum.couponDiscountTotal ?? 0));
  const orderValue = dec(agg._sum.grandTotal ?? 0);
  const aov =
    orders === 0 ? ZERO : orderValue.div(orders).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  return { orders, gross, net, orderValue, aov };
}

/** Comparison window: a single day compares with the same weekday last week, else the previous period. */
function previousRange(range: ReportRange, singleDayOffset: number): ReportRange {
  if (range.days === 1) {
    const day = shiftDate(range.from, -singleDayOffset);
    return makeRange(day, day);
  }
  return makeRange(shiftDate(range.from, -range.days), shiftDate(range.from, -1));
}

export const WIDGETS: readonly Widget[] = [
  {
    key: 'sales',
    permission: 'reports.view',
    async load({ db, range }) {
      const prevRange = previousRange(range, 7);
      const [cur, prev] = await Promise.all([salesTotals(db, range), salesTotals(db, prevRange)]);
      return {
        grossSales: toMoneyString(cur.gross),
        netSales: toMoneyString(cur.net),
        orders: cur.orders,
        averageOrderValue: toMoneyString(cur.aov),
        previous: { from: prevRange.from, to: prevRange.to, netSales: toMoneyString(prev.net) },
        changePercent: changePercent(cur.net, prev.net),
      };
    },
  },
  {
    key: 'orders',
    permission: 'orders.view',
    async load({ db, range }) {
      const prevRange = previousRange(range, 1);
      const [count, previous] = await Promise.all([
        db.order.count({ where: salesWhere(range) }),
        db.order.count({ where: salesWhere(prevRange) }),
      ]);
      return {
        count,
        previous: { from: prevRange.from, to: prevRange.to, count: previous },
        changePercent: changePercent(new Decimal(count), new Decimal(previous)),
      };
    },
  },
  {
    key: 'averageOrderValue30d',
    permission: 'reports.view',
    async load({ db, now }) {
      const today = istToday(now);
      const totals = await salesTotals(db, makeRange(shiftDate(today, -29), today));
      return { value: toMoneyString(totals.aov), orders: totals.orders };
    },
  },
  {
    key: 'ordersByStatus',
    permission: 'orders.view',
    async load({ db, range }) {
      const groups = await db.order.groupBy({
        by: ['status'],
        where: { placedAt: { gte: range.start, lt: range.end } },
        _count: { _all: true },
      });
      return Object.fromEntries(groups.map((g) => [g.status, g._count._all]));
    },
  },
  {
    key: 'ordersAwaitingAction',
    permission: 'orders.view',
    load: ({ db }) =>
      db.order.count({ where: { status: { in: ['CONFIRMED', 'PROCESSING', 'PACKED'] } } }),
  },
  {
    key: 'cancellationRequestsPending',
    permission: 'orders.view',
    load: ({ db }) => db.order.count({ where: { status: 'CANCELLATION_REQUESTED' } }),
  },
  {
    key: 'pendingRefunds',
    permission: 'refunds.view',
    load: ({ db }) => db.refund.count({ where: { status: 'REQUESTED' } }),
  },
  {
    key: 'stock',
    permission: 'inventory.view',
    async load({ db }) {
      const globalDefault = await loadLowStockDefault(db);
      const rows = await db.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
        SELECT
          SUM(CASE WHEN (COALESCE(i.quantity_on_hand, 0) - COALESCE(i.quantity_reserved, 0))
                        <= COALESCE(i.low_stock_threshold, ${globalDefault}) THEN 1 ELSE 0 END) AS lowStock,
          SUM(CASE WHEN v.status = 'ACTIVE'
                    AND (COALESCE(i.quantity_on_hand, 0) - COALESCE(i.quantity_reserved, 0)) <= 0
                   THEN 1 ELSE 0 END) AS outOfStock
        FROM product_variants v
        JOIN products p ON p.id = v.product_id
        LEFT JOIN inventory i ON i.variant_id = v.id
        WHERE v.deleted_at IS NULL AND p.deleted_at IS NULL`);
      const row = rows[0] ?? {};
      return { lowStockCount: toInt(row.lowStock), outOfStockCount: toInt(row.outOfStock) };
    },
  },
  {
    key: 'pendingReviews',
    permission: 'reviews.view',
    load: ({ db }) => db.review.count({ where: { status: 'PENDING', deletedAt: null } }),
  },
  {
    key: 'paymentSuccessRate',
    permission: 'payments.view',
    async load({ db, now }) {
      const today = istToday(now);
      const window = makeRange(shiftDate(today, -6), today);
      const groups = await db.payment.groupBy({
        by: ['status'],
        where: { createdAt: { gte: window.start, lt: window.end } },
        _count: { _all: true },
      });
      const count = (statuses: readonly string[]): number =>
        groups.filter((g) => statuses.includes(g.status)).reduce((a, g) => a + g._count._all, 0);
      const captured = count(['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED']);
      const failed = count(['FAILED']);
      return {
        from: window.from,
        to: window.to,
        captured,
        failed,
        ratePercent:
          captured + failed === 0
            ? null
            : new Decimal(captured)
                .div(captured + failed)
                .times(100)
                .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
                .toFixed(2),
      };
    },
  },
  {
    key: 'salesTrend',
    permission: 'reports.view',
    async load({ db, now }) {
      const today = istToday(now);
      const window = makeRange(shiftDate(today, -29), today);
      const perDay = await salesPerDay(db, window, { basis: 'transaction' });
      const { series } = rollUp(perDay, SALES_METRICS, window, 'day');
      return series.map(({ bucket, values }) => ({
        date: bucket.key,
        netSales: toMoneyString(deriveSales(values).netSales ?? ZERO),
        orders: values.orders.toNumber(),
      }));
    },
  },
  {
    key: 'topProducts',
    permission: 'reports.view',
    async load({ db, now }) {
      const today = istToday(now);
      const window = makeRange(shiftDate(today, -6), today);
      const rows = await db.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
        SELECT oi.product_id AS productId,
               SUBSTRING(MAX(CONCAT(DATE_FORMAT(o.confirmed_at, '%Y%m%d%H%i%s%f'), oi.product_name)), 21) AS name,
               SUM(oi.quantity) AS unitsSold, SUM(oi.line_total) AS revenue
        FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE o.confirmed_at >= ${window.start} AND o.confirmed_at < ${window.end}
          AND o.status NOT IN ('PENDING_PAYMENT', 'PAYMENT_FAILED')
        GROUP BY oi.product_id
        ORDER BY unitsSold DESC, revenue DESC
        LIMIT 5`);
      return rows.map((r) => ({
        productId: toStr(r.productId),
        name: toStr(r.name),
        unitsSold: toInt(r.unitsSold),
        revenue: toMoneyString(toDec(r.revenue)),
      }));
    },
  },
  {
    key: 'failedNotifications',
    permission: 'notifications.view',
    load: ({ db, now }) =>
      db.notification.count({
        where: { status: 'FAILED', createdAt: { gte: new Date(now.getTime() - 24 * 3600 * 1000) } },
      }),
  },
];

export function visibleWidgets(
  viewer: Pick<AuthContext, 'permissions' | 'isSuperadmin'>,
): Widget[] {
  return WIDGETS.filter((w) => hasPermission(viewer, w.permission));
}

export function createDashboardService(c: AppContainer) {
  const { db, clock, store } = c;
  return {
    async summary(viewer: AuthContext, query: DashboardQuery): Promise<Record<string, unknown>> {
      const now = clock();
      const today = istToday(now);
      const range =
        resolveReportRange(
          { from: query.from ?? query.to ?? today, to: query.to ?? today, period: undefined },
          { dateMode: 'required', maxDays: DASHBOARD_MAX_RANGE_DAYS, now },
        ) ?? makeRange(today, today);
      const widgets = visibleWidgets(viewer);
      const cacheKey = `dashboard:${createHash('sha256')
        .update(JSON.stringify([range.from, range.to, widgets.map((w) => w.key)]))
        .digest('hex')}`;
      const cached = store.get(cacheKey);
      if (cached !== undefined) return cached as Record<string, unknown>;

      const ctx: WidgetContext = { db, now, range };
      const values = await Promise.all(widgets.map((w) => w.load(ctx)));
      const data: Record<string, unknown> = {
        range: { from: range.from, to: range.to, timezone: 'Asia/Kolkata' },
        generatedAt: now.toISOString(),
        cacheTtlSeconds: DASHBOARD_CACHE_TTL_SECONDS,
        widgets: widgets.map((w) => w.key),
      };
      widgets.forEach((w, i) => {
        data[w.key] = values[i];
      });
      store.set(cacheKey, data, DASHBOARD_CACHE_TTL_SECONDS);
      return data;
    },
  };
}

export type DashboardService = ReturnType<typeof createDashboardService>;

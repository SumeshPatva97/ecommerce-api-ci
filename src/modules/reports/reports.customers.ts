/**
 * Customer family — REPORTING_AND_ANALYTICS.md §4.5, §5.10, §5.11: `customers-new-returning`,
 * `top-customers`. Both require `customers.view` (R-14); their exports are customer-data exports
 * (`customers.export` + re-auth, R-15).
 */
import { Prisma } from '../../generated/prisma/client.js';
import { Decimal, ZERO } from '../../lib/money.js';
import { buildBuckets, defaultGroupBy } from './reports.buckets.js';
import { canSeeCustomers, maskEmail, maskName } from './reports.mask.js';
import { istToday } from './reports.params.js';
import {
  and,
  istDay,
  normalizeRow,
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

// customers-new-returning ----------------------------------------------------------------------

const NR_COLUMNS: readonly ReportColumn[] = [
  { key: 'bucket', label: 'Period', type: 'string' },
  { key: 'isPartial', label: 'Partial period', type: 'boolean' },
  { key: 'signUps', label: 'Sign-ups', type: 'int' },
  { key: 'newCustomers', label: 'New customers', type: 'int' },
  { key: 'returningCustomers', label: 'Returning customers', type: 'int' },
  { key: 'repeatRate', label: 'Repeat rate', type: 'percent' },
  { key: 'newCustomerRevenue', label: 'New customer revenue', type: 'money' },
  { key: 'returningCustomerRevenue', label: 'Returning customer revenue', type: 'money' },
  { key: 'aovNew', label: 'AOV (new)', type: 'money' },
  { key: 'aovReturning', label: 'AOV (returning)', type: 'money' },
];

interface ClassTotals {
  signUps: number;
  newCustomers: number;
  returningCustomers: number;
  newOrders: number;
  returningOrders: number;
  newRevenue: Decimal;
  returningRevenue: Decimal;
}

const emptyTotals = (): ClassTotals => ({
  signUps: 0,
  newCustomers: 0,
  returningCustomers: 0,
  newOrders: 0,
  returningOrders: 0,
  newRevenue: ZERO,
  returningRevenue: ZERO,
});

interface CustomerAgg {
  orders: number;
  revenue: Decimal;
  firstDay: string;
}

/**
 * Classifies customers within one period: new when the first-ever sales order falls on/after the
 * period start (inside the period, clipped to the range), else returning (§4.5). Each customer
 * counts once per period.
 */
export function classify(
  customers: ReadonlyMap<string, CustomerAgg>,
  periodStart: string,
  into: ClassTotals,
): void {
  for (const c of customers.values()) {
    if (c.firstDay >= periodStart) {
      into.newCustomers += 1;
      into.newOrders += c.orders;
      into.newRevenue = into.newRevenue.plus(c.revenue);
    } else {
      into.returningCustomers += 1;
      into.returningOrders += c.orders;
      into.returningRevenue = into.returningRevenue.plus(c.revenue);
    }
  }
}

function toRow(t: ClassTotals): Row {
  return {
    signUps: t.signUps,
    newCustomers: t.newCustomers,
    returningCustomers: t.returningCustomers,
    repeatRate: ratio(
      new Decimal(t.returningCustomers),
      new Decimal(t.newCustomers + t.returningCustomers),
      100,
    ),
    newCustomerRevenue: t.newRevenue,
    returningCustomerRevenue: t.returningRevenue,
    aovNew: ratio(t.newRevenue, new Decimal(t.newOrders)),
    aovReturning: ratio(t.returningRevenue, new Decimal(t.returningOrders)),
  };
}

async function runNewReturning(ctx: ReportContext): Promise<ReportOutput> {
  const range = rangeOf(ctx.range);
  const groupBy = ctx.params.groupBy ?? defaultGroupBy(range.days);
  const basisCurrent = ctx.params.basis === 'current';
  const [orders, signUps] = await Promise.all([
    ctx.db.$queryRaw<Row[]>(Prisma.sql`
      SELECT x.userId AS userId, x.day AS day, x.orders AS orders, x.revenue AS revenue,
             f.firstAt AS firstAt
      FROM (
        SELECT o.user_id AS userId, ${istDay('o.confirmed_at')} AS day, COUNT(*) AS orders,
               SUM(o.grand_total) AS revenue
        FROM orders o WHERE ${salesOrderWhere(range, ctx.params.basis)}
        GROUP BY o.user_id, day
      ) x
      JOIN (
        SELECT o2.user_id, MIN(o2.confirmed_at) AS firstAt
        FROM orders o2
        WHERE ${and([
          Prisma.sql`o2.confirmed_at IS NOT NULL AND o2.status NOT IN ('PENDING_PAYMENT', 'PAYMENT_FAILED')`,
          ...(basisCurrent ? [Prisma.sql`o2.status <> 'CANCELLED'`] : []),
          Prisma.sql`o2.user_id IN (SELECT o3.user_id FROM orders o3
            WHERE o3.confirmed_at >= ${range.start} AND o3.confirmed_at < ${range.end})`,
        ])}
        GROUP BY o2.user_id
      ) f ON f.user_id = x.userId`),
    ctx.db.$queryRaw<Row[]>(Prisma.sql`
      SELECT ${istDay('u.created_at')} AS day, COUNT(*) AS signUps
      FROM users u
      WHERE u.account_type = 'CUSTOMER' AND u.created_at >= ${range.start} AND u.created_at < ${range.end}
      GROUP BY day`),
  ]);

  const { buckets, dayToBucket } = buildBuckets(range, groupBy);
  const perBucket = new Map<string, Map<string, CustomerAgg>>(
    buckets.map((b) => [b.key, new Map()]),
  );
  const perRange = new Map<string, CustomerAgg>();
  const add = (map: Map<string, CustomerAgg>, userId: string, agg: CustomerAgg): void => {
    const existing = map.get(userId);
    if (existing === undefined) map.set(userId, { ...agg });
    else {
      existing.orders += agg.orders;
      existing.revenue = existing.revenue.plus(agg.revenue);
    }
  };
  for (const row of orders) {
    const userId = toStr(row.userId);
    const day = toStr(row.day);
    if (userId === null || day === null) continue;
    const firstAt = row.firstAt instanceof Date ? row.firstAt : new Date(toStr(row.firstAt) ?? day);
    const agg: CustomerAgg = {
      orders: toInt(row.orders),
      revenue: toDec(row.revenue),
      firstDay: istToday(firstAt),
    };
    const bucketKey = dayToBucket.get(day);
    const bucketMap = bucketKey === undefined ? undefined : perBucket.get(bucketKey);
    if (bucketMap !== undefined) add(bucketMap, userId, agg);
    add(perRange, userId, agg);
  }
  const signUpsByBucket = new Map<string, number>();
  let totalSignUps = 0;
  for (const row of signUps) {
    const key = dayToBucket.get(toStr(row.day) ?? '');
    if (key === undefined) continue;
    signUpsByBucket.set(key, (signUpsByBucket.get(key) ?? 0) + toInt(row.signUps));
    totalSignUps += toInt(row.signUps);
  }

  const rows = buckets.map((bucket) => {
    const t = emptyTotals();
    t.signUps = signUpsByBucket.get(bucket.key) ?? 0;
    classify(perBucket.get(bucket.key) ?? new Map(), bucket.start, t);
    return normalizeRow(NR_COLUMNS, {
      ...toRow(t),
      bucket: bucket.key,
      isPartial: bucket.isPartial,
    });
  });
  const totals = emptyTotals();
  totals.signUps = totalSignUps;
  classify(perRange, range.from, totals);
  return {
    columns: NR_COLUMNS,
    rows,
    totals: normalizeRow(NR_COLUMNS, toRow(totals)),
    totalItems: rows.length,
    paginated: false,
    extra: { groupBy, basis: ctx.params.basis },
  };
}

// top-customers --------------------------------------------------------------------------------

export const TOP_CUSTOMERS_DEFAULT_LIMIT = 50;

const TOP_COLUMNS: readonly ReportColumn[] = [
  { key: 'rank', label: 'Rank', type: 'int' },
  { key: 'customerId', label: 'Customer ID', type: 'string' },
  { key: 'customerName', label: 'Customer', type: 'string' },
  { key: 'customerEmail', label: 'Email', type: 'string' },
  { key: 'orders', label: 'Orders', type: 'int' },
  { key: 'units', label: 'Units', type: 'int' },
  { key: 'orderValue', label: 'Order value', type: 'money' },
  { key: 'refunds', label: 'Refunds', type: 'money' },
  { key: 'netRevenue', label: 'Net revenue', type: 'money' },
  { key: 'aov', label: 'AOV', type: 'money' },
  { key: 'firstOrderAt', label: 'First order (in range)', type: 'datetime' },
  { key: 'lastOrderAt', label: 'Last order (in range)', type: 'datetime' },
];

async function runTopCustomers(ctx: ReportContext): Promise<ReportOutput> {
  const range = rangeOf(ctx.range);
  const p = ctx.params;
  const top = p.limit ?? TOP_CUSTOMERS_DEFAULT_LIMIT;
  const where: Prisma.Sql[] = [salesOrderWhere(range, p.basis)];
  if (p.stateCode !== undefined)
    where.push(Prisma.sql`o.place_of_supply_state_code = ${p.stateCode}`);
  const orderBy =
    p.metric === 'orders'
      ? Prisma.sql`orders DESC, netRevenue DESC`
      : Prisma.sql`netRevenue DESC, orderValue DESC`;
  const rows = await ctx.db.$queryRaw<Row[]>(Prisma.sql`
    SELECT o.user_id AS customerId, u.first_name AS firstName, u.last_name AS lastName,
           u.email AS customerEmail, COUNT(*) AS orders, SUM(o.total_quantity) AS units,
           SUM(o.grand_total) AS orderValue, COALESCE(MAX(rf.refunds), 0) AS refunds,
           SUM(o.grand_total) - COALESCE(MAX(rf.refunds), 0) AS netRevenue,
           MIN(o.confirmed_at) AS firstOrderAt, MAX(o.confirmed_at) AS lastOrderAt
    FROM orders o
    JOIN users u ON u.id = o.user_id
    LEFT JOIN (
      SELECT o4.user_id, SUM(r.amount) AS refunds
      FROM refunds r JOIN orders o4 ON o4.id = r.order_id
      WHERE ${and([
        Prisma.sql`r.status = 'COMPLETED' AND r.completed_at >= ${range.start} AND r.completed_at < ${range.end}`,
        ...(p.basis === 'current' ? [Prisma.sql`o4.status <> 'CANCELLED'`] : []),
      ])}
      GROUP BY o4.user_id) rf ON rf.user_id = o.user_id
    WHERE ${and(where)}
    GROUP BY o.user_id, u.first_name, u.last_name, u.email
    ORDER BY ${orderBy}
    LIMIT ${top}`);
  const unmasked = canSeeCustomers(ctx.viewer);
  const out = rows.map((r, i) => {
    const first = toStr(r.firstName) ?? '';
    const last = toStr(r.lastName);
    const name = last === null ? first : `${first} ${last}`;
    return normalizeRow(TOP_COLUMNS, {
      ...r,
      rank: i + 1,
      customerName: unmasked ? name : maskName(name),
      customerEmail: unmasked ? r.customerEmail : maskEmail(toStr(r.customerEmail)),
      aov: ratio(toDec(r.orderValue), new Decimal(toInt(r.orders))),
    });
  });
  return {
    columns: TOP_COLUMNS,
    rows: out,
    totals: null,
    totalItems: out.length,
    paginated: false,
    extra: { metric: p.metric ?? 'revenue', limit: top },
  };
}

export const CUSTOMER_REPORTS: readonly ReportDefinition[] = [
  {
    key: 'customers-new-returning',
    title: 'New & returning customers',
    version: '1.0',
    domainPermissions: ['customers.view'],
    dateMode: 'required',
    maxRangeDays: 1096,
    timeSeries: true,
    customerData: true,
    containsPii: () => false,
    run: runNewReturning,
  },
  {
    key: 'top-customers',
    title: 'Top customers',
    version: '1.0',
    domainPermissions: ['customers.view'],
    dateMode: 'required',
    maxRangeDays: 366,
    timeSeries: false,
    customerData: true,
    containsPii: canSeeCustomers,
    run: runTopCustomers,
  },
];

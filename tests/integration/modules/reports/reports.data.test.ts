/**
 * Reports with NON-EMPTY mocked data — FR-RPT-003/004/005/008/010 and FR-PRM-007
 * (REPORTING_AND_ANALYTICS.md §5.3–§5.7, §5.12, §5.13, §5.19, §5.20).
 *
 * MOCKED DB (Prisma stand-in, no MySQL): `t.m.$queryRaw` resolves in call order, so every SQL
 * aggregate (SUM / COUNT / GROUP BY / ORDER BY) is an INPUT here. What these tests pin is the part
 * the API computes itself — derived columns, ratios, labels, masking, value formats, the totals
 * block — plus the filters that are bound into each query (IST date range, status lists, ids).
 * Expected values are worked out by hand next to the inputs.
 */
import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { Decimal } from '../../../../src/lib/money.js';
import { createReportsModule } from '../../../../src/modules/reports/index.js';
import { buildModuleTestApp } from '../../../helpers/container.js';

const NOW = new Date('2026-11-19T06:30:00.000Z'); // 12:00 IST
const VIEW = ['reports.view'];
const BASE = '/api/v1/admin/reports';

/** `from=2026-11-01&to=2026-11-07` (IST dates) → UTC `[31 Oct 18:30Z, 7 Nov 18:30Z)` (rule G1). */
const RANGE = 'from=2026-11-01&to=2026-11-07';
const START = new Date('2026-10-31T18:30:00.000Z');
const END = new Date('2026-11-07T18:30:00.000Z');

function app() {
  const t = buildModuleTestApp([createReportsModule], { now: NOW });
  t.m.auditLog.create.mockResolvedValue({});
  return t;
}

type T = ReturnType<typeof app>;

interface RawSql {
  /** Statement text with `?` placeholders, whitespace collapsed. */
  readonly sql: string;
  /** Bound parameters, in placeholder order. */
  readonly values: unknown[];
}

/** The `Prisma.sql` statement handed to the n-th `$queryRaw` call. */
function rawCall(t: T, index: number): RawSql {
  const arg = t.m.$queryRaw.mock.calls[index]?.[0] as RawSql | undefined;
  if (arg === undefined) throw new Error(`$queryRaw call #${String(index)} was not made`);
  return { sql: arg.sql.replace(/\s+/g, ' '), values: arg.values };
}

/** pagedQuery = [page rows, COUNT/SUM aggregate over the full filtered set]. */
function mockPaged(t: T, rows: unknown[], totalItems: number, sums: Record<string, unknown>) {
  t.m.$queryRaw
    .mockResolvedValueOnce(rows)
    .mockResolvedValueOnce([{ totalItems: BigInt(totalItems), ...sums }]);
}

function get(t: T, key: string, query: string, permissions: readonly string[] = VIEW) {
  return request(t.app).get(`${BASE}/${key}?${query}`).set(t.staff({ permissions }).headers);
}

const d = (value: string): Decimal => new Decimal(value);

describe('FR-RPT-003 order-status report (non-empty data)', () => {
  it('FR-RPT-003 snapshot: orders rows by lifecycle, computes share %, open age and totals', async () => {
    const t = app();
    // DB rows arrive in arbitrary GROUP BY order. Counts 1 + 3 + 1 + 2 = 7 orders.
    t.m.$queryRaw.mockResolvedValueOnce([
      { status: 'DELIVERED', count: 1n, orderValue: d('12500.00'), oldestOpenAt: null },
      {
        status: 'CONFIRMED',
        count: 3n,
        orderValue: d('4500.50'),
        oldestOpenAt: new Date('2026-11-18T06:30:00.000Z'), // NOW − 24 h
      },
      { status: 'CANCELLED', count: 1n, orderValue: d('1999.5'), oldestOpenAt: null },
      {
        status: 'SHIPPED',
        count: 2n,
        orderValue: d('9000.00'),
        oldestOpenAt: new Date('2026-11-17T00:00:00.000Z'), // NOW − 54 h 30 min
      },
    ]);
    const res = await get(t, 'order-status', RANGE);
    expect(res.status).toBe(200);
    const { data, meta } = res.body;
    expect(data.mode).toBe('snapshot');
    expect(data.filters).toMatchObject({
      from: '2026-11-01',
      to: '2026-11-07',
      timezone: 'Asia/Kolkata',
    });
    // Lifecycle (OrderStatus enum) order: CONFIRMED → SHIPPED → DELIVERED → CANCELLED.
    // Share = count / 7 × 100, half-up 2 dp: 3/7 = 42.857…, 2/7 = 28.571…, 1/7 = 14.2857…
    expect(data.rows).toEqual([
      {
        status: 'CONFIRMED',
        count: 3,
        percent: '42.86',
        orderValue: '4500.50',
        avgHoursInStatus: null,
        oldestOpenAgeHours: '24.00',
      },
      {
        status: 'SHIPPED',
        count: 2,
        percent: '28.57',
        orderValue: '9000.00',
        avgHoursInStatus: null,
        oldestOpenAgeHours: '54.50',
      },
      {
        status: 'DELIVERED',
        count: 1,
        percent: '14.29',
        orderValue: '12500.00',
        avgHoursInStatus: null,
        oldestOpenAgeHours: null,
      },
      {
        status: 'CANCELLED',
        count: 1,
        percent: '14.29',
        orderValue: '1999.50',
        avgHoursInStatus: null,
        oldestOpenAgeHours: null,
      },
    ]);
    // 4500.50 + 9000.00 + 12500.00 + 1999.50 = 28000.00
    expect(data.totals).toEqual({
      status: null,
      count: 7,
      percent: '100.00',
      orderValue: '28000.00',
      avgHoursInStatus: null,
      oldestOpenAgeHours: null,
    });
    expect(meta).toEqual({ rowCount: 4, currency: 'INR' });

    // One query: orders PLACED in the IST range, grouped by current status; "open" statuses bound
    // for the oldest-open age.
    expect(t.m.$queryRaw).toHaveBeenCalledTimes(1);
    const q = rawCall(t, 0);
    expect(q.sql).toContain('FROM orders o WHERE o.placed_at >= ? AND o.placed_at < ?');
    expect(q.sql).toContain('GROUP BY o.status');
    expect(q.values).toEqual([
      'PENDING_PAYMENT',
      'CONFIRMED',
      'PROCESSING',
      'PACKED',
      'SHIPPED',
      'OUT_FOR_DELIVERY',
      'CANCELLATION_REQUESTED',
      'RETURN_REQUESTED',
      START,
      END,
    ]);
  });

  it('FR-RPT-003 snapshot: binds the status list and payment-method filters', async () => {
    const t = app();
    t.m.$queryRaw.mockResolvedValueOnce([
      { status: 'SHIPPED', count: 1n, orderValue: d('750.00'), oldestOpenAt: null },
    ]);
    const res = await get(t, 'order-status', `${RANGE}&status=confirmed,SHIPPED&paymentMethod=COD`);
    expect(res.status).toBe(200);
    expect(res.body.data.filters).toMatchObject({
      status: ['CONFIRMED', 'SHIPPED'],
      paymentMethod: 'COD',
    });
    expect(res.body.data.rows).toEqual([
      {
        status: 'SHIPPED',
        count: 1,
        percent: '100.00',
        orderValue: '750.00',
        avgHoursInStatus: null,
        oldestOpenAgeHours: null,
      },
    ]);
    const q = rawCall(t, 0);
    expect(q.sql).toContain(
      'o.placed_at >= ? AND o.placed_at < ? AND o.status IN (?,?) AND o.payment_method = ?',
    );
    expect(q.values.slice(-5)).toEqual([START, END, 'CONFIRMED', 'SHIPPED', 'COD']);
  });

  it('FR-RPT-003 transitions: counts transitions per status with mean hours, no order value', async () => {
    const t = app();
    t.m.$queryRaw.mockResolvedValueOnce([
      { status: 'SHIPPED', count: 3n, avgHoursInStatus: d('30.256') },
      { status: 'PACKED', count: 5n, avgHoursInStatus: d('5.5') },
    ]);
    const res = await get(t, 'order-status', `${RANGE}&mode=transitions&status=PACKED,SHIPPED`);
    expect(res.status).toBe(200);
    expect(res.body.data.mode).toBe('transitions');
    // 5 + 3 = 8 transitions: 5/8 = 62.50 %, 3/8 = 37.50 %; 30.256 h → 30.26 (half-up 2 dp).
    expect(res.body.data.rows).toEqual([
      {
        status: 'PACKED',
        count: 5,
        percent: '62.50',
        orderValue: null,
        avgHoursInStatus: '5.50',
        oldestOpenAgeHours: null,
      },
      {
        status: 'SHIPPED',
        count: 3,
        percent: '37.50',
        orderValue: null,
        avgHoursInStatus: '30.26',
        oldestOpenAgeHours: null,
      },
    ]);
    expect(res.body.data.totals).toMatchObject({ count: 8, percent: '100.00', orderValue: null });
    const q = rawCall(t, 0);
    expect(q.sql).toContain('FROM order_status_history h1');
    expect(q.sql).toContain("h1.event_type = 'STATUS_CHANGE'");
    expect(q.sql).toContain('h.created_at >= ? AND h.created_at < ? AND h.to_status IN (?,?)');
    // Range bound twice: orders touched in range (sub-select) + transitions inside the range.
    expect(q.values).toEqual([START, END, START, END, 'PACKED', 'SHIPPED']);
  });
});

describe('FR-RPT-004 product, category and brand sales (non-empty data)', () => {
  const P1 = randomUUID();
  const P2 = randomUUID();
  const P3 = randomUUID();

  /**
   * Line aggregates per product. Each line satisfies gross − discounts = net = taxable + tax:
   *   P1 5000.00 − 500.00 = 4500.00 = 4368.93 + 131.07
   *   P2 6000.00 −   0.00 = 6000.00 = 5825.24 + 174.76
   *   P3 1200.00 − 200.00 = 1000.00 =  970.87 +  29.13
   */
  const productRows = () => [
    {
      productId: P3,
      productName: 'Charm Bracelet',
      units: d('7'),
      grossSales: d('1200.00'),
      discounts: d('200.00'),
      netSales: d('1000.00'),
      taxableValue: d('970.87'),
      tax: d('29.13'),
      orders: 2n,
      refundedUnits: d('0'),
      refundedAmount: d('0'),
    },
    {
      productId: P1,
      productName: 'Silver Ring',
      units: d('5'),
      grossSales: d('5000.00'),
      discounts: d('500.00'),
      netSales: d('4500.00'),
      taxableValue: d('4368.93'),
      tax: d('131.07'),
      orders: 4n,
      refundedUnits: d('1'),
      refundedAmount: d('900.00'),
    },
    {
      productId: P2,
      productName: 'Gold Chain',
      units: d('3'),
      grossSales: d('6000.00'),
      discounts: d('0'),
      netSales: d('6000.00'),
      taxableValue: d('5825.24'),
      tax: d('174.76'),
      orders: 3n,
      refundedUnits: d('0'),
      refundedAmount: d('0'),
    },
  ];
  /** Column sums of the three rows above (7+5+3, 1200+5000+6000, …). */
  const productSums = {
    units: d('15'),
    grossSales: d('12200.00'),
    discounts: d('700.00'),
    netSales: d('11500.00'),
    taxableValue: d('11165.04'),
    tax: d('334.96'),
    refundedUnits: d('1'),
    refundedAmount: d('900.00'),
  };

  it('FR-RPT-004 product-sales: derives net units and average selling price per row and in totals', async () => {
    const t = app();
    mockPaged(t, productRows(), 3, productSums);
    const res = await get(t, 'product-sales', RANGE);
    expect(res.status).toBe(200);
    const { data, meta } = res.body;
    expect(data.level).toBe('product');
    expect((data.columns as { key: string }[]).map((c) => c.key)).toEqual([
      'productId',
      'productName',
      'units',
      'grossSales',
      'discounts',
      'netSales',
      'taxableValue',
      'tax',
      'refundedUnits',
      'refundedAmount',
      'netUnits',
      'orders',
      'avgSellingPrice',
    ]);
    // Rows keep the DB order (units DESC). netUnits = units − refundedUnits;
    // avgSellingPrice = netSales / units: 1000/7 = 142.857… → 142.86; 4500/5 = 900; 6000/3 = 2000.
    expect(data.rows).toEqual([
      {
        productId: P3,
        productName: 'Charm Bracelet',
        units: 7,
        grossSales: '1200.00',
        discounts: '200.00',
        netSales: '1000.00',
        taxableValue: '970.87',
        tax: '29.13',
        refundedUnits: 0,
        refundedAmount: '0.00',
        netUnits: 7,
        orders: 2,
        avgSellingPrice: '142.86',
      },
      {
        productId: P1,
        productName: 'Silver Ring',
        units: 5,
        grossSales: '5000.00',
        discounts: '500.00',
        netSales: '4500.00',
        taxableValue: '4368.93',
        tax: '131.07',
        refundedUnits: 1,
        refundedAmount: '900.00',
        netUnits: 4,
        orders: 4,
        avgSellingPrice: '900.00',
      },
      {
        productId: P2,
        productName: 'Gold Chain',
        units: 3,
        grossSales: '6000.00',
        discounts: '0.00',
        netSales: '6000.00',
        taxableValue: '5825.24',
        tax: '174.76',
        refundedUnits: 0,
        refundedAmount: '0.00',
        netUnits: 3,
        orders: 3,
        avgSellingPrice: '2000.00',
      },
    ]);
    // Totals: netUnits 15 − 1 = 14; avgSellingPrice 11500 / 15 = 766.666… → 766.67. Distinct
    // orders cannot be summed across products, so the totals leave `orders` empty.
    expect(data.totals).toEqual({
      productId: null,
      productName: null,
      units: 15,
      grossSales: '12200.00',
      discounts: '700.00',
      netSales: '11500.00',
      taxableValue: '11165.04',
      tax: '334.96',
      refundedUnits: 1,
      refundedAmount: '900.00',
      netUnits: 14,
      orders: null,
      avgSellingPrice: '766.67',
    });
    expect(meta).toMatchObject({ page: 1, limit: 25, totalItems: 3, totalPages: 1 });

    // Page query: sales orders S confirmed in the IST range, refunds from COMPLETED refunds only.
    const page = rawCall(t, 0);
    expect(page.sql).toContain('FROM order_items oi JOIN orders o ON o.id = oi.order_id');
    expect(page.sql).toContain(
      "o.confirmed_at >= ? AND o.confirmed_at < ? AND o.status NOT IN ('PENDING_PAYMENT', 'PAYMENT_FAILED')",
    );
    expect(page.sql).not.toContain("<> 'CANCELLED'"); // basis=transaction (default)
    expect(page.sql).toContain("r.status = 'COMPLETED'");
    expect(page.sql).toContain('GROUP BY oi.product_id) x');
    expect(page.sql).toContain(
      'ORDER BY x.units DESC, x.netSales DESC, x.productName ASC LIMIT ? OFFSET ?',
    );
    expect(page.values).toEqual([START, END, 25, 0]);
    // Totals query runs over the same filtered set, without paging.
    const agg = rawCall(t, 1);
    expect(agg.sql).toContain('SELECT COUNT(*) AS totalItems, SUM(x.`units`) AS `units`');
    expect(agg.values).toEqual([START, END]);
  });

  it('FR-RPT-004 product-sales: variant level, revenue sort, basis=current and item filters reach the query', async () => {
    const t = app();
    const categoryId = randomUUID();
    const brandId = randomUUID();
    const variantId = randomUUID();
    mockPaged(
      t,
      [
        {
          productId: P1,
          productName: 'Silver Ring',
          variantId,
          sku: 'RNG-7',
          variantName: 'Size 7',
          units: d('2'),
          grossSales: d('2000.00'),
          discounts: d('250.00'),
          netSales: d('1750.00'),
          taxableValue: d('1699.03'),
          tax: d('50.97'),
          orders: 2n,
          refundedUnits: d('2'),
          refundedAmount: d('1750.00'),
        },
      ],
      1,
      {
        units: d('2'),
        grossSales: d('2000.00'),
        discounts: d('250.00'),
        netSales: d('1750.00'),
        taxableValue: d('1699.03'),
        tax: d('50.97'),
        refundedUnits: d('2'),
        refundedAmount: d('1750.00'),
      },
    );
    const res = await get(
      t,
      'product-sales',
      `${RANGE}&level=variant&sort=revenue_desc&basis=current&categoryId=${categoryId}&brandId=${brandId}&page=2&limit=10`,
    );
    expect(res.status).toBe(200);
    expect(res.body.data.level).toBe('variant');
    // Fully refunded line: netUnits 2 − 2 = 0, average price still 1750 / 2 = 875.00.
    expect(res.body.data.rows[0]).toEqual({
      productId: P1,
      productName: 'Silver Ring',
      variantId,
      sku: 'RNG-7',
      variantName: 'Size 7',
      units: 2,
      grossSales: '2000.00',
      discounts: '250.00',
      netSales: '1750.00',
      taxableValue: '1699.03',
      tax: '50.97',
      refundedUnits: 2,
      refundedAmount: '1750.00',
      netUnits: 0,
      orders: 2,
      avgSellingPrice: '875.00',
    });
    const page = rawCall(t, 0);
    expect(page.sql).toContain("AND o.status <> 'CANCELLED'");
    expect(page.sql).toContain('oi.category_id_snapshot IN ( SELECT cd.id FROM categories cd');
    expect(page.sql).toContain('oi.brand_id_snapshot = ?');
    expect(page.sql).toContain('GROUP BY oi.product_id, oi.variant_id) x');
    expect(page.sql).toContain('ORDER BY x.netSales DESC, x.units DESC, x.productName ASC');
    // LIMIT 10 OFFSET 10 (page 2).
    expect(page.values).toEqual([START, END, categoryId, brandId, 10, 10]);
  });

  it('FR-RPT-004 category-sales: labels the category path, computes share of net sales and totals', async () => {
    const t = app();
    const root = randomUUID();
    const rings = randomUUID();
    const chains = randomUUID();
    const removed = randomUUID();
    mockPaged(
      t,
      [
        {
          categoryId: rings,
          categoryName: 'Rings',
          categoryTreePath: `/${root}/${rings}/`,
          units: d('10'),
          grossSales: d('9000.00'),
          discounts: d('1000.00'),
          netSales: d('8000.00'),
          taxableValue: d('7766.99'),
          orders: 8n,
        },
        {
          categoryId: chains,
          categoryName: 'Chains',
          categoryTreePath: `/${root}/${chains}/`,
          units: d('4'),
          grossSales: d('4000.00'),
          discounts: d('0'),
          netSales: d('4000.00'),
          taxableValue: d('3883.50'),
          orders: 4n,
        },
        // Category row no longer exists: no tree path, the order-line snapshot name is shown.
        {
          categoryId: removed,
          categoryName: 'Legacy charms',
          categoryTreePath: null,
          units: d('2'),
          grossSales: d('1000.00'),
          discounts: d('0'),
          netSales: d('1000.00'),
          taxableValue: d('970.87'),
          orders: 2n,
        },
      ],
      3,
      {
        units: d('16'), // 10 + 4 + 2
        grossSales: d('14000.00'), // 9000 + 4000 + 1000
        discounts: d('1000.00'),
        netSales: d('13000.00'), // 8000 + 4000 + 1000
        taxableValue: d('12621.36'), // 7766.99 + 3883.50 + 970.87
      },
    );
    t.m.category.findMany.mockResolvedValue([
      { id: root, name: 'Jewellery' },
      { id: rings, name: 'Rings' },
      { id: chains, name: 'Chains' },
    ]);
    const res = await get(t, 'category-sales', RANGE);
    expect(res.status).toBe(200);
    const { data } = res.body;
    // Share of net sales over 13000.00: 8000 → 61.538… = 61.54; 4000 → 30.769… = 30.77;
    // 1000 → 7.692… = 7.69.
    expect(data.rows).toEqual([
      {
        categoryId: rings,
        categoryPath: 'Jewellery > Rings',
        units: 10,
        grossSales: '9000.00',
        discounts: '1000.00',
        netSales: '8000.00',
        taxableValue: '7766.99',
        share: '61.54',
        orders: 8,
      },
      {
        categoryId: chains,
        categoryPath: 'Jewellery > Chains',
        units: 4,
        grossSales: '4000.00',
        discounts: '0.00',
        netSales: '4000.00',
        taxableValue: '3883.50',
        share: '30.77',
        orders: 4,
      },
      {
        categoryId: removed,
        categoryPath: 'Legacy charms',
        units: 2,
        grossSales: '1000.00',
        discounts: '0.00',
        netSales: '1000.00',
        taxableValue: '970.87',
        share: '7.69',
        orders: 2,
      },
    ]);
    expect(data.totals).toEqual({
      categoryId: null,
      categoryPath: null,
      units: 16,
      grossSales: '14000.00',
      discounts: '1000.00',
      netSales: '13000.00',
      taxableValue: '12621.36',
      share: '100.00',
      orders: null,
    });
    expect(data.depth).toBeNull();
    expect(data.notices).toEqual(['Attributed by category at time of sale (order line snapshot).']);
    // Path labels are looked up once for every distinct id on the returned paths.
    expect(t.m.category.findMany).toHaveBeenCalledWith({
      where: { id: { in: [root, rings, chains] } },
      select: { id: true, name: true },
    });
    const page = rawCall(t, 0);
    expect(page.sql).toContain('GROUP BY oi.category_id_snapshot ) g');
    expect(page.sql).toContain(
      "o.confirmed_at >= ? AND o.confirmed_at < ? AND o.status NOT IN ('PENDING_PAYMENT', 'PAYMENT_FAILED')",
    );
    expect(page.sql).toContain('ORDER BY x.netSales DESC, x.categoryName ASC LIMIT ? OFFSET ?');
    expect(page.values).toEqual([START, END, 25, 0]);
  });

  it('FR-RPT-004 category-sales: depth rolls up to the ancestor at that level of the path', async () => {
    const t = app();
    const res = await get(t, 'category-sales', `${RANGE}&depth=1`);
    expect(res.status).toBe(200);
    expect(res.body.data.depth).toBe(1);
    expect(res.body.data.rows).toEqual([]);
    // No sales → no share (never 100 % of nothing).
    expect(res.body.data.totals).toMatchObject({ netSales: null, share: null });
    const page = rawCall(t, 0);
    // `/root/child/self/`: the 1st-level ancestor is the 2nd '/'-separated token.
    expect(page.sql).toContain("SUBSTRING_INDEX(SUBSTRING_INDEX(c.path, '/', 2), '/', -1)");
    expect(t.m.category.findMany).not.toHaveBeenCalled();
  });

  it('FR-RPT-004 brand-sales: share of net sales per brand, unbranded lines under "No brand"', async () => {
    const t = app();
    const aurum = randomUUID();
    mockPaged(
      t,
      [
        {
          brandId: aurum,
          brandName: 'Aurum',
          units: d('6'),
          grossSales: d('9000.00'),
          discounts: d('900.00'),
          netSales: d('8100.00'),
          taxableValue: d('7864.08'),
          orders: 5n,
        },
        {
          brandId: null,
          brandName: 'stale snapshot text',
          units: d('3'),
          grossSales: d('2000.00'),
          discounts: d('100.00'),
          netSales: d('1900.00'),
          taxableValue: d('1844.66'),
          orders: 3n,
        },
      ],
      2,
      {
        units: d('9'),
        grossSales: d('11000.00'),
        discounts: d('1000.00'),
        netSales: d('10000.00'), // 8100 + 1900
        taxableValue: d('9708.74'), // 7864.08 + 1844.66
      },
    );
    const res = await get(t, 'brand-sales', RANGE);
    expect(res.status).toBe(200);
    // 8100 / 10000 = 81 %, 1900 / 10000 = 19 %.
    expect(res.body.data.rows).toEqual([
      {
        brandId: aurum,
        brandName: 'Aurum',
        units: 6,
        grossSales: '9000.00',
        discounts: '900.00',
        netSales: '8100.00',
        taxableValue: '7864.08',
        share: '81.00',
        orders: 5,
      },
      {
        brandId: null,
        brandName: 'No brand',
        units: 3,
        grossSales: '2000.00',
        discounts: '100.00',
        netSales: '1900.00',
        taxableValue: '1844.66',
        share: '19.00',
        orders: 3,
      },
    ]);
    expect(res.body.data.totals).toEqual({
      brandId: null,
      brandName: null,
      units: 9,
      grossSales: '11000.00',
      discounts: '1000.00',
      netSales: '10000.00',
      taxableValue: '9708.74',
      share: '100.00',
      orders: null,
    });
    const page = rawCall(t, 0);
    expect(page.sql).toContain('GROUP BY oi.brand_id_snapshot) x');
    expect(page.sql).toContain('ORDER BY x.netSales DESC, x.brandName ASC LIMIT ? OFFSET ?');
    expect(page.values).toEqual([START, END, 25, 0]);
  });
});

describe('FR-RPT-005 best sellers (non-empty data)', () => {
  const A = randomUUID();
  const B = randomUUID();
  const C = randomUUID();
  const D = randomUUID();

  it('FR-RPT-005 best-sellers: ranks in DB order, adds trend vs the previous equal period, stock and pin', async () => {
    const t = app();
    t.m.$queryRaw
      // 1) Top rows, already ordered by the DB (net units DESC, net sales DESC, name ASC).
      .mockResolvedValueOnce([
        { productId: A, productName: 'Gold Chain', netUnits: d('12'), netSales: d('24000.00') },
        { productId: B, productName: 'Silver Ring', netUnits: d('9'), netSales: d('4500.00') },
        { productId: C, productName: 'Anklet', netUnits: d('9'), netSales: d('3000.5') },
        { productId: D, productName: 'Nose Pin', netUnits: d('2'), netSales: d('800.00') },
      ])
      // 2) Net units of the same products in the previous 7 days (D sold nothing then).
      .mockResolvedValueOnce([
        { productId: A, netUnits: d('8') },
        { productId: B, netUnits: d('12') },
        { productId: C, netUnits: d('7') },
      ])
      // 3) Current catalogue state (D's product row is gone).
      .mockResolvedValueOnce([
        { productId: A, productStatus: 'ACTIVE', pinned: 1, available: d('15') },
        { productId: B, productStatus: 'ACTIVE', pinned: 0, available: d('0') },
        { productId: C, productStatus: 'INACTIVE', pinned: 0, available: null },
      ]);
    const res = await get(t, 'best-sellers', RANGE);
    expect(res.status).toBe(200);
    const { data, meta } = res.body;
    expect(data.metric).toBe('units');
    expect(data.limit).toBe(20);
    // Trend = (now − previous) / previous × 100: (12−8)/8 = 50; (9−12)/12 = −25;
    // (9−7)/7 = 28.571… → 28.57; no previous sales → no trend.
    expect(data.rows).toEqual([
      {
        rank: 1,
        productId: A,
        productName: 'Gold Chain',
        netUnits: 12,
        netSales: '24000.00',
        trendPercent: '50.00',
        available: 15,
        productStatus: 'ACTIVE',
        pinned: true,
      },
      {
        rank: 2,
        productId: B,
        productName: 'Silver Ring',
        netUnits: 9,
        netSales: '4500.00',
        trendPercent: '-25.00',
        available: 0,
        productStatus: 'ACTIVE',
        pinned: false,
      },
      {
        rank: 3,
        productId: C,
        productName: 'Anklet',
        netUnits: 9,
        netSales: '3000.50',
        trendPercent: '28.57',
        available: 0,
        productStatus: 'INACTIVE',
        pinned: false,
      },
      {
        rank: 4,
        productId: D,
        productName: 'Nose Pin',
        netUnits: 2,
        netSales: '800.00',
        trendPercent: null,
        available: 0,
        productStatus: null,
        pinned: false,
      },
    ]);
    expect(data.totals).toBeNull();
    expect(meta).toEqual({ rowCount: 4, currency: 'INR' });

    expect(t.m.$queryRaw).toHaveBeenCalledTimes(3);
    const top = rawCall(t, 0);
    expect(top.sql).toContain('SUM(oi.quantity) - SUM(COALESCE(rf.qty, 0)) AS netUnits');
    expect(top.sql).toContain('SUM(oi.line_total) - SUM(COALESCE(rf.amount, 0)) AS netSales');
    expect(top.sql).toContain("o.status NOT IN ('PENDING_PAYMENT', 'PAYMENT_FAILED')");
    expect(top.sql).toContain(
      'ORDER BY x.netUnits DESC, x.netSales DESC, x.productName ASC LIMIT ?',
    );
    expect(top.values).toEqual([START, END, 20]); // default top 20
    // Previous equal period: the 7 IST days before the range (25–31 Oct).
    const previous = rawCall(t, 1);
    expect(previous.values).toEqual([
      new Date('2026-10-24T18:30:00.000Z'),
      new Date('2026-10-31T18:30:00.000Z'),
      A,
      B,
      C,
      D,
    ]);
    const stock = rawCall(t, 2);
    expect(stock.sql).toContain('FROM products p WHERE p.id IN (?,?,?,?)');
    expect(stock.values).toEqual([A, B, C, D]);
  });

  it('FR-RPT-005 best-sellers: metric=revenue ranks by net sales; default window is the last 90 IST days', async () => {
    const t = app();
    const brandId = randomUUID();
    t.m.$queryRaw.mockResolvedValueOnce([]);
    const res = await get(t, 'best-sellers', `metric=revenue&limit=3&brandId=${brandId}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ metric: 'revenue', limit: 3, rows: [] });
    // Today is 2026-11-19 IST; 90 days inclusive start on 2026-08-22 (19 + 31 + 30 + 10 days).
    expect(res.body.data.filters).toMatchObject({ from: '2026-08-22', to: '2026-11-19' });
    // No ranked products → no trend / stock look-ups.
    expect(t.m.$queryRaw).toHaveBeenCalledTimes(1);
    const top = rawCall(t, 0);
    expect(top.sql).toContain('oi.brand_id_snapshot = ?');
    expect(top.sql).toContain(
      'ORDER BY x.netSales DESC, x.netUnits DESC, x.productName ASC LIMIT ?',
    );
    expect(top.values).toEqual([
      new Date('2026-08-21T18:30:00.000Z'),
      new Date('2026-11-19T18:30:00.000Z'),
      brandId,
      3,
    ]);
  });
});

describe('FR-RPT-008 coupon and promotion reports (non-empty data)', () => {
  it('FR-RPT-008 coupons: derives average discount, usage limit / remaining and revenue per rupee', async () => {
    const t = app();
    const k1 = randomUUID();
    const k2 = randomUUID();
    const k3 = randomUUID();
    mockPaged(
      t,
      [
        // Limited coupon: 12 redemptions, 2 restored → 10 net.
        {
          couponId: k1,
          code: 'DIWALI10',
          discountType: 'PERCENTAGE',
          value: d('10.00'),
          couponStatus: 'ACTIVE',
          usageLimitEnabled: 1,
          usageLimit: 100,
          usedCount: 40,
          redemptions: 12n,
          released: d('2'),
          netRedemptions: d('10'),
          uniqueCustomers: 9n,
          discountGiven: d('2500.00'),
          ordersValue: d('30000.00'),
          reservedNow: 3n,
        },
        // Unlimited coupon (limit disabled).
        {
          couponId: k2,
          code: 'FLAT200',
          discountType: 'FIXED_AMOUNT',
          value: d('200.00'),
          couponStatus: 'INACTIVE',
          usageLimitEnabled: 0,
          usageLimit: null,
          usedCount: 7,
          redemptions: 7n,
          released: d('0'),
          netRedemptions: d('7'),
          uniqueCustomers: 7n,
          discountGiven: d('1400.00'),
          ordersValue: d('9999.99'),
          reservedNow: 0n,
        },
        // Every redemption restored and the limit already exceeded.
        {
          couponId: k3,
          code: 'OOPS5',
          discountType: 'FIXED_AMOUNT',
          value: d('50.00'),
          couponStatus: 'ACTIVE',
          usageLimitEnabled: 1,
          usageLimit: 5,
          usedCount: 6,
          redemptions: 3n,
          released: d('3'),
          netRedemptions: d('0'),
          uniqueCustomers: 0n,
          discountGiven: d('0'),
          ordersValue: d('0'),
          reservedNow: 1n,
        },
      ],
      3,
      {
        redemptions: d('22'), // 12 + 7 + 3
        released: d('5'), // 2 + 0 + 3
        netRedemptions: d('17'), // 10 + 7 + 0
        discountGiven: d('3900.00'), // 2500 + 1400 + 0
        ordersValue: d('39999.99'), // 30000 + 9999.99 + 0
      },
    );
    const res = await get(t, 'coupons', RANGE);
    expect(res.status).toBe(200);
    const { data } = res.body;
    expect(data.rows).toEqual([
      {
        code: 'DIWALI10',
        discountType: 'PERCENTAGE',
        value: '10.00',
        couponStatus: 'ACTIVE',
        redemptions: 12,
        reservedNow: 3,
        released: 2,
        netRedemptions: 10,
        uniqueCustomers: 9,
        discountGiven: '2500.00',
        ordersValue: '30000.00',
        avgDiscountPerOrder: '250.00', // 2500 / 10 net redemptions
        usageLimit: '100',
        remaining: '60', // 100 − 40 used
        revenuePerRupeeDiscount: '12.00', // 30000 / 2500
      },
      {
        code: 'FLAT200',
        discountType: 'FIXED_AMOUNT',
        value: '200.00',
        couponStatus: 'INACTIVE',
        redemptions: 7,
        reservedNow: 0,
        released: 0,
        netRedemptions: 7,
        uniqueCustomers: 7,
        discountGiven: '1400.00',
        ordersValue: '9999.99',
        avgDiscountPerOrder: '200.00', // 1400 / 7
        usageLimit: 'Unlimited',
        remaining: 'Unlimited',
        revenuePerRupeeDiscount: '7.14', // 9999.99 / 1400 = 7.1428…
      },
      {
        code: 'OOPS5',
        discountType: 'FIXED_AMOUNT',
        value: '50.00',
        couponStatus: 'ACTIVE',
        redemptions: 3,
        reservedNow: 1,
        released: 3,
        netRedemptions: 0,
        uniqueCustomers: 0,
        discountGiven: '0.00',
        ordersValue: '0.00',
        avgDiscountPerOrder: null, // no net redemption → no ratio
        usageLimit: '5',
        remaining: '0', // 5 − 6 never goes negative
        revenuePerRupeeDiscount: null, // no discount given → no ratio
      },
    ]);
    // Totals: 3900 / 17 = 229.411… → 229.41; 39999.99 / 3900 = 10.2564… → 10.26.
    expect(data.totals).toEqual({
      code: null,
      discountType: null,
      value: null,
      couponStatus: null,
      redemptions: 22,
      reservedNow: null,
      released: 5,
      netRedemptions: 17,
      uniqueCustomers: null,
      discountGiven: '3900.00',
      ordersValue: '39999.99',
      avgDiscountPerOrder: '229.41',
      usageLimit: null,
      remaining: null,
      revenuePerRupeeDiscount: '10.26',
    });
    expect(res.body.meta).toMatchObject({ page: 1, limit: 25, totalItems: 3, totalPages: 1 });

    const page = rawCall(t, 0);
    // Usage rows of orders confirmed in the IST range; restored (RELEASED) usages counted apart.
    expect(page.sql).toContain(
      "WHERE cu.status IN ('REDEEMED', 'RELEASED') AND o.confirmed_at >= ? AND o.confirmed_at < ? AND o.status NOT IN ('PENDING_PAYMENT', 'PAYMENT_FAILED')",
    );
    expect(page.sql).toContain('u.redemptions - u.released AS netRedemptions');
    expect(page.sql).toContain('ORDER BY x.discountGiven DESC, x.code ASC LIMIT ? OFFSET ?');
    expect(page.values).toEqual([START, END, 25, 0]);
    expect(rawCall(t, 1).values).toEqual([START, END]);
  });

  it('FR-RPT-008 coupons: binds couponId and coupon status filters; unknown status is a 422', async () => {
    const t = app();
    const couponId = randomUUID();
    const res = await get(t, 'coupons', `${RANGE}&couponId=${couponId}&status=active`);
    expect(res.status).toBe(200);
    const page = rawCall(t, 0);
    expect(page.sql).toContain('WHERE c.id = ? AND c.status IN (?)) x');
    expect(page.values).toEqual([START, END, couponId, 'ACTIVE', 25, 0]);

    const before = t.m.$queryRaw.mock.calls.length;
    const bad = await get(t, 'coupons', `${RANGE}&status=SHIPPED`);
    expect(bad.status).toBe(422);
    expect(bad.body.error.details[0].field).toBe('status');
    expect(t.m.$queryRaw.mock.calls.length).toBe(before);
  });

  it('FR-PRM-007 / FR-RPT-008 promotions: orders, units, discount given and revenue per promotion with totals and unit lift', async () => {
    const t = app();
    const m1 = randomUUID();
    const m2 = randomUUID();
    const m3 = randomUUID();
    mockPaged(
      t,
      [
        {
          promotionId: m1,
          name: 'Diwali Gold Fest',
          scope: 'CATEGORY',
          promotionStatus: 'ACTIVE',
          startsAt: new Date('2026-10-31T18:30:00.000Z'),
          endsAt: new Date('2026-11-10T18:29:59.000Z'),
          ordersWithPromotion: 14n,
          unitsPromoted: d('30'),
          discountGiven: d('4500.00'),
          promotedNetSales: d('40500.00'),
        },
        {
          promotionId: m2,
          name: 'Brand Week',
          scope: 'BRAND',
          promotionStatus: 'EXPIRED',
          startsAt: new Date('2026-11-01T18:30:00.000Z'),
          endsAt: new Date('2026-11-04T18:30:00.000Z'),
          ordersWithPromotion: 6n,
          unitsPromoted: d('9'),
          discountGiven: d('900.00'),
          promotedNetSales: d('8100.00'),
        },
        {
          promotionId: m3,
          name: 'Ring Deal',
          scope: 'PRODUCT',
          promotionStatus: 'PAUSED',
          startsAt: null,
          endsAt: null,
          ordersWithPromotion: 2n,
          unitsPromoted: d('5'),
          discountGiven: d('250.5'),
          promotedNetSales: d('2249.50'),
        },
      ],
      3,
      {
        ordersWithPromotion: d('22'), // 14 + 6 + 2
        unitsPromoted: d('44'), // 30 + 9 + 5
        discountGiven: d('5650.50'), // 4500 + 900 + 250.50
        promotedNetSales: d('50849.50'), // 40500 + 8100 + 2249.50
      },
    );
    // Baseline units (same variants, equal-length period before the promotion); none for m3.
    t.m.$queryRaw.mockResolvedValueOnce([
      { promotionId: m1, baselineUnits: d('20') },
      { promotionId: m2, baselineUnits: d('12') },
    ]);
    const res = await get(t, 'promotions', RANGE);
    expect(res.status).toBe(200);
    const { data } = res.body;
    // FR-PRM-007 columns: orders, units, discount given, revenue (promoted net sales).
    const labels = Object.fromEntries(
      (data.columns as { key: string; label: string }[]).map((c) => [c.key, c.label]),
    );
    expect(labels).toMatchObject({
      ordersWithPromotion: 'Orders',
      unitsPromoted: 'Units',
      discountGiven: 'Discount given',
      promotedNetSales: 'Net sales',
    });
    // Unit lift = (promoted − baseline) / baseline × 100: (30−20)/20 = 50; (9−12)/12 = −25;
    // baseline 0 → "n/a".
    expect(data.rows).toEqual([
      {
        promotionId: m1,
        name: 'Diwali Gold Fest',
        scope: 'CATEGORY',
        promotionStatus: 'ACTIVE',
        startsAt: '2026-10-31T18:30:00.000Z',
        endsAt: '2026-11-10T18:29:59.000Z',
        ordersWithPromotion: 14,
        unitsPromoted: 30,
        discountGiven: '4500.00',
        promotedNetSales: '40500.00',
        baselineUnits: 20,
        unitLift: '50.00',
      },
      {
        promotionId: m2,
        name: 'Brand Week',
        scope: 'BRAND',
        promotionStatus: 'EXPIRED',
        startsAt: '2026-11-01T18:30:00.000Z',
        endsAt: '2026-11-04T18:30:00.000Z',
        ordersWithPromotion: 6,
        unitsPromoted: 9,
        discountGiven: '900.00',
        promotedNetSales: '8100.00',
        baselineUnits: 12,
        unitLift: '-25.00',
      },
      {
        promotionId: m3,
        name: 'Ring Deal',
        scope: 'PRODUCT',
        promotionStatus: 'PAUSED',
        startsAt: null,
        endsAt: null,
        ordersWithPromotion: 2,
        unitsPromoted: 5,
        discountGiven: '250.50',
        promotedNetSales: '2249.50',
        baselineUnits: 0,
        unitLift: 'n/a',
      },
    ]);
    expect(data.totals).toEqual({
      promotionId: null,
      name: null,
      scope: null,
      promotionStatus: null,
      startsAt: null,
      endsAt: null,
      ordersWithPromotion: 22,
      unitsPromoted: 44,
      discountGiven: '5650.50',
      promotedNetSales: '50849.50',
      baselineUnits: null,
      unitLift: null,
    });
    expect(data.notices).toEqual(['Unit lift is indicative (no control group).']);
    expect(res.body.meta).toMatchObject({ page: 1, limit: 25, totalItems: 3, totalPages: 1 });

    expect(t.m.$queryRaw).toHaveBeenCalledTimes(3);
    const page = rawCall(t, 0);
    // Attribution by the order-line promotion snapshot, sales orders confirmed in the IST range.
    expect(page.sql).toContain(
      "o.confirmed_at >= ? AND o.confirmed_at < ? AND o.status NOT IN ('PENDING_PAYMENT', 'PAYMENT_FAILED') AND oi.promotion_id IS NOT NULL GROUP BY oi.promotion_id",
    );
    expect(page.sql).toContain('COUNT(DISTINCT oi.order_id) AS ordersWithPromotion');
    expect(page.sql).toContain('SUM(oi.promotion_discount) AS discountGiven');
    expect(page.sql).toContain('SUM(oi.line_total) AS promotedNetSales');
    expect(page.sql).toContain('ORDER BY x.discountGiven DESC, x.name ASC LIMIT ? OFFSET ?');
    expect(page.values).toEqual([START, END, 25, 0]);
    // Baseline query: the listed promotions only; open-ended windows close at the range end.
    const baseline = rawCall(t, 2);
    expect(baseline.sql).toContain('SUM(oi2.quantity) AS baselineUnits');
    expect(baseline.values).toEqual([START, END, m1, m2, m3, END]);
  });

  it('FR-PRM-007 / FR-RPT-008 promotions: binds promotionId and scope filters, skips the baseline when nothing matched', async () => {
    const t = app();
    const promotionId = randomUUID();
    const res = await get(
      t,
      'promotions',
      `${RANGE}&promotionId=${promotionId}&scope=BRAND&basis=current`,
    );
    expect(res.status).toBe(200);
    expect(res.body.data.rows).toEqual([]);
    expect(t.m.$queryRaw).toHaveBeenCalledTimes(2); // page + totals only
    const page = rawCall(t, 0);
    expect(page.sql).toContain("AND o.status <> 'CANCELLED'");
    expect(page.sql).toContain('WHERE p.id = ? AND p.scope = ?) x');
    expect(page.values).toEqual([START, END, promotionId, 'BRAND', 25, 0]);
  });
});

describe('FR-RPT-010 payment and refund reports (non-empty data)', () => {
  const PAYMENTS = [...VIEW, 'payments.view'];
  const REFUNDS = [...VIEW, 'refunds.view'];

  const paymentRows = () => [
    {
      paymentId: 'a0000000-0000-4000-8000-000000000001',
      orderNumber: 'ORD-261102-0001',
      provider: 'mock',
      providerPaymentId: 'pay_ABCDEFGH123456',
      method: 'ONLINE',
      amount: d('4320.00'),
      status: 'CAPTURED',
      createdAt: new Date('2026-11-02T05:00:00.000Z'),
      capturedAt: new Date('2026-11-02T05:01:00.000Z'),
      refundedAmount: d('0'),
      failureCode: null,
      failureReason: null,
    },
    {
      paymentId: 'a0000000-0000-4000-8000-000000000002',
      orderNumber: 'ORD-261102-0002',
      provider: 'mock',
      providerPaymentId: 'pay_ZZ9',
      method: 'ONLINE',
      amount: d('2000.00'),
      status: 'FAILED',
      createdAt: new Date('2026-11-02T04:00:00.000Z'),
      capturedAt: null,
      refundedAmount: d('0'),
      failureCode: 'BAD_REQUEST_ERROR',
      failureReason: 'card\ndeclined',
    },
    {
      paymentId: 'a0000000-0000-4000-8000-000000000003',
      orderNumber: 'ORD-261101-0009',
      provider: 'cod',
      providerPaymentId: null,
      method: 'COD',
      amount: d('999.5'),
      status: 'PENDING',
      createdAt: new Date('2026-11-01T09:30:00.000Z'),
      capturedAt: null,
      refundedAmount: d('0'),
      failureCode: null,
      failureReason: null,
    },
  ];

  /**
   * Full filtered set: 8 payments (the page shows 3) —
   *   CAPTURED 5 × 4320.00 = 21600.00, FAILED 2 × 2000.00 = 4000.00, PENDING 1 × 999.50
   *   total amount 21600.00 + 4000.00 + 999.50 = 26599.50
   */
  function mockPayments(t: T) {
    mockPaged(t, paymentRows(), 8, { amount: d('26599.50'), refundedAmount: d('0') });
    t.m.$queryRaw.mockResolvedValueOnce([
      { status: 'CAPTURED', count: 5n, amount: d('21600.00') },
      { status: 'FAILED', count: 2n, amount: d('4000.00') },
      { status: 'PENDING', count: 1n, amount: d('999.5') },
    ]);
  }

  it('FR-RPT-010 payments: masks provider ids, sanitises failures, totals over the full set and status summary', async () => {
    const t = app();
    mockPayments(t);
    const res = await get(t, 'payments', `${RANGE}&limit=3`, PAYMENTS);
    expect(res.status).toBe(200);
    const { data, meta } = res.body;
    expect(data.rows).toEqual([
      {
        paymentId: 'a0000000-0000-4000-8000-000000000001',
        orderNumber: 'ORD-261102-0001',
        provider: 'mock',
        providerPaymentId: '********123456', // last 6 characters only
        method: 'ONLINE',
        amount: '4320.00',
        status: 'CAPTURED',
        createdAt: '2026-11-02T05:00:00.000Z',
        capturedAt: '2026-11-02T05:01:00.000Z',
        refundedAmount: '0.00',
        failureReason: null,
      },
      {
        paymentId: 'a0000000-0000-4000-8000-000000000002',
        orderNumber: 'ORD-261102-0002',
        provider: 'mock',
        providerPaymentId: '*ay_ZZ9',
        method: 'ONLINE',
        amount: '2000.00',
        status: 'FAILED',
        createdAt: '2026-11-02T04:00:00.000Z',
        capturedAt: null,
        refundedAmount: '0.00',
        failureReason: 'BAD_REQUEST_ERROR: card declined', // control character removed
      },
      {
        paymentId: 'a0000000-0000-4000-8000-000000000003',
        orderNumber: 'ORD-261101-0009',
        provider: 'cod',
        providerPaymentId: null,
        method: 'COD',
        amount: '999.50',
        status: 'PENDING',
        createdAt: '2026-11-01T09:30:00.000Z',
        capturedAt: null,
        refundedAmount: '0.00',
        failureReason: null,
      },
    ]);
    // Totals come from the full filtered set (8 payments), not the 3-row page.
    expect(data.totals).toMatchObject({ amount: '26599.50', refundedAmount: '0.00' });
    // Success rate = captured / (captured + failed) × 100 = 5 / 7 = 71.428… → 71.43
    // (PENDING payments are in neither term).
    expect(data.summary).toEqual({
      byStatus: [
        { status: 'CAPTURED', count: 5, amount: '21600.00' },
        { status: 'FAILED', count: 2, amount: '4000.00' },
        { status: 'PENDING', count: 1, amount: '999.50' },
      ],
      successRate: '71.43',
    });
    expect(meta).toEqual({
      page: 1,
      limit: 3,
      totalItems: 8,
      totalPages: 3,
      hasNextPage: true,
      hasPrevPage: false,
    });

    expect(t.m.$queryRaw).toHaveBeenCalledTimes(3);
    const page = rawCall(t, 0);
    expect(page.sql).toContain(
      'FROM payments pm JOIN orders o ON o.id = pm.order_id WHERE pm.created_at >= ? AND pm.created_at < ?) x',
    );
    expect(page.sql).toContain('ORDER BY x.createdAt DESC, x.paymentId ASC LIMIT ? OFFSET ?');
    expect(page.values).toEqual([START, END, 3, 0]);
    const byStatus = rawCall(t, 2);
    expect(byStatus.sql).toContain('GROUP BY pm.status');
    expect(byStatus.values).toEqual([START, END]);
  });

  it('FR-RPT-010 payments: payments.update sees full provider ids; date field, status, method and provider filters are bound', async () => {
    const t = app();
    mockPayments(t);
    const res = await get(
      t,
      'payments',
      `${RANGE}&dateField=captured&status=captured,failed&method=online&provider=mock`,
      [...PAYMENTS, 'payments.update'],
    );
    expect(res.status).toBe(200);
    expect(
      (res.body.data.rows as { providerPaymentId: string | null }[]).map(
        (r) => r.providerPaymentId,
      ),
    ).toEqual(['pay_ABCDEFGH123456', 'pay_ZZ9', null]);
    const where =
      'WHERE pm.captured_at >= ? AND pm.captured_at < ? AND pm.status IN (?,?) AND pm.payment_method IN (?) AND pm.provider = ?';
    const page = rawCall(t, 0);
    expect(page.sql).toContain(where);
    expect(page.values).toEqual([START, END, 'CAPTURED', 'FAILED', 'ONLINE', 'mock', 25, 0]);
    // The status summary uses exactly the same filter.
    const byStatus = rawCall(t, 2);
    expect(byStatus.sql).toContain(`${where} GROUP BY pm.status`);
    expect(byStatus.values).toEqual([START, END, 'CAPTURED', 'FAILED', 'ONLINE', 'mock']);
  });

  /** DB order: requested (created) DESC. NOW = 2026-11-19T06:30Z. */
  const refundRows = () => [
    {
      refundId: 'b0000000-0000-4000-8000-000000000003',
      refundNumber: 'RFD-2627-000006',
      orderNumber: 'ORD-261118-0004',
      amount: d('150.25'),
      method: 'STORE_CREDIT',
      status: 'REQUESTED',
      reason: 'SIZE_ISSUE',
      requestedAt: new Date('2026-11-19T05:00:00.000Z'), // NOW − 1 h 30 min
      approvedBy: null,
      approvedAt: null,
      completedAt: null,
      creditNoteNumber: null,
      taxReversed: d('4.38'),
    },
    {
      refundId: 'b0000000-0000-4000-8000-000000000002',
      refundNumber: 'RFD-2627-000005',
      orderNumber: 'ORD-261103-0002',
      amount: d('2000.00'),
      method: 'BANK_TRANSFER',
      status: 'APPROVED',
      reason: 'CANCELLED',
      requestedAt: new Date('2026-11-18T06:30:00.000Z'), // NOW − 24 h
      approvedBy: 'Asha Rao',
      approvedAt: new Date('2026-11-18T09:30:00.000Z'),
      completedAt: null,
      creditNoteNumber: null,
      taxReversed: d('58.25'),
    },
    {
      refundId: 'b0000000-0000-4000-8000-000000000001',
      refundNumber: 'RFD-2627-000004',
      orderNumber: 'ORD-261031-0007',
      amount: d('675.00'),
      method: 'ORIGINAL_PAYMENT_METHOD',
      status: 'COMPLETED',
      reason: 'DAMAGED',
      requestedAt: new Date('2026-11-03T04:00:00.000Z'),
      approvedBy: 'Asha Rao',
      approvedAt: new Date('2026-11-03T10:00:00.000Z'),
      completedAt: new Date('2026-11-04T04:00:00.000Z'),
      creditNoteNumber: 'CN/2627/000001',
      taxReversed: d('19.66'),
    },
    {
      refundId: 'b0000000-0000-4000-8000-000000000000',
      refundNumber: 'RFD-2627-000003',
      orderNumber: 'ORD-261030-0001',
      amount: d('1200.00'),
      method: 'ORIGINAL_PAYMENT_METHOD',
      status: 'COMPLETED',
      reason: 'DAMAGED',
      requestedAt: new Date('2026-11-01T00:00:00.000Z'),
      approvedBy: 'Vikram Shah',
      approvedAt: new Date('2026-11-01T12:00:00.000Z'),
      completedAt: new Date('2026-11-05T04:00:00.000Z'),
      creditNoteNumber: 'CN/2627/000002',
      taxReversed: d('34.95'),
    },
  ];

  /**
   * Aggregates of the four refunds above:
   *   amount 150.25 + 2000.00 + 675.00 + 1200.00 = 4025.25; tax 4.38 + 58.25 + 19.66 + 34.95 = 117.24
   *   approval times 3 h, 6 h, 12 h → mean 7 h; completion times 24 h, 100 h → mean 62 h
   *   SLA 72 h: 1 of the 2 completed refunds is inside → 50 %.
   */
  function mockRefunds(t: T) {
    mockPaged(t, refundRows(), 4, { amount: d('4025.25'), taxReversed: d('117.24') });
    t.m.$queryRaw
      .mockResolvedValueOnce([
        { status: 'COMPLETED', count: 2n, amount: d('1875.00') },
        { status: 'APPROVED', count: 1n, amount: d('2000.00') },
        { status: 'REQUESTED', count: 1n, amount: d('150.25') },
      ])
      .mockResolvedValueOnce([
        {
          meanApprovalHours: d('7.0000'),
          meanCompletionHours: d('62.0000'),
          completed: d('2'),
          withinSla: d('1'),
        },
      ]);
  }

  it('FR-RPT-010 refunds: open-refund age, totals, status summary and SLA % from the configured SLA', async () => {
    const t = app();
    t.m.setting.findUnique.mockResolvedValue({ value: 72 });
    mockRefunds(t);
    const res = await get(t, 'refunds', RANGE, REFUNDS);
    expect(res.status).toBe(200);
    const { data, meta } = res.body;
    // Age only for open refunds (REQUESTED / APPROVED / PROCESSING), measured to "now".
    expect(data.rows).toEqual([
      {
        refundNumber: 'RFD-2627-000006',
        orderNumber: 'ORD-261118-0004',
        amount: '150.25',
        method: 'STORE_CREDIT',
        status: 'REQUESTED',
        reason: 'SIZE_ISSUE',
        requestedAt: '2026-11-19T05:00:00.000Z',
        approvedBy: null,
        approvedAt: null,
        completedAt: null,
        ageHours: '1.50',
        creditNoteNumber: null,
        taxReversed: '4.38',
      },
      {
        refundNumber: 'RFD-2627-000005',
        orderNumber: 'ORD-261103-0002',
        amount: '2000.00',
        method: 'BANK_TRANSFER',
        status: 'APPROVED',
        reason: 'CANCELLED',
        requestedAt: '2026-11-18T06:30:00.000Z',
        approvedBy: 'Asha Rao',
        approvedAt: '2026-11-18T09:30:00.000Z',
        completedAt: null,
        ageHours: '24.00',
        creditNoteNumber: null,
        taxReversed: '58.25',
      },
      {
        refundNumber: 'RFD-2627-000004',
        orderNumber: 'ORD-261031-0007',
        amount: '675.00',
        method: 'ORIGINAL_PAYMENT_METHOD',
        status: 'COMPLETED',
        reason: 'DAMAGED',
        requestedAt: '2026-11-03T04:00:00.000Z',
        approvedBy: 'Asha Rao',
        approvedAt: '2026-11-03T10:00:00.000Z',
        completedAt: '2026-11-04T04:00:00.000Z',
        ageHours: null,
        creditNoteNumber: 'CN/2627/000001',
        taxReversed: '19.66',
      },
      {
        refundNumber: 'RFD-2627-000003',
        orderNumber: 'ORD-261030-0001',
        amount: '1200.00',
        method: 'ORIGINAL_PAYMENT_METHOD',
        status: 'COMPLETED',
        reason: 'DAMAGED',
        requestedAt: '2026-11-01T00:00:00.000Z',
        approvedBy: 'Vikram Shah',
        approvedAt: '2026-11-01T12:00:00.000Z',
        completedAt: '2026-11-05T04:00:00.000Z',
        ageHours: null,
        creditNoteNumber: 'CN/2627/000002',
        taxReversed: '34.95',
      },
    ]);
    expect(data.totals).toMatchObject({ amount: '4025.25', taxReversed: '117.24' });
    expect(data.summary).toEqual({
      byStatus: [
        { status: 'COMPLETED', count: 2, amount: '1875.00' },
        { status: 'APPROVED', count: 1, amount: '2000.00' },
        { status: 'REQUESTED', count: 1, amount: '150.25' },
      ],
      meanApprovalHours: '7.00',
      meanCompletionHours: '62.00',
      slaHours: 72,
      completedWithinSlaPercent: '50.00', // 1 of 2 completed
    });
    expect(meta).toMatchObject({ page: 1, limit: 25, totalItems: 4, totalPages: 1 });

    expect(t.m.setting.findUnique).toHaveBeenCalledWith({
      where: { settingKey: 'refunds.sla_hours' },
      select: { value: true },
    });
    expect(t.m.$queryRaw).toHaveBeenCalledTimes(4);
    const page = rawCall(t, 0);
    expect(page.sql).toContain(
      'FROM refunds r JOIN orders o ON o.id = r.order_id WHERE r.created_at >= ? AND r.created_at < ?) x',
    );
    expect(page.sql).toContain('ORDER BY x.requestedAt DESC, x.refundNumber DESC LIMIT ? OFFSET ?');
    expect(page.values).toEqual([START, END, 25, 0]);
    expect(rawCall(t, 2).sql).toContain('GROUP BY r.status');
    // SLA threshold is bound in seconds: 72 h × 3600 = 259 200 s.
    const timing = rawCall(t, 3);
    expect(timing.sql).toContain('AS withinSla');
    expect(timing.values).toEqual([259_200, START, END]);
  });

  it('FR-RPT-010 refunds: default SLA is 168 h; completed-date, status, method and reason filters are bound', async () => {
    const t = app();
    // No `refunds.sla_hours` setting row → default 168 h (7 days) = 604 800 s.
    t.m.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ totalItems: 0n, amount: null, taxReversed: null }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { meanApprovalHours: null, meanCompletionHours: null, completed: null, withinSla: null },
      ]);
    const res = await get(
      t,
      'refunds',
      `${RANGE}&dateField=completed&status=completed&method=bank_transfer&reason=damaged`,
      REFUNDS,
    );
    expect(res.status).toBe(200);
    // Nothing completed → no percentage (never a division by zero) and no means.
    expect(res.body.data.summary).toEqual({
      byStatus: [],
      meanApprovalHours: null,
      meanCompletionHours: null,
      slaHours: 168,
      completedWithinSlaPercent: null,
    });
    const where =
      'WHERE r.completed_at >= ? AND r.completed_at < ? AND r.status IN (?) AND r.method IN (?) AND r.reason_code = ?';
    const page = rawCall(t, 0);
    expect(page.sql).toContain(where);
    expect(page.values).toEqual([START, END, 'COMPLETED', 'BANK_TRANSFER', 'DAMAGED', 25, 0]);
    const timing = rawCall(t, 3);
    expect(timing.sql).toContain(where);
    expect(timing.values).toEqual([604_800, START, END, 'COMPLETED', 'BANK_TRANSFER', 'DAMAGED']);
  });
});

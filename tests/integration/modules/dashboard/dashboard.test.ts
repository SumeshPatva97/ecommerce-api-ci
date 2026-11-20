/**
 * Dashboard summary — MOCKED DB (Prisma stand-in, no MySQL). Verifies permission-based widget
 * filtering (unauthorised widgets are omitted, not zeroed), comparisons and caching.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createDashboardModule } from '../../../../src/modules/dashboard/index.js';
import { WIDGETS } from '../../../../src/modules/dashboard/dashboard.service.js';
import { buildModuleTestApp } from '../../../helpers/container.js';
import { expectAdminRoutesGuarded } from '../../../helpers/routeTable.js';

const NOW = new Date('2026-11-19T06:30:00.000Z');
const URL = '/api/v1/admin/dashboard/summary';

function app() {
  const t = buildModuleTestApp([createDashboardModule], { now: NOW });
  t.m.auditLog.create.mockResolvedValue({});
  t.m.order.aggregate.mockResolvedValue({
    _count: { _all: 4 },
    _sum: {
      subtotal: '10000.00',
      itemDiscountTotal: '500.00',
      couponDiscountTotal: '500.00',
      grandTotal: '9300.00',
    },
  });
  t.m.order.count.mockResolvedValue(3);
  t.m.order.groupBy.mockResolvedValue([
    { status: 'CONFIRMED', _count: { _all: 18 } },
    { status: 'SHIPPED', _count: { _all: 21 } },
  ]);
  t.m.refund.count.mockResolvedValue(2);
  t.m.review.count.mockResolvedValue(7);
  t.m.notification.count.mockResolvedValue(1);
  t.m.payment.groupBy.mockResolvedValue([
    { status: 'CAPTURED', _count: { _all: 9 } },
    { status: 'FAILED', _count: { _all: 1 } },
  ]);
  return t;
}

describe('GET /admin/dashboard/summary', () => {
  it('is guarded by dashboard.view', async () => {
    const t = app();
    const routes = expectAdminRoutesGuarded(createDashboardModule(t.container));
    expect(routes.map((r) => `${r.method} ${r.path} ${r.permissions.join('+')}`)).toEqual([
      'GET /dashboard/summary dashboard.view',
    ]);
    const res = await request(t.app)
      .get(URL)
      .set(t.staff({ permissions: ['reports.view'] }).headers);
    expect(res.status).toBe(403);
  });

  it('returns only operational widgets for an EMPLOYEE-like role (no reports.view)', async () => {
    const t = app();
    const res = await request(t.app)
      .get(URL)
      .set(t.staff({ permissions: ['dashboard.view', 'orders.view'] }).headers);
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.widgets).toEqual([
      'orders',
      'ordersByStatus',
      'ordersAwaitingAction',
      'cancellationRequestsPending',
    ]);
    expect(data).not.toHaveProperty('sales');
    expect(data).not.toHaveProperty('salesTrend');
    expect(data).not.toHaveProperty('pendingRefunds');
    expect(data).not.toHaveProperty('stock');
    expect(data.ordersByStatus).toEqual({ CONFIRMED: 18, SHIPPED: 21 });
    expect(data.orders).toMatchObject({ count: 3, previous: { from: '2026-11-18', count: 3 } });
    expect(data.range).toEqual({ from: '2026-11-19', to: '2026-11-19', timezone: 'Asia/Kolkata' });
    expect(t.m.order.aggregate).not.toHaveBeenCalled();
    expect(t.m.$queryRaw).not.toHaveBeenCalled();
  });

  it('returns every widget for a Superadmin, with money as 2-dp strings', async () => {
    const t = app();
    t.m.$queryRaw.mockImplementation((sql: { sql: string }) =>
      Promise.resolve(
        sql.sql.includes('lowStock')
          ? [{ lowStock: 14n, outOfStock: 3n }]
          : sql.sql.includes('unitsSold')
            ? [
                {
                  productId: 'p1',
                  name: 'Meera Kundan Jhumka',
                  unitsSold: '23',
                  revenue: '33155.00',
                },
              ]
            : [],
      ),
    );
    const res = await request(t.app)
      .get(URL)
      .set(t.staff({ isSuperadmin: true }).headers);
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.widgets).toEqual(WIDGETS.map((w) => w.key));
    expect(data.sales).toMatchObject({
      grossSales: '10000.00',
      netSales: '9000.00',
      orders: 4,
      averageOrderValue: '2325.00',
      previous: { from: '2026-11-12', to: '2026-11-12' },
      changePercent: '0.00',
    });
    expect(data.stock).toEqual({ lowStockCount: 14, outOfStockCount: 3 });
    expect(data.paymentSuccessRate).toMatchObject({ captured: 9, failed: 1, ratePercent: '90.00' });
    expect(data.salesTrend).toHaveLength(30);
    expect(data.topProducts[0]).toEqual({
      productId: 'p1',
      name: 'Meera Kundan Jhumka',
      unitsSold: 23,
      revenue: '33155.00',
    });
    expect(data.pendingRefunds).toBe(2);
    expect(data.pendingReviews).toBe(7);
    expect(data.failedNotifications).toBe(1);
  });

  it('caches per permission set for 60 s and validates the range', async () => {
    const t = app();
    const h = t.staff({ permissions: ['dashboard.view', 'refunds.view'] }).headers;
    await request(t.app).get(URL).set(h);
    await request(t.app).get(URL).set(h);
    expect(t.m.refund.count).toHaveBeenCalledTimes(1);
    t.now.value = new Date(NOW.getTime() + 61_000);
    await request(t.app).get(URL).set(h);
    expect(t.m.refund.count).toHaveBeenCalledTimes(2);

    const reversed = await request(t.app).get(`${URL}?from=2026-11-10&to=2026-11-01`).set(h);
    expect(reversed.status).toBe(422);
    const bad = await request(t.app).get(`${URL}?from=yesterday`).set(h);
    expect(bad.status).toBe(422);
  });
});

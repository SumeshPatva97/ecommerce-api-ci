/**
 * Reports & report exports — MOCKED DB (Prisma stand-in, no MySQL). Raw SQL aggregates are mocked
 * via `t.m.$queryRaw` (resolved in call order); these tests verify access control, validation,
 * calculation glue and HTTP contracts — not SQL against a real database.
 */
import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createReportsModule } from '../../../../src/modules/reports/index.js';
import { REPORT_KEYS } from '../../../../src/modules/reports/reports.types.js';
import { buildModuleTestApp } from '../../../helpers/container.js';
import { expectAdminRoutesGuarded } from '../../../helpers/routeTable.js';

const NOW = new Date('2026-11-19T06:30:00.000Z');
const VIEW = ['reports.view'];
const EXPORT = ['reports.view', 'reports.export'];
const BASE = '/api/v1/admin/reports';

function app() {
  const t = buildModuleTestApp([createReportsModule], { now: NOW });
  t.m.auditLog.create.mockResolvedValue({});
  return t;
}

type T = ReturnType<typeof app>;

function auditActions(t: T): { action: string; eventKey: string | undefined; entityId: unknown }[] {
  return t.m.auditLog.create.mock.calls.map((c) => {
    const data = c[0].data as {
      action: string;
      entityId: unknown;
      newValues?: { _event?: { eventKey?: string } };
    };
    return {
      action: data.action,
      eventKey: data.newValues?._event?.eventKey,
      entityId: data.entityId,
    };
  });
}

function orderRow(over: Record<string, unknown> = {}) {
  return {
    orderId: randomUUID(),
    orderNumber: 'ORD-261101-0001',
    placedAt: new Date('2026-11-01T05:00:00.000Z'),
    confirmedAt: new Date('2026-11-01T05:01:00.000Z'),
    status: 'CONFIRMED',
    paymentMethod: 'ONLINE',
    paymentStatus: 'CAPTURED',
    customerName: 'Ravi Kulkarni',
    customerEmail: 'ravi@example.com',
    itemCount: 2,
    units: 3,
    subtotal: '4560.00',
    discounts: '340.00',
    shipping: '100.00',
    tax: '410.50',
    grandTotal: '4320.00',
    refundedTotal: '0.00',
    invoiceNumber: null,
    couponCode: null,
    shippingState: '27',
    ...over,
  };
}

/** pagedQuery = [page rows, COUNT/SUM aggregate]. */
function mockPaged(
  t: T,
  rows: unknown[],
  totalItems = rows.length,
  sums: Record<string, unknown> = {},
) {
  t.m.$queryRaw.mockResolvedValueOnce(rows).mockResolvedValueOnce([{ totalItems, ...sums }]);
}

describe('reports module — routes & access', () => {
  it('declares guarded admin routes (no critical permission on the route)', () => {
    const t = app();
    const routes = expectAdminRoutesGuarded(createReportsModule(t.container));
    expect(routes.map((r) => `${r.method} ${r.path} ${r.permissions.join('+')}`)).toEqual([
      'GET /reports/:reportKey reports.view',
      'POST /reports/:reportKey/export reports.export',
      'GET /report-exports/:exportId reports.export',
    ]);
  });

  it('404s unknown report keys and 403s without reports.view', async () => {
    const t = app();
    const res = await request(t.app)
      .get(`${BASE}/unknown-report?from=2026-11-01&to=2026-11-02`)
      .set(t.staff({ permissions: VIEW }).headers);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    const denied = await request(t.app)
      .get(`${BASE}/sales?from=2026-11-01&to=2026-11-02`)
      .set(t.staff({ permissions: ['dashboard.view'] }).headers);
    expect(denied.status).toBe(403);
  });

  it.each([
    ['gst-summary', 'tax.view'],
    ['gst-b2b', 'tax.view'],
    ['payments', 'payments.view'],
    ['refunds', 'refunds.view'],
    ['inventory-valuation', 'inventory.view'],
    ['low-stock', 'inventory.view'],
    ['customers-new-returning', 'customers.view'],
    ['top-customers', 'customers.view'],
  ])('%s requires the domain permission %s (audited, no query run)', async (key, perm) => {
    const t = app();
    const res = await request(t.app)
      .get(`${BASE}/${key}?from=2026-11-01&to=2026-11-02`)
      .set(t.staff({ permissions: VIEW }).headers);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PERMISSION_DENIED');
    expect(res.body.error.details[0].meta.required).toEqual([perm]);
    expect(t.m.$queryRaw).not.toHaveBeenCalled();
    expect(auditActions(t)).toContainEqual(
      expect.objectContaining({ action: 'PERMISSION_DENIED' }),
    );
    const ok = await request(t.app)
      .get(`${BASE}/${key}?from=2026-11-01&to=2026-11-02`)
      .set(t.staff({ permissions: [...VIEW, perm] }).headers);
    expect(ok.status).toBe(200);
  });

  it('validates date ranges with field details (422)', async () => {
    const t = app();
    const h = t.staff({ permissions: VIEW }).headers;
    const missing = await request(t.app).get(`${BASE}/sales?to=2026-11-02`).set(h);
    expect(missing.status).toBe(422);
    expect(missing.body.error.details[0].field).toBe('from');
    const reversed = await request(t.app)
      .get(`${BASE}/orders?from=2026-11-05&to=2026-11-01`)
      .set(h);
    expect(reversed.status).toBe(422);
    expect(reversed.body.error.details[0].field).toBe('to');
    const tooLong = await request(t.app).get(`${BASE}/orders?from=2025-01-01&to=2026-11-01`).set(h);
    expect(tooLong.status).toBe(422);
    const badDate = await request(t.app).get(`${BASE}/sales?from=2026-13-01&to=2026-11-01`).set(h);
    expect(badDate.status).toBe(422);
    const badStatus = await request(t.app)
      .get(`${BASE}/orders?from=2026-11-01&to=2026-11-02&status=SHIPPED,BOGUS`)
      .set(h);
    expect(badStatus.status).toBe(422);
    expect(badStatus.body.error.details[0].field).toBe('status');
    expect(t.m.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('runs every one of the 20 report keys (empty data) for a Superadmin', async () => {
    const t = app();
    const h = t.staff({ isSuperadmin: true }).headers;
    for (const key of REPORT_KEYS) {
      const res = await request(t.app).get(`${BASE}/${key}?from=2026-11-01&to=2026-11-07`).set(h);
      expect(res.status, key).toBe(200);
      expect(res.body.data.reportKey).toBe(key);
      expect(res.body.data.reportVersion).toBe('1.0');
      expect(Array.isArray(res.body.data.columns)).toBe(true);
      expect(res.headers['cache-control']).toBe('no-store');
    }
    expect(t.m.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(t.m.$executeRaw).not.toHaveBeenCalled();
  });
});

describe('report calculations (mocked aggregates)', () => {
  it('sales: buckets by IST day, zero-fills, derives net revenue and returns 2-dp strings', async () => {
    const t = app();
    t.m.$queryRaw
      .mockResolvedValueOnce([
        {
          day: '2026-11-02',
          orders: 1n,
          units: '3',
          grossSales: '4560.00',
          itemDiscounts: '140.00',
          couponDiscounts: '200.00',
          shipping: '100.00',
          taxableValue: '3909.50',
          cgst: '205.25',
          sgst: '205.25',
          utgst: '0',
          igst: '0',
          tax: '410.50',
          roundOff: '0',
          orderValue: '4320.00',
        },
        { day: '2026-11-03', orders: 1n, units: '1', grossSales: '2000.00', orderValue: '2000.00' },
      ])
      .mockResolvedValueOnce([
        { day: '2026-11-04', refunds: '675.00', refundTaxable: '600.00' },
        { day: '2026-11-06', refunds: '2000.00', refundTaxable: '1900.00' },
      ])
      .mockResolvedValueOnce([]);
    const res = await request(t.app)
      .get(`${BASE}/sales?from=2026-11-01&to=2026-11-07&groupBy=day`)
      .set(t.staff({ permissions: VIEW }).headers);
    expect(res.status).toBe(200);
    const { data, meta } = res.body;
    expect(data.filters).toMatchObject({
      from: '2026-11-01',
      to: '2026-11-07',
      timezone: 'Asia/Kolkata',
    });
    expect(data.rows).toHaveLength(7);
    expect(data.rows[0]).toMatchObject({ bucket: '2026-11-01', orders: 0, netRevenue: '0.00' });
    expect(data.rows[1]).toMatchObject({
      bucket: '2026-11-02',
      netSales: '4220.00',
      aov: '4320.00',
    });
    expect(data.rows[5]).toMatchObject({
      bucket: '2026-11-06',
      refunds: '2000.00',
      netRevenue: '-2000.00',
    });
    expect(data.totals).toMatchObject({
      orders: 2,
      grossSales: '6560.00',
      orderValue: '6320.00',
      refunds: '2675.00',
      netRevenue: '3645.00',
      aov: '3160.00',
    });
    expect(meta).toMatchObject({ rowCount: 7 });
    // Bound IST range: [2026-10-31T18:30Z, 2026-11-07T18:30Z).
    const sql = t.m.$queryRaw.mock.calls[0]?.[0] as { values: unknown[]; sql: string };
    expect(sql.values).toContainEqual(new Date('2026-10-31T18:30:00.000Z'));
    expect(sql.values).toContainEqual(new Date('2026-11-07T18:30:00.000Z'));
    expect(sql.sql).toContain("CONVERT_TZ(o.confirmed_at, '+00:00', '+05:30')");
    expect(sql.sql).toContain("NOT IN ('PENDING_PAYMENT', 'PAYMENT_FAILED')");
  });

  it('orders: masks customer PII without customers.view, paginates, totals over the full set', async () => {
    const t = app();
    mockPaged(t, [orderRow()], 41, { grandTotal: '99999.00', units: '120' });
    const masked = await request(t.app)
      .get(`${BASE}/orders?from=2026-11-01&to=2026-11-07&page=2&limit=20`)
      .set(t.staff({ permissions: VIEW }).headers);
    expect(masked.status).toBe(200);
    expect(masked.body.data.rows[0]).toMatchObject({
      customerName: 'R*** K***',
      customerEmail: 'r***@example.com',
      grandTotal: '4320.00',
      placedAt: '2026-11-01T05:00:00.000Z',
    });
    expect(masked.body.data.totals).toMatchObject({ grandTotal: '99999.00', units: 120 });
    expect(masked.body.meta).toMatchObject({ page: 2, limit: 20, totalItems: 41, totalPages: 3 });
    const page = t.m.$queryRaw.mock.calls[0]?.[0] as { values: unknown[] };
    expect(page.values.slice(-2)).toEqual([20, 20]); // LIMIT 20 OFFSET 20

    mockPaged(t, [orderRow()]);
    const clear = await request(t.app)
      .get(`${BASE}/orders?from=2026-11-01&to=2026-11-07`)
      .set(t.staff({ permissions: [...VIEW, 'customers.view'] }).headers);
    expect(clear.body.data.rows[0].customerEmail).toBe('ravi@example.com');
  });

  it('gst-b2b returns an empty result with a notice while B2B is disabled (OQ-24)', async () => {
    const t = app();
    const res = await request(t.app)
      .get(`${BASE}/gst-b2b?period=2026-10`)
      .set(t.staff({ permissions: [...VIEW, 'tax.view'] }).headers);
    expect(res.status).toBe(200);
    expect(res.body.data.rows).toEqual([]);
    expect(res.body.data.notices).toContain('B2B disabled (OQ-24).');
    expect(res.body.data.filters).toMatchObject({ from: '2026-10-01', to: '2026-10-31' });
    expect(t.m.$queryRaw).not.toHaveBeenCalled();
  });

  it('gst-summary builds invoice / credit-note / net sections and flags reconciliation mismatches', async () => {
    const t = app();
    t.m.$queryRaw
      .mockResolvedValueOnce([
        {
          documentType: 'TAX_INVOICE',
          supplyType: 'INTRA_STATE',
          documents: 2n,
          taxableValue: '1000.00',
          cgst: '15.00',
          sgst: '15.00',
          utgst: '0',
          igst: '0',
          totalTax: '30.00',
        },
        {
          documentType: 'CREDIT_NOTE',
          supplyType: 'INTRA_STATE',
          documents: 1n,
          taxableValue: '-100.00',
          cgst: '-1.50',
          sgst: '-1.50',
          utgst: '0',
          igst: '0',
          totalTax: '-3.00',
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          documentType: 'TAX_INVOICE',
          firstNumber: 'INV/2627/000001',
          lastNumber: 'INV/2627/000002',
          count: 2n,
        },
      ])
      .mockResolvedValueOnce([{ taxableValue: '900.00', totalTax: '20.00' }]);
    const res = await request(t.app)
      .get(`${BASE}/gst-summary?from=2026-11-01&to=2026-11-30`)
      .set(t.staff({ permissions: [...VIEW, 'tax.view'] }).headers);
    expect(res.status).toBe(200);
    const rows = res.body.data.rows as { section: string; supplyType: string }[];
    const net = rows.find((r) => r.section === 'NET' && r.supplyType === 'INTRA_STATE');
    expect(net).toMatchObject({ documents: 3, taxableValue: '900.00', totalTax: '27.00' });
    expect(res.body.data.totals).toMatchObject({ taxableValue: '900.00', totalTax: '27.00' });
    expect(res.body.data.reconciliation.matches).toBe(false);
    expect((res.body.data.notices as string[]).join(' ')).toContain('RECONCILIATION_MISMATCH');
    expect(res.body.data.documentSeries[0]).toMatchObject({ count: 2 });
  });
});

describe('report exports', () => {
  const body = (over: Record<string, unknown> = {}) => ({
    format: 'csv',
    filters: { from: '2026-11-01', to: '2026-11-07' },
    ...over,
  });

  it('streams a sync CSV with download headers, injection guard and an EXPORT audit (no re-auth)', async () => {
    const t = app();
    mockPaged(
      t,
      [orderRow({ customerName: '=HYPERLINK("http://evil")', couponCode: '+SAVE' })],
      1,
      {
        grandTotal: '4320.00',
      },
    );
    const res = await request(t.app)
      .post(`${BASE}/orders/export`)
      .set(t.staff({ permissions: [...EXPORT, 'customers.view'] }).headers)
      .send(body());
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="orders_2026-11-01_2026-11-07.csv"',
    );
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-row-count']).toBe('1');
    const csv = res.text;
    expect(csv).toContain('# Store — Order register');
    expect(csv).toContain('Placed at (IST)');
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(csv).toContain("'+SAVE");
    expect(csv).toContain('2026-11-01 10:30:00'); // placedAt in IST
    const audit = t.m.auditLog.create.mock.calls.at(-1)?.[0].data;
    expect(audit).toMatchObject({ action: 'EXPORT', module: 'reports', entityType: 'report' });
    expect(audit.newValues).toMatchObject({
      reportKey: 'orders',
      format: 'csv',
      rowCount: 1,
      _event: {
        eventKey: 'reports.export_requested',
        metadata: { containsPii: true, entityLabel: 'orders' },
      },
    });
  });

  it.each([
    ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['pdf', 'application/pdf'],
  ])('exports %s with the right content type', async (format, contentType) => {
    const t = app();
    mockPaged(t, [orderRow()]);
    const res = await request(t.app)
      .post(`${BASE}/orders/export`)
      .set(t.staff({ permissions: EXPORT }).headers)
      .send(body({ format }))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => {
          cb(null, Buffer.concat(chunks));
        });
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe(contentType);
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="orders_2026-11-01_2026-11-07.${format}"`,
    );
    const buf = res.body as Buffer;
    expect(buf.subarray(0, 2).toString('latin1')).toBe(format === 'pdf' ? '%P' : 'PK');
  });

  it('queues exports above the sync threshold (202 + report_exports QUEUED + audit)', async () => {
    const t = app();
    const id = randomUUID();
    t.m.reportExport.create.mockResolvedValue({ id });
    mockPaged(t, [orderRow()], 10_001);
    const viewer = t.staff({ permissions: EXPORT });
    const res = await request(t.app)
      .post(`${BASE}/orders/export`)
      .set(viewer.headers)
      .send(body({ format: 'xlsx', columns: ['orderNumber', 'grandTotal'] }));
    expect(res.status).toBe(202);
    expect(res.body.data).toEqual({
      exportId: id,
      status: 'QUEUED',
      reportKey: 'orders',
      format: 'xlsx',
      rowCount: 10_001,
      pollUrl: `/api/v1/admin/report-exports/${id}`,
    });
    const created = t.m.reportExport.create.mock.calls[0]?.[0].data;
    expect(created).toMatchObject({
      reportKey: 'orders',
      format: 'XLSX',
      status: 'QUEUED',
      requestedById: viewer.ctx.userId,
      filters: { columns: ['orderNumber', 'grandTotal'], filters: { from: '2026-11-01' } },
    });
    expect(auditActions(t).at(-1)).toMatchObject({ action: 'EXPORT', entityId: id });
    // Sync page query limited to the threshold.
    const page = t.m.$queryRaw.mock.calls[0]?.[0] as { values: unknown[] };
    expect(page.values.slice(-2)).toEqual([10_000, 0]);
  });

  it('applies the PDF limits (> 2 000 async, > 5 000 refused) and validates columns', async () => {
    const t = app();
    t.m.reportExport.create.mockResolvedValue({ id: randomUUID() });
    const h = t.staff({ permissions: EXPORT }).headers;
    mockPaged(t, [], 3000);
    const queued = await request(t.app)
      .post(`${BASE}/orders/export`)
      .set(h)
      .send(body({ format: 'pdf' }));
    expect(queued.status).toBe(202);
    mockPaged(t, [], 6000);
    const refused = await request(t.app)
      .post(`${BASE}/orders/export`)
      .set(h)
      .send(body({ format: 'pdf' }));
    expect(refused.status).toBe(422);
    expect(refused.body.error.details[0].code).toBe('EXPORT_TOO_LARGE');
    mockPaged(t, [orderRow()]);
    const badColumn = await request(t.app)
      .post(`${BASE}/orders/export`)
      .set(h)
      .send(body({ columns: ['orderNumber', 'secretColumn'] }));
    expect(badColumn.status).toBe(422);
    expect(badColumn.body.error.details[0].field).toBe('columns');
    const badFormat = await request(t.app)
      .post(`${BASE}/orders/export`)
      .set(h)
      .send(body({ format: 'doc' }));
    expect(badFormat.status).toBe(422);
  });

  it('requires reports.export + domain permission; customer-data exports also customers.export + re-auth', async () => {
    const t = app();
    const viewOnly = await request(t.app)
      .post(`${BASE}/sales/export`)
      .set(t.staff({ permissions: VIEW }).headers)
      .send(body());
    expect(viewOnly.status).toBe(403);
    const noTax = await request(t.app)
      .post(`${BASE}/gst-hsn/export`)
      .set(t.staff({ permissions: EXPORT }).headers)
      .send(body());
    expect(noTax.status).toBe(403);
    expect(noTax.body.error.details[0].meta.required).toEqual(['tax.view']);

    const customerPerms = [...EXPORT, 'customers.view'];
    const noCustomerExport = await request(t.app)
      .post(`${BASE}/top-customers/export`)
      .set(t.staff({ permissions: customerPerms }).headers)
      .send(body());
    expect(noCustomerExport.status).toBe(403);
    expect(noCustomerExport.body.error.details[0].meta.required).toEqual(['customers.export']);
    const noReauth = await request(t.app)
      .post(`${BASE}/top-customers/export`)
      .set(t.staff({ permissions: [...customerPerms, 'customers.export'] }).headers)
      .send(body());
    expect(noReauth.body.error.code).toBe('REAUTH_REQUIRED');
    t.m.$queryRaw.mockResolvedValueOnce([]);
    const okRes = await request(t.app)
      .post(`${BASE}/top-customers/export`)
      .set(
        t.staff({ permissions: [...customerPerms, 'customers.export'], reauthenticated: true })
          .headers,
      )
      .send(body());
    expect(okRes.status).toBe(200);
    const audit = t.m.auditLog.create.mock.calls.at(-1)?.[0].data;
    expect(audit.newValues._event.metadata.containsPii).toBe(true);
  });

  it('logs PRINT for purpose=print', async () => {
    const t = app();
    t.m.$queryRaw.mockResolvedValue([]);
    const res = await request(t.app)
      .post(`${BASE}/sales/export`)
      .set(t.staff({ permissions: EXPORT }).headers)
      .send(body({ format: 'pdf', purpose: 'print' }));
    expect(res.status).toBe(200);
    expect(auditActions(t).at(-1)?.action).toBe('PRINT');
  });
});

describe('GET /report-exports/:exportId', () => {
  function exportRow(requestedById: string, over: Record<string, unknown> = {}) {
    return {
      id: randomUUID(),
      reportKey: 'gst-hsn',
      format: 'XLSX',
      filters: {},
      status: 'READY',
      fileStorageKey: 'report-exports/x.xlsx',
      fileHash: null,
      rowCount: 48211,
      requestedById,
      expiresAt: new Date('2026-11-26T06:30:00.000Z'),
      createdAt: new Date('2026-11-19T06:00:00.000Z'),
      updatedAt: new Date('2026-11-19T06:10:00.000Z'),
      ...over,
    };
  }

  it('returns own exports, hides others (404) and lets a Superadmin read any', async () => {
    const t = app();
    const owner = t.staff({ permissions: [...EXPORT, 'tax.view'] });
    const row = exportRow(owner.ctx.userId);
    t.m.reportExport.findUnique.mockResolvedValue(row);
    const own = await request(t.app)
      .get(`/api/v1/admin/report-exports/${row.id}`)
      .set(owner.headers);
    expect(own.status).toBe(200);
    expect(own.body.data).toMatchObject({
      exportId: row.id,
      status: 'COMPLETED',
      format: 'xlsx',
      rowCount: 48211,
      downloadUrl: null,
    });
    expect(own.headers['cache-control']).toBe('no-store');

    const other = await request(t.app)
      .get(`/api/v1/admin/report-exports/${row.id}`)
      .set(t.staff({ permissions: [...EXPORT, 'tax.view'] }).headers);
    expect(other.status).toBe(404);

    const sa = await request(t.app)
      .get(`/api/v1/admin/report-exports/${row.id}`)
      .set(t.staff({ isSuperadmin: true }).headers);
    expect(sa.status).toBe(200);

    t.m.reportExport.findUnique.mockResolvedValue(null);
    const missing = await request(t.app)
      .get(`/api/v1/admin/report-exports/${randomUUID()}`)
      .set(owner.headers);
    expect(missing.status).toBe(404);
    const invalid = await request(t.app)
      .get('/api/v1/admin/report-exports/not-a-uuid')
      .set(owner.headers);
    expect(invalid.status).toBe(422);
  });

  it('re-checks the domain permission and reports expiry', async () => {
    const t = app();
    const owner = t.staff({ permissions: EXPORT });
    t.m.reportExport.findUnique.mockResolvedValue(exportRow(owner.ctx.userId));
    const revoked = await request(t.app)
      .get(`/api/v1/admin/report-exports/${randomUUID()}`)
      .set(owner.headers);
    expect(revoked.status).toBe(403);
    t.m.reportExport.findUnique.mockResolvedValue(
      exportRow(owner.ctx.userId, {
        reportKey: 'sales',
        expiresAt: new Date('2026-11-18T00:00:00Z'),
      }),
    );
    const expired = await request(t.app)
      .get(`/api/v1/admin/report-exports/${randomUUID()}`)
      .set(owner.headers);
    expect(expired.body.data.status).toBe('EXPIRED');
  });
});

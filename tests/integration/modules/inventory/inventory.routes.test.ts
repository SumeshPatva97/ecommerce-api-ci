/**
 * /admin/inventory/* through the real pipeline — MOCKED DB (no MySQL). Covers guards,
 * Idempotency-Key requirement, movement validation, INSUFFICIENT_STOCK, ledger + STOCK_ADJUST
 * audit rows, list/lookup/history and threshold updates.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { Decimal } from '../../../../src/lib/money.js';
import { PERMISSIONS } from '../../../../src/lib/permissions.js';
import { createInventoryModule } from '../../../../src/modules/inventory/index.js';
import { buildModuleTestApp } from '../../../helpers/container.js';
import { expectAdminRoutesGuarded } from '../../../helpers/routeTable.js';

const BASE = '/api/v1/admin/inventory';
const V1 = '00000000-0000-4000-8000-000000000001';
const V2 = '00000000-0000-4000-8000-000000000002';

function setup() {
  const t = buildModuleTestApp([createInventoryModule]);
  const viewer = t.staff({ permissions: ['inventory.view'] });
  const clerk = t.staff({
    permissions: ['inventory.view', 'inventory.create', 'inventory.update'],
  });
  t.m.idempotencyKey.create.mockResolvedValue({ id: 'idem-row' });
  t.m.inventoryTransaction.createMany.mockResolvedValue({ count: 2 });
  return { t, viewer, clerk };
}

let keySeq = 0;
const idemKey = (): string => `inv-key-${String(++keySeq).padStart(12, '0')}`;

const stockIn = {
  type: 'STOCK_IN',
  reasonCode: 'PURCHASE',
  reference: 'GRN-2611-014',
  note: 'Diwali restock',
  items: [
    { sku: 'ear-meera-gld-m', quantity: 20, unitCost: '510.00' },
    { variantId: V2, quantity: 15 },
  ],
};

describe('inventory routes — guards & idempotency', () => {
  it('declares permissions on every route', () => {
    const { t } = setup();
    const routes = expectAdminRoutesGuarded(createInventoryModule(t.container));
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'GET /inventory',
      'GET /inventory/:variantId/transactions',
      'GET /inventory/lookup',
      'PATCH /inventory/:variantId',
      'POST /inventory/movements',
    ]);
  });

  it('requires inventory.create and an Idempotency-Key for movements', async () => {
    const { t, viewer, clerk } = setup();
    const denied = await request(t.app)
      .post(`${BASE}/movements`)
      .set(viewer.headers)
      .set('Idempotency-Key', idemKey())
      .send(stockIn);
    expect(denied.status).toBe(403);
    const missing = await request(t.app).post(`${BASE}/movements`).set(clerk.headers).send(stockIn);
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('BAD_REQUEST');
    expect(t.m.productVariant.findMany).not.toHaveBeenCalled();
  });
});

describe('POST /admin/inventory/movements', () => {
  it('records a bulk STOCK_IN atomically with ledger rows and STOCK_ADJUST audits', async () => {
    const { t, clerk } = setup();
    t.m.productVariant.findMany.mockResolvedValue([
      { id: V1, sku: 'EAR-MEERA-GLD-M' },
      { id: V2, sku: 'RNG-TARA-SLV' },
    ]);
    t.m.$queryRaw.mockResolvedValue([
      { variantId: V1, onHand: 4, reserved: 2, lowStockThreshold: null, lowStockAlertedAt: null },
    ]);
    t.m.user.findUnique.mockResolvedValue({ firstName: 'Ravi', lastName: 'Kulkarni' });

    const res = await request(t.app)
      .post(`${BASE}/movements`)
      .set(clerk.headers)
      .set('Idempotency-Key', idemKey())
      .send(stockIn);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      type: 'STOCK_IN',
      reasonCode: 'PURCHASE',
      reference: 'GRN-2611-014',
      createdBy: { id: clerk.ctx.userId, name: 'Ravi Kulkarni' },
      lowStock: [],
    });
    expect(res.body.data.transactions).toEqual([
      expect.objectContaining({
        variantId: V1,
        sku: 'EAR-MEERA-GLD-M',
        quantity: 20,
        onHandBefore: 4,
        onHandAfter: 24,
        reservedAfter: 2,
        availableAfter: 22,
      }),
      expect.objectContaining({
        variantId: V2,
        onHandBefore: 0,
        onHandAfter: 15,
        availableAfter: 15,
      }),
    ]);
    // SKU lookup was normalized; the missing inventory row for V2 was created at zero.
    expect(t.m.productVariant.findMany.mock.calls[0]?.[0].where.OR).toEqual([
      { id: { in: [V2] } },
      { sku: { in: ['EAR-MEERA-GLD-M'] } },
    ]);
    expect(t.m.inventory.create).toHaveBeenCalledWith({
      data: { variantId: V2 },
      select: { variantId: true },
    });
    const ledger = t.m.inventoryTransaction.createMany.mock.calls[0]?.[0].data;
    expect(ledger).toHaveLength(2);
    expect(ledger[0]).toMatchObject({
      type: 'STOCK_IN',
      onHandDelta: 20,
      reservedDelta: 0,
      onHandAfter: 24,
      reservedAfter: 2,
      reasonCode: 'PURCHASE',
      note: '[ref:GRN-2611-014] Diwali restock',
      unitCost: '510.00',
      batchId: res.body.data.movementGroupId,
      createdById: clerk.ctx.userId,
    });
    const audits = t.m.auditLog.create.mock.calls.map(
      (c) => (c[0] as { data: Record<string, unknown> }).data,
    );
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      action: 'STOCK_ADJUST',
      module: 'inventory',
      entityType: 'Inventory',
      entityId: V1,
      actorUserId: clerk.ctx.userId,
    });
    expect(t.m.$executeRaw).toHaveBeenCalledTimes(1); // products.is_in_stock refresh
    expect(t.m.idempotencyKey.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'idem-row' } }),
    );
  });

  it('rejects a stock-out below reserved with 409 INSUFFICIENT_STOCK and writes nothing', async () => {
    const { t, clerk } = setup();
    t.m.productVariant.findMany.mockResolvedValue([{ id: V1, sku: 'EAR-MEERA-GLD-M' }]);
    t.m.$queryRaw.mockResolvedValue([
      { variantId: V1, onHand: 4, reserved: 2, lowStockThreshold: null, lowStockAlertedAt: null },
    ]);
    const res = await request(t.app)
      .post(`${BASE}/movements`)
      .set(clerk.headers)
      .set('Idempotency-Key', idemKey())
      .send({
        type: 'STOCK_OUT',
        reasonCode: 'DAMAGED',
        items: [{ variantId: V1, quantity: 5 }],
      });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(res.body.error.message).toBe(
      'Cannot remove 5 units of EAR-MEERA-GLD-M: only 2 are unreserved.',
    );
    expect(res.body.error.details[0]).toMatchObject({
      field: 'items[0].quantity',
      code: 'INSUFFICIENT_STOCK',
      meta: { sku: 'EAR-MEERA-GLD-M', onHand: 4, reserved: 2, requested: 5, maxRemovable: 2 },
    });
    expect(t.m.inventory.update).not.toHaveBeenCalled();
    expect(t.m.inventoryTransaction.createMany).not.toHaveBeenCalled();
    expect(t.m.auditLog.create).not.toHaveBeenCalled();
  });

  it('applies an adjustment decrease and flags a low-stock crossing', async () => {
    const { t, clerk } = setup();
    t.m.productVariant.findMany.mockResolvedValue([{ id: V1, sku: 'EAR-MEERA-GLD-M' }]);
    t.m.$queryRaw.mockResolvedValue([
      { variantId: V1, onHand: 8, reserved: 0, lowStockThreshold: 3, lowStockAlertedAt: null },
    ]);
    const res = await request(t.app)
      .post(`${BASE}/movements`)
      .set(clerk.headers)
      .set('Idempotency-Key', idemKey())
      .send({
        type: 'ADJUSTMENT_DECREASE',
        reasonCode: 'CYCLE_COUNT',
        note: 'Counted 5',
        items: [{ variantId: V1, quantity: 5 }],
      });
    expect(res.status).toBe(201);
    expect(res.body.data.transactions[0]).toMatchObject({ onHandAfter: 3, availableAfter: 3 });
    expect(res.body.data.lowStock).toEqual([{ variantId: V1, available: 3, threshold: 3 }]);
    expect(t.m.inventoryTransaction.createMany.mock.calls[0]?.[0].data[0].onHandDelta).toBe(-5);
  });

  it('validates type, reason, note, quantities, unitCost and duplicates', async () => {
    const { t, clerk } = setup();
    const post = (body: unknown) =>
      request(t.app)
        .post(`${BASE}/movements`)
        .set(clerk.headers)
        .set('Idempotency-Key', idemKey())
        .send(body as object);
    const item = { variantId: V1, quantity: 1 };
    expect(
      (await post({ type: 'ORDER_DEDUCTION', reasonCode: 'OTHER', note: 'x', items: [item] }))
        .status,
    ).toBe(422);
    const noNote = await post({ type: 'ADJUSTMENT_INCREASE', reasonCode: 'FOUND', items: [item] });
    expect(noNote.status).toBe(422);
    expect(noNote.body.error.details[0].field).toBe('note');
    expect((await post({ type: 'STOCK_IN', reasonCode: 'OTHER', items: [item] })).status).toBe(422);
    expect(
      (
        await post({
          type: 'STOCK_IN',
          reasonCode: 'PURCHASE',
          items: [{ variantId: V1, quantity: 0 }],
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await post({
          type: 'STOCK_IN',
          reasonCode: 'PURCHASE',
          items: [{ variantId: V1, quantity: 1.5 }],
        })
      ).status,
    ).toBe(422);
    expect((await post({ type: 'STOCK_IN', reasonCode: 'PURCHASE', items: [] })).status).toBe(422);
    expect(
      (
        await post({
          type: 'STOCK_IN',
          reasonCode: 'PURCHASE',
          items: [{ variantId: V1, sku: 'A', quantity: 1 }],
        })
      ).status,
    ).toBe(422);
    const cost = await post({
      type: 'STOCK_OUT',
      reasonCode: 'LOST',
      items: [{ variantId: V1, quantity: 1, unitCost: '10.00' }],
    });
    expect(cost.body.error.details[0].field).toBe('items[0].unitCost');

    t.m.productVariant.findMany.mockResolvedValue([{ id: V1, sku: 'EAR-MEERA-GLD-M' }]);
    const dup = await post({
      type: 'STOCK_IN',
      reasonCode: 'PURCHASE',
      items: [item, { sku: 'EAR-MEERA-GLD-M', quantity: 2 }],
    });
    expect(dup.status).toBe(422);
    expect(dup.body.error.details[0].field).toBe('items[1]');
    const unknown = await post({
      type: 'STOCK_IN',
      reasonCode: 'PURCHASE',
      items: [{ sku: 'NOPE-1', quantity: 2 }],
    });
    expect(unknown.body.error.details[0].field).toBe('items[0].sku');
    expect(t.m.inventoryTransaction.createMany).not.toHaveBeenCalled();
  });
});

describe('inventory reads & threshold', () => {
  it('lists with low-stock filter and hides cost without reports.view', async () => {
    const { t, viewer } = setup();
    const row = {
      variantId: V1,
      sku: 'EAR-MEERA-GLD-M',
      barcode: null,
      variantName: 'Gold / Medium',
      status: 'ACTIVE',
      productId: randomUUID(),
      productName: 'Meera Kundan Jhumka',
      costPrice: new Decimal('510.00'),
      onHand: 4,
      reserved: 2,
      lowStockThreshold: null,
      updatedAt: new Date('2026-11-13T10:10:00.000Z'),
    };
    t.m.$queryRaw.mockResolvedValueOnce([row]).mockResolvedValueOnce([{ total: 1n }]);
    const res = await request(t.app)
      .get(`${BASE}?lowStock=true&sku=ear-mee&sort=-available`)
      .set(viewer.headers);
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({
      onHand: 4,
      reserved: 2,
      available: 2,
      effectiveThreshold: 5,
      isLowStock: true,
    });
    expect(res.body.data[0].costPrice).toBeUndefined();
    expect(res.body.meta.totalItems).toBe(1);
    const listSql = t.m.$queryRaw.mock.calls[0]?.[0] as { sql: string; values: unknown[] };
    expect(listSql.values).toContain('EAR-MEE%');
    expect(listSql.sql).toMatch(/DESC/);

    const reporter = t.staff({ permissions: ['inventory.view', 'reports.view'] });
    t.m.$queryRaw
      .mockResolvedValueOnce([
        { ...row, lowStockThreshold: 1, costPrice: '510.00', updatedAt: null },
      ])
      .mockResolvedValueOnce([{ total: 1 }]);
    const withCost = await request(t.app)
      .get(`${BASE}?stock=low_stock&q=meera&categoryId=${randomUUID()}&brandId=${randomUUID()}`)
      .set(reporter.headers);
    expect(withCost.body.data[0]).toMatchObject({
      costPrice: '510.00',
      stockValue: '2040.00',
      isLowStock: false,
      updatedAt: null,
    });
    expect((await request(t.app).get(`${BASE}?limit=101`).set(viewer.headers)).status).toBe(422);
    expect((await request(t.app).get(`${BASE}?stock=weird`).set(viewer.headers)).status).toBe(422);
  });

  it('runs the other stock filters and sorts', async () => {
    const { t, viewer } = setup();
    for (const qs of ['stock=in_stock&sort=available', 'stock=out_of_stock&sort=-sku', '']) {
      t.m.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      const res = await request(t.app).get(`${BASE}?${qs}`).set(viewer.headers);
      expect(res.status).toBe(200);
      expect(res.body.meta.totalItems).toBe(0);
    }
  });

  it('looks up by SKU or barcode (normalized) and 404s otherwise', async () => {
    const { t, viewer } = setup();
    t.m.productVariant.findFirst.mockResolvedValueOnce(null);
    expect((await request(t.app).get(`${BASE}/lookup?sku=nope`).set(viewer.headers)).status).toBe(
      404,
    );
    expect(
      (await request(t.app).get(`${BASE}/lookup?sku=has space`).set(viewer.headers)).status,
    ).toBe(422);

    t.m.productVariant.findFirst.mockResolvedValueOnce({
      id: V1,
      sku: 'EAR-MEERA-GLD-M',
      barcode: 'EAR-MEERA-GLD-M',
      name: 'Gold / Medium',
      status: 'ACTIVE',
      productId: 'p1',
      product: {
        id: 'p1',
        name: 'Meera Kundan Jhumka',
        status: 'ACTIVE',
        images: [{ url: 'https://img/p.jpg' }],
      },
      images: [],
      inventory: { quantityOnHand: 4, quantityReserved: 2, lowStockThreshold: null },
    });
    t.m.inventoryTransaction.findMany.mockResolvedValueOnce([
      {
        id: 't1',
        type: 'RESERVATION',
        onHandDelta: 0,
        reservedDelta: 2,
        onHandAfter: 4,
        reservedAfter: 2,
        createdAt: new Date('2026-11-13T10:10:00.000Z'),
      },
    ]);
    const res = await request(t.app)
      .get(`${BASE}/lookup?sku=%20ear-meera-gld-m%20`)
      .set(viewer.headers);
    expect(res.status).toBe(200);
    expect(t.m.productVariant.findFirst.mock.calls[1]?.[0].where.OR).toEqual([
      { sku: 'EAR-MEERA-GLD-M' },
      { barcode: 'EAR-MEERA-GLD-M' },
    ]);
    expect(res.body.data).toMatchObject({
      imageUrl: 'https://img/p.jpg',
      inventory: { onHand: 4, reserved: 2, available: 2, effectiveThreshold: 5, isLowStock: true },
      recentTransactions: [{ id: 't1', type: 'RESERVATION', quantity: 2 }],
    });
  });

  it('lists the immutable history with references, orders and actors', async () => {
    const { t, viewer } = setup();
    t.m.productVariant.findFirst.mockResolvedValueOnce(null);
    expect(
      (await request(t.app).get(`${BASE}/${V1}/transactions`).set(viewer.headers)).status,
    ).toBe(404);

    t.m.productVariant.findFirst.mockResolvedValue({ id: V1, sku: 'EAR-MEERA-GLD-M' });
    const staffId = randomUUID();
    t.m.inventoryTransaction.findMany.mockResolvedValue([
      {
        id: 't2',
        type: 'STOCK_IN',
        onHandDelta: 20,
        reservedDelta: 0,
        onHandAfter: 24,
        reservedAfter: 2,
        reasonCode: 'PURCHASE',
        note: '[ref:GRN-1] Diwali restock',
        unitCost: new Decimal('510'),
        batchId: 'mg-1',
        createdById: staffId,
        createdAt: new Date('2026-11-13T10:10:00.000Z'),
        order: null,
      },
      {
        id: 't1',
        type: 'ORDER_DEDUCTION',
        onHandDelta: -1,
        reservedDelta: -1,
        onHandAfter: 4,
        reservedAfter: 2,
        reasonCode: null,
        note: null,
        unitCost: null,
        batchId: null,
        createdById: null,
        createdAt: new Date('2026-11-12T10:10:00.000Z'),
        order: { orderNumber: 'ORD-261112-00001' },
      },
    ]);
    t.m.inventoryTransaction.count.mockResolvedValue(2);
    t.m.user.findMany.mockResolvedValue([{ id: staffId, firstName: 'Ravi', lastName: null }]);
    const res = await request(t.app)
      .get(`${BASE}/${V1}/transactions?type=stock_in,ORDER_DEDUCTION&from=2026-11-01&to=2026-11-13`)
      .set(viewer.headers);
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({
      quantity: 20,
      note: 'Diwali restock',
      reference: 'GRN-1',
      unitCost: '510.00',
      createdBy: { id: staffId, name: 'Ravi' },
    });
    expect(res.body.data[1]).toMatchObject({
      quantity: -1,
      orderNumber: 'ORD-261112-00001',
      createdBy: 'SYSTEM',
    });
    const where = t.m.inventoryTransaction.findMany.mock.calls[0]?.[0].where;
    expect(where.type).toEqual({ in: ['STOCK_IN', 'ORDER_DEDUCTION'] });
    expect(where.createdAt.gte).toEqual(new Date('2026-10-31T18:30:00.000Z'));
    expect(where.createdAt.lt).toEqual(new Date('2026-11-13T18:30:00.000Z'));

    expect(
      (await request(t.app).get(`${BASE}/${V1}/transactions?type=BOGUS`).set(viewer.headers))
        .status,
    ).toBe(422);
  });

  it('FR-INV-006: filters history by actor (actorId → created_by_id) alongside type/date', async () => {
    const { t, viewer } = setup();
    t.m.productVariant.findFirst.mockResolvedValue({ id: V1, sku: 'EAR-MEERA-GLD-M' });
    t.m.inventoryTransaction.findMany.mockResolvedValue([]);
    t.m.inventoryTransaction.count.mockResolvedValue(0);
    const staffId = randomUUID();
    const res = await request(t.app)
      .get(`${BASE}/${V1}/transactions?type=STOCK_IN&from=2026-11-01&actorId=${staffId}`)
      .set(viewer.headers);
    expect(res.status).toBe(200);
    const where = t.m.inventoryTransaction.findMany.mock.calls[0]?.[0].where;
    expect(where).toEqual({
      variantId: V1,
      type: { in: ['STOCK_IN'] },
      createdById: staffId,
      createdAt: { gte: new Date('2026-10-31T18:30:00.000Z') },
    });
    expect(t.m.inventoryTransaction.count.mock.calls[0]?.[0].where).toEqual(where);

    // Without actorId the filter is absent; a malformed id is a 422.
    await request(t.app).get(`${BASE}/${V1}/transactions`).set(viewer.headers);
    expect(t.m.inventoryTransaction.findMany.mock.calls[1]?.[0].where).not.toHaveProperty(
      'createdById',
    );
    expect(
      (await request(t.app).get(`${BASE}/${V1}/transactions?actorId=ravi`).set(viewer.headers))
        .status,
    ).toBe(422);
  });

  it('updates the low-stock threshold with an audit row', async () => {
    const { t, viewer, clerk } = setup();
    expect(
      (
        await request(t.app)
          .patch(`${BASE}/${V1}`)
          .set(viewer.headers)
          .send({ lowStockThreshold: 3 })
      ).status,
    ).toBe(403);
    t.m.productVariant.findFirst.mockResolvedValue({ id: V1, sku: 'EAR-MEERA-GLD-M' });
    t.m.inventory.findUnique.mockResolvedValue({ lowStockThreshold: null });
    t.m.inventory.upsert.mockResolvedValue({
      quantityOnHand: 4,
      quantityReserved: 0,
      lowStockThreshold: 3,
      updatedAt: new Date('2026-11-19T06:30:00.000Z'),
    });
    const res = await request(t.app)
      .patch(`${BASE}/${V1}`)
      .set(clerk.headers)
      .send({ lowStockThreshold: 3 });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      lowStockThreshold: 3,
      effectiveThreshold: 3,
      isLowStock: false,
    });
    expect(t.m.auditLog.create.mock.calls.at(-1)?.[0].data).toMatchObject({
      action: 'UPDATE',
      module: 'inventory',
      entityId: V1,
    });
    expect(
      (await request(t.app).patch(`${BASE}/${V1}`).set(clerk.headers).send({ onHand: 3 })).status,
    ).toBe(422);
    expect(
      (
        await request(t.app)
          .patch(`${BASE}/${V1}`)
          .set(clerk.headers)
          .send({ lowStockThreshold: -1 })
      ).status,
    ).toBe(422);
  });
});

describe('Phase 4 catalogue gaps — STOCK_OUT ledger and immutable history', () => {
  it('TC-028: a successful STOCK_OUT writes one inventory_transactions ledger row', async () => {
    const { t, clerk } = setup();
    t.m.inventoryTransaction.createMany.mockResolvedValue({ count: 1 });
    t.m.productVariant.findMany.mockResolvedValue([{ id: V1, sku: 'EAR-MEERA-GLD-M' }]);
    t.m.$queryRaw.mockResolvedValue([
      { variantId: V1, onHand: 10, reserved: 2, lowStockThreshold: null, lowStockAlertedAt: null },
    ]);
    const res = await request(t.app)
      .post(`${BASE}/movements`)
      .set(clerk.headers)
      .set('Idempotency-Key', idemKey())
      .send({
        type: 'STOCK_OUT',
        reasonCode: 'DAMAGED',
        note: 'Broken clasp',
        items: [{ variantId: V1, quantity: 3 }],
      });
    expect(res.status).toBe(201);
    expect(res.body.data.transactions[0]).toMatchObject({
      variantId: V1,
      onHandBefore: 10,
      onHandAfter: 7,
      reservedAfter: 2,
      availableAfter: 5,
    });
    expect(t.m.inventoryTransaction.createMany).toHaveBeenCalledTimes(1);
    const ledger = t.m.inventoryTransaction.createMany.mock.calls[0]?.[0].data as Record<
      string,
      unknown
    >[];
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      type: 'STOCK_OUT',
      onHandDelta: -3,
      reservedDelta: 0,
      onHandAfter: 7,
      reservedAfter: 2,
      reasonCode: 'DAMAGED',
      createdById: clerk.ctx.userId,
    });
    expect(t.m.auditLog.create.mock.calls[0]?.[0].data).toMatchObject({
      action: 'STOCK_ADJUST',
      entityId: V1,
    });
    // The ledger is append-only: nothing in the movement path rewrites or removes rows.
    expect(t.m.inventoryTransaction.update).not.toHaveBeenCalled();
    expect(t.m.inventoryTransaction.updateMany).not.toHaveBeenCalled();
    expect(t.m.inventoryTransaction.delete).not.toHaveBeenCalled();
    expect(t.m.inventoryTransaction.deleteMany).not.toHaveBeenCalled();
    expect(t.m.inventoryTransaction.upsert).not.toHaveBeenCalled();
  });

  it('TC-028: history is immutable — no update/delete route, permission or write path', async () => {
    const { t } = setup();
    const admin = t.staff({ isSuperadmin: true, reauthenticated: true });
    const txId = randomUUID();
    for (const [method, path] of [
      ['put', `${BASE}/${V1}/transactions/${txId}`],
      ['patch', `${BASE}/${V1}/transactions/${txId}`],
      ['delete', `${BASE}/${V1}/transactions/${txId}`],
      ['delete', `${BASE}/${V1}/transactions`],
      ['delete', `${BASE}/${V1}`],
    ] as const) {
      const res = await request(t.app)[method](path).set(admin.headers).send({});
      expect(res.status, `${method.toUpperCase()} ${path}`).toBe(404);
    }
    // Only read access to the ledger is guarded; there is no inventory delete permission.
    const routes = expectAdminRoutesGuarded(createInventoryModule(t.container));
    const ledgerRoutes = routes.filter((r) => r.path.includes('/transactions'));
    expect(ledgerRoutes.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /inventory/:variantId/transactions',
    ]);
    const inventoryKeys = PERMISSIONS.map((p) => p.key).filter((k) => k.startsWith('inventory.'));
    expect(inventoryKeys.sort()).toEqual([
      'inventory.create',
      'inventory.update',
      'inventory.view',
    ]);
    // No application code mutates an existing ledger row (generated Prisma client excluded).
    const srcRoot = fileURLToPath(new URL('../../../../src/', import.meta.url));
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'generated') walk(full);
        } else if (entry.name.endsWith('.ts')) {
          const text = readFileSync(full, 'utf8');
          if (
            /inventoryTransaction\s*\.\s*(update|updateMany|delete|deleteMany|upsert)\b/.test(text)
          )
            offenders.push(full);
          if (/UPDATE\s+inventory_transactions|DELETE\s+FROM\s+inventory_transactions/i.test(text))
            offenders.push(full);
        }
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([]);
  });
});

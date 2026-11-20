/**
 * InventoryService (reserve / commit / release / restore / deduct) and pure rules — MOCKED DB.
 * Verifies lock order, invariants, ledger rows, reservation states and low-stock episodes.
 */
import { describe, expect, it } from 'vitest';

import { AppError } from '../../../../src/core/errors/AppError.js';
import {
  createInventoryService,
  loadLowStockDefault,
  lockInventoryRows,
} from '../../../../src/modules/inventory/index.js';
import {
  decodeNote,
  encodeNote,
  escapeLike,
  evaluateLowStock,
  maxRemovable,
  onHandDeltaFor,
} from '../../../../src/modules/inventory/inventory.rules.js';
import { createMockDb, type MockModels } from '../../../helpers/mockDb.js';

const NOW = new Date('2026-11-19T06:30:00.000Z');
const V_A = '00000000-0000-4000-8000-00000000000a';
const V_B = '00000000-0000-4000-8000-00000000000b';
const ORDER = '11111111-1111-4111-8111-111111111111';

function setup(rows: Record<string, unknown>[] = []) {
  const { db, m } = createMockDb();
  m.$queryRaw.mockResolvedValue(rows);
  m.inventoryTransaction.createMany.mockResolvedValue({ count: 0 });
  m.stockReservation.updateMany.mockResolvedValue({ count: 1 });
  m.stockReservation.findMany.mockResolvedValue([]);
  const service = createInventoryService({ clock: () => NOW, reservationTtlMinutes: 15 });
  return { db, m, service };
}

const inv = (variantId: string, onHand: number, reserved: number, extra = {}) => ({
  variantId,
  onHand,
  reserved,
  lowStockThreshold: null,
  lowStockAlertedAt: null,
  ...extra,
});

type Ledger = { type: string; variantId: string; onHandDelta: number; reservedDelta: number }[];
const ledgerOf = (m: MockModels): Ledger =>
  (m.inventoryTransaction.createMany.mock.calls[0]?.[0] as { data: Ledger }).data;

async function expectAppError(promise: Promise<unknown>, code: string): Promise<AppError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
  return error as AppError;
}

describe('lockInventoryRows', () => {
  it('locks ascending, de-duplicated, with FOR UPDATE and coerces numbers', async () => {
    const { db, m } = setup([
      {
        ...inv(V_A, 3, 1),
        onHand: 3n,
        lowStockThreshold: '2',
        lowStockAlertedAt: NOW.toISOString(),
      },
    ]);
    const rows = await lockInventoryRows(db, [V_B, V_A, V_B], { createMissing: true });
    const sql = m.$queryRaw.mock.calls[0]?.[0] as { sql: string; values: unknown[] };
    expect(sql.values).toEqual([V_A, V_B]);
    expect(sql.sql).toMatch(/ORDER BY variant_id ASC\s+FOR UPDATE/);
    expect(rows.get(V_A)).toMatchObject({ onHand: 3, reserved: 1, lowStockThreshold: 2 });
    expect(rows.get(V_A)?.lowStockAlertedAt).toEqual(NOW);
    expect(rows.get(V_B)).toMatchObject({ onHand: 0, reserved: 0 });
    expect(m.inventory.create).toHaveBeenCalledWith({
      data: { variantId: V_B },
      select: { variantId: true },
    });
    expect((await lockInventoryRows(db, [])).size).toBe(0);
  });
});

describe('InventoryService.reserve', () => {
  it('reserves stock: reserved += q, ACTIVE reservation, RESERVATION ledger, product flags', async () => {
    const { db, m, service } = setup([inv(V_A, 10, 0), inv(V_B, 4, 1)]);
    const expiresAt = service.reservationExpiry();
    expect(expiresAt.toISOString()).toBe('2026-11-19T06:45:00.000Z');
    const out = await service.reserve(
      db,
      [
        { variantId: V_B, quantity: 1 },
        { variantId: V_A, quantity: 2 },
        { variantId: V_A, quantity: 1 },
      ],
      ORDER,
      expiresAt,
    );
    expect(out.reservations.map((r) => [r.variantId, r.quantity])).toEqual([
      [V_A, 3],
      [V_B, 1],
    ]);
    expect(m.stockReservation.create).toHaveBeenCalledTimes(2);
    expect(m.stockReservation.create.mock.calls[0]?.[0].data).toMatchObject({
      orderId: ORDER,
      variantId: V_A,
      quantity: 3,
      status: 'ACTIVE',
      expiresAt,
    });
    const updateA = m.inventory.update.mock.calls[0]?.[0];
    expect(updateA.where).toEqual({ variantId: V_A });
    expect(updateA.data).toMatchObject({ quantityOnHand: 10, quantityReserved: 3 });
    expect(ledgerOf(m)).toEqual([
      expect.objectContaining({
        type: 'RESERVATION',
        variantId: V_A,
        onHandDelta: 0,
        reservedDelta: 3,
      }),
      expect.objectContaining({ type: 'RESERVATION', variantId: V_B, reservedDelta: 1 }),
    ]);
    expect(ledgerOf(m)[0]).toMatchObject({ orderId: ORDER, createdById: null });
    expect(m.$executeRaw).toHaveBeenCalledTimes(1);
    // V_B: available 4−1−1 = 2 ≤ default 5 → new low-stock episode; V_A 7 > 5.
    expect(out.lowStock).toEqual([{ variantId: V_B, available: 2, threshold: 5 }]);
    expect(m.inventory.update.mock.calls[1]?.[0].data.lowStockAlertedAt).toEqual(NOW);
  });

  it('fails with INSUFFICIENT_STOCK listing every short line and writes nothing', async () => {
    const { db, m, service } = setup([inv(V_A, 1, 1)]);
    const error = await expectAppError(
      service.reserve(
        db,
        [
          { variantId: V_A, quantity: 1, sku: 'EAR-A' },
          { variantId: V_B, quantity: 1 },
        ],
        ORDER,
        NOW,
      ),
      'INSUFFICIENT_STOCK',
    );
    expect(error.httpStatus).toBe(409);
    expect(error.details?.map((d) => d.meta)).toEqual([
      { variantId: V_A, sku: 'EAR-A', requested: 1, available: 0 },
      { variantId: V_B, requested: 1, available: 0 },
    ]);
    expect(m.inventory.update).not.toHaveBeenCalled();
    expect(m.inventoryTransaction.createMany).not.toHaveBeenCalled();
  });

  it('refuses a double reservation and re-activates a released row on retry', async () => {
    const { db, m, service } = setup([inv(V_A, 5, 0)]);
    m.stockReservation.findMany.mockResolvedValueOnce([
      { id: 'r1', variantId: V_A, status: 'ACTIVE' },
    ]);
    const conflict = await expectAppError(
      service.reserve(db, [{ variantId: V_A, quantity: 1 }], ORDER, NOW),
      'CONFLICT',
    );
    expect(conflict.details?.[0]?.code).toBe('ALREADY_RESERVED');

    m.stockReservation.findMany.mockResolvedValueOnce([
      { id: 'r1', variantId: V_A, status: 'EXPIRED' },
    ]);
    const out = await service.reserve(db, [{ variantId: V_A, quantity: 2 }], ORDER, NOW);
    expect(m.stockReservation.create).not.toHaveBeenCalled();
    expect(m.stockReservation.update).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: expect.objectContaining({ status: 'ACTIVE', quantity: 2, releasedAt: null }),
    });
    expect(out.reservations[0]?.id).toBe('r1');
  });

  it('rejects non-positive or fractional quantities', async () => {
    const { db, service } = setup([inv(V_A, 5, 0)]);
    await expectAppError(
      service.reserve(db, [{ variantId: V_A, quantity: 0 }], ORDER, NOW),
      'VALIDATION_ERROR',
    );
    await expectAppError(
      service.deductDirect(db, [{ variantId: V_A, quantity: 1.5 }], ORDER),
      'VALIDATION_ERROR',
    );
  });
});

describe('InventoryService.commitReservation / releaseReservation', () => {
  it('commits ACTIVE reservations (on_hand −q, reserved −q) and is idempotent', async () => {
    const { db, m, service } = setup([inv(V_A, 5, 2)]);
    m.stockReservation.findMany.mockResolvedValueOnce([{ id: 'r1', variantId: V_A, quantity: 2 }]);
    const out = await service.commitReservation(db, ORDER, { actorUserId: 'staff-1' });
    expect(m.stockReservation.updateMany).toHaveBeenCalledWith({
      where: { id: 'r1', status: 'ACTIVE' },
      data: { status: 'COMMITTED', committedAt: NOW },
    });
    expect(out.ledger).toEqual([
      expect.objectContaining({
        type: 'ORDER_DEDUCTION',
        onHandDelta: -2,
        reservedDelta: -2,
        onHandAfter: 3,
        reservedAfter: 0,
      }),
    ]);
    expect(ledgerOf(m)[0]).toMatchObject({ stockReservationId: 'r1', createdById: 'staff-1' });
    expect(m.inventory.update.mock.calls[0]?.[0].data.updatedById).toBe('staff-1');

    m.stockReservation.findMany.mockResolvedValueOnce([]);
    expect(await service.commitReservation(db, ORDER)).toEqual({ ledger: [], lowStock: [] });
  });

  it('skips reservations handled concurrently', async () => {
    const { db, m, service } = setup([inv(V_A, 5, 2)]);
    m.stockReservation.findMany.mockResolvedValueOnce([{ id: 'r1', variantId: V_A, quantity: 2 }]);
    m.stockReservation.updateMany.mockResolvedValueOnce({ count: 0 });
    expect((await service.commitReservation(db, ORDER)).ledger).toEqual([]);
    expect(m.inventoryTransaction.createMany).not.toHaveBeenCalled();
  });

  it('raises CONFLICT when the inventory row is missing or the invariant breaks', async () => {
    const { db, m, service } = setup([]);
    m.stockReservation.findMany.mockResolvedValueOnce([{ id: 'r1', variantId: V_A, quantity: 2 }]);
    const missing = await expectAppError(service.commitReservation(db, ORDER), 'CONFLICT');
    expect(missing.details?.[0]?.code).toBe('INVENTORY_MISSING');

    m.$queryRaw.mockResolvedValue([inv(V_A, 5, 1)]);
    m.stockReservation.findMany.mockResolvedValueOnce([{ id: 'r1', variantId: V_A, quantity: 2 }]);
    const broken = await expectAppError(
      service.releaseReservation(db, ORDER, 'CANCELLED'),
      'CONFLICT',
    );
    expect(broken.details?.[0]?.code).toBe('INVENTORY_INVARIANT');
  });

  it('releases with EXPIRED vs RELEASED status and re-arms low stock', async () => {
    const { db, m, service } = setup([inv(V_A, 10, 6, { lowStockAlertedAt: NOW })]);
    m.stockReservation.findMany.mockResolvedValueOnce([{ id: 'r1', variantId: V_A, quantity: 6 }]);
    const out = await service.releaseReservation(db, ORDER, 'EXPIRED');
    expect(m.stockReservation.updateMany.mock.calls[0]?.[0].data).toMatchObject({
      status: 'EXPIRED',
      releaseReason: 'EXPIRED',
    });
    expect(out.ledger[0]).toMatchObject({
      type: 'RESERVATION_RELEASE',
      reservedDelta: -6,
      reservedAfter: 0,
    });
    expect(m.inventory.update.mock.calls[0]?.[0].data.lowStockAlertedAt).toBeNull();

    m.stockReservation.findMany.mockResolvedValueOnce([{ id: 'r2', variantId: V_A, quantity: 1 }]);
    await service.releaseReservation(db, ORDER, 'PAYMENT_FAILED');
    expect(m.stockReservation.updateMany.mock.calls[1]?.[0].data.status).toBe('RELEASED');

    m.stockReservation.findMany.mockResolvedValueOnce([]);
    expect((await service.releaseReservation(db, ORDER, 'CANCELLED')).ledger).toEqual([]);
  });
});

describe('InventoryService.restoreCancellation / deductDirect', () => {
  it('releases active reservations and restores only the net deducted quantity', async () => {
    const { db, m, service } = setup([inv(V_A, 3, 1), inv(V_B, 0, 0)]);
    m.stockReservation.findMany.mockResolvedValueOnce([{ id: 'r1', variantId: V_A, quantity: 1 }]);
    m.inventoryTransaction.findMany.mockResolvedValueOnce([
      { variantId: V_B, type: 'ORDER_DEDUCTION', onHandDelta: -3 },
      { variantId: V_B, type: 'CANCELLATION_RESTORE', onHandDelta: 1 },
      { variantId: V_A, type: 'ORDER_DEDUCTION', onHandDelta: -2 },
      { variantId: V_A, type: 'CANCELLATION_RESTORE', onHandDelta: 2 },
    ]);
    const out = await service.restoreCancellation(db, ORDER);
    expect(out.ledger.map((e) => [e.type, e.variantId, e.onHandDelta, e.reservedDelta])).toEqual([
      ['RESERVATION_RELEASE', V_A, 0, -1],
      ['CANCELLATION_RESTORE', V_B, 2, 0],
    ]);
    expect(m.stockReservation.updateMany.mock.calls[0]?.[0].data.releaseReason).toBe('CANCELLED');
  });

  it('is a no-op when nothing is reserved or deducted', async () => {
    const { db, m, service } = setup([]);
    m.stockReservation.findMany.mockResolvedValueOnce([]);
    m.inventoryTransaction.findMany.mockResolvedValueOnce([]);
    expect(await service.restoreCancellation(db, ORDER)).toEqual({ ledger: [], lowStock: [] });
    expect(m.$queryRaw).not.toHaveBeenCalled();
  });

  it('deducts directly for COD and refuses to oversell (no backorders)', async () => {
    const { db, m, service } = setup([inv(V_A, 2, 1)]);
    await expectAppError(
      service.deductDirect(db, [{ variantId: V_A, quantity: 2 }], ORDER),
      'INSUFFICIENT_STOCK',
    );
    const out = await service.deductDirect(db, [{ variantId: V_A, quantity: 1 }], ORDER);
    expect(out.ledger[0]).toMatchObject({
      type: 'ORDER_DEDUCTION',
      onHandDelta: -1,
      reservedDelta: 0,
      onHandAfter: 1,
    });
    expect(ledgerOf(m)[0]).toMatchObject({ orderId: ORDER });
  });
});

describe('low-stock default & rules', () => {
  it('reads the global default from settings (fallback 5)', async () => {
    const { db, m } = setup();
    m.setting.findUnique.mockResolvedValueOnce({ value: 10 });
    expect(await loadLowStockDefault(db)).toBe(10);
    m.setting.findUnique.mockResolvedValueOnce({ value: 'x' });
    expect(await loadLowStockDefault(db)).toBe(5);
    m.setting.findUnique.mockResolvedValueOnce(null);
    expect(await loadLowStockDefault(db)).toBe(5);
  });

  it('evaluates low-stock episodes edge-triggered', () => {
    expect(evaluateLowStock(5, 5, null, NOW)).toEqual({ alertedAt: NOW, crossed: true });
    expect(evaluateLowStock(4, 5, NOW, NOW)).toEqual({ alertedAt: undefined, crossed: false });
    expect(evaluateLowStock(6, 5, NOW, NOW)).toEqual({ alertedAt: null, crossed: false });
    expect(evaluateLowStock(6, 5, null, NOW)).toEqual({ alertedAt: undefined, crossed: false });
  });

  it('computes removable stock and signed deltas', () => {
    expect(maxRemovable(4, 2)).toBe(2);
    expect(maxRemovable(2, 5)).toBe(0);
    expect(onHandDeltaFor('STOCK_OUT', 3)).toBe(-3);
    expect(onHandDeltaFor('ADJUSTMENT_INCREASE', 3)).toBe(3);
  });

  it('round-trips references through the note column', () => {
    expect(encodeNote(undefined, undefined)).toBeNull();
    expect(encodeNote('n', undefined)).toBe('n');
    expect(encodeNote(undefined, 'GRN-1')).toBe('[ref:GRN-1]');
    expect(decodeNote(encodeNote('Diwali\nrestock', 'GRN-1'))).toEqual({
      note: 'Diwali\nrestock',
      reference: 'GRN-1',
    });
    expect(decodeNote('[ref:GRN-1]')).toEqual({ note: null, reference: 'GRN-1' });
    expect(decodeNote('plain')).toEqual({ note: 'plain', reference: null });
    expect(decodeNote(null)).toEqual({ note: null, reference: null });
  });

  it('escapes LIKE wildcards', () => {
    expect(escapeLike('A_B%C\\')).toBe('A\\_B\\%C\\\\');
  });
});

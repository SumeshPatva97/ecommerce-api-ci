/**
 * Stock primitives & reservation lifecycle — BACKEND_STRUCTURE.md §7,
 * INVENTORY_AND_STOCK_DATABASE_DESIGN.md §4–§6, PRODUCT_VARIANT_AND_INVENTORY_WORKFLOWS.md §18–§20.
 *
 * Every function takes the CALLER's transaction client (checkout / payment capture / cancel run
 * one DB transaction each) and:
 * 1. locks `inventory` rows with `SELECT … FOR UPDATE` in ascending `variant_id` order (no
 *    deadlocks between concurrent checkouts),
 * 2. checks invariants (`0 ≤ reserved ≤ on_hand`; PROVISIONAL OQ-18: no backorders),
 * 3. updates `inventory`, `stock_reservations`, and appends `inventory_transactions` rows
 *    (append-only ledger with after-balances), and refreshes `products.is_in_stock`.
 *
 * PROVISIONAL (OQ-17): reservations are created at order placement with
 * TTL = `config.integrations.reservationTtlMinutes` (15 min) — see `reservationExpiry`.
 * PROVISIONAL (OQ-19): single location.
 */
import { randomUUID } from 'node:crypto';

import { Prisma } from '../../generated/prisma/client.js';
import type { InventoryTxnType } from '../../generated/prisma/enums.js';
import type { Queryable } from '../../core/db/transaction.js';
import { AppError, type ErrorDetail } from '../../core/errors/AppError.js';
import { addMinutes } from '../../lib/time.js';
import {
  DEFAULT_LOW_STOCK_THRESHOLD,
  LOW_STOCK_SETTING_KEY,
  available,
  effectiveThreshold,
  evaluateLowStock,
} from './inventory.rules.js';

export interface LockedInventory {
  readonly variantId: string;
  onHand: number;
  reserved: number;
  readonly lowStockThreshold: number | null;
  readonly lowStockAlertedAt: Date | null;
}

interface WorkingRow extends LockedInventory {
  readonly onHandBefore: number;
  readonly reservedBefore: number;
  changed: boolean;
}

export interface StockLine {
  readonly variantId: string;
  readonly quantity: number;
  /** Optional, echoed in INSUFFICIENT_STOCK details. */
  readonly sku?: string | undefined;
}

export interface StockOptions {
  /** Staff user for ledger `created_by_id` (`null`/absent = SYSTEM). */
  readonly actorUserId?: string | null | undefined;
}

export type ReleaseReason = 'PAYMENT_FAILED' | 'EXPIRED' | 'CANCELLED' | 'RETRY_REPLACED';

export interface LowStockCrossing {
  readonly variantId: string;
  readonly available: number;
  readonly threshold: number;
}

export interface LedgerEntry {
  readonly id: string;
  readonly variantId: string;
  readonly type: InventoryTxnType;
  readonly onHandDelta: number;
  readonly reservedDelta: number;
  readonly onHandBefore: number;
  readonly onHandAfter: number;
  readonly reservedAfter: number;
}

export interface StockOutcome {
  readonly ledger: readonly LedgerEntry[];
  readonly lowStock: readonly LowStockCrossing[];
}

export interface ReservationOutcome extends StockOutcome {
  readonly reservations: readonly {
    id: string;
    variantId: string;
    quantity: number;
    expiresAt: Date;
  }[];
}

export interface LedgerExtras {
  readonly reasonCode?: string | null;
  readonly note?: string | null;
  readonly unitCost?: Prisma.Decimal | string | null;
  readonly orderId?: string | null;
  readonly stockReservationId?: string | null;
  readonly batchId?: string | null;
}

interface RawInventoryRow {
  variantId: string;
  onHand: number | bigint | string;
  reserved: number | bigint | string;
  lowStockThreshold: number | bigint | string | null;
  lowStockAlertedAt: Date | string | null;
}

const toInt = (value: number | bigint | string): number => Number(value);

/**
 * Locks inventory rows (ascending variant id, `FOR UPDATE`). With `createMissing`, rows absent
 * for an existing variant are inserted at zero (first stock-in) — insertion happens AFTER the
 * locking read so no shared lock is upgraded.
 */
export async function lockInventoryRows(
  tx: Queryable,
  variantIds: readonly string[],
  options: { createMissing?: boolean } = {},
): Promise<Map<string, LockedInventory>> {
  const ids = [...new Set(variantIds)].sort();
  const out = new Map<string, LockedInventory>();
  if (ids.length === 0) return out;
  const rows = await tx.$queryRaw<RawInventoryRow[]>(Prisma.sql`
    SELECT variant_id AS variantId, quantity_on_hand AS onHand, quantity_reserved AS reserved,
           low_stock_threshold AS lowStockThreshold, low_stock_alerted_at AS lowStockAlertedAt
    FROM inventory
    WHERE variant_id IN (${Prisma.join(ids)})
    ORDER BY variant_id ASC
    FOR UPDATE`);
  for (const row of rows) {
    out.set(row.variantId, {
      variantId: row.variantId,
      onHand: toInt(row.onHand),
      reserved: toInt(row.reserved),
      lowStockThreshold: row.lowStockThreshold === null ? null : toInt(row.lowStockThreshold),
      lowStockAlertedAt: row.lowStockAlertedAt === null ? null : new Date(row.lowStockAlertedAt),
    });
  }
  if (options.createMissing === true) {
    for (const variantId of ids) {
      if (out.has(variantId)) continue;
      await tx.inventory.create({ data: { variantId }, select: { variantId: true } });
      out.set(variantId, {
        variantId,
        onHand: 0,
        reserved: 0,
        lowStockThreshold: null,
        lowStockAlertedAt: null,
      });
    }
  }
  return out;
}

/** Global low-stock default from `settings` (PROVISIONAL OQ-47: 5). */
export async function loadLowStockDefault(db: Queryable): Promise<number> {
  const row = await db.setting.findUnique({
    where: { settingKey: LOW_STOCK_SETTING_KEY },
    select: { value: true },
  });
  const value = row?.value;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : DEFAULT_LOW_STOCK_THRESHOLD;
}

/** Recomputes `products.is_in_stock` for the products owning these variants. */
export async function refreshProductStockFlags(
  tx: Queryable,
  variantIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(variantIds)];
  if (ids.length === 0) return;
  await tx.$executeRaw(Prisma.sql`
    UPDATE products p
    SET p.is_in_stock = EXISTS (
      SELECT 1 FROM product_variants v JOIN inventory i ON i.variant_id = v.id
      WHERE v.product_id = p.id AND v.status = 'ACTIVE' AND v.deleted_at IS NULL
        AND i.quantity_on_hand > i.quantity_reserved)
    WHERE p.id IN (SELECT v2.product_id FROM product_variants v2 WHERE v2.id IN (${Prisma.join(ids)}))`);
}

/**
 * A unit of stock work inside one transaction: lock → mutate in memory → `flush` (inventory
 * updates, ledger rows, low-stock state, product flags).
 */
export class StockWorkbench {
  private readonly rows: Map<string, WorkingRow>;
  private readonly ledger: (LedgerEntry & LedgerExtras)[] = [];

  private constructor(
    private readonly tx: Queryable,
    locked: Map<string, LockedInventory>,
    private readonly now: Date,
    private readonly actorUserId: string | null,
  ) {
    this.rows = new Map(
      [...locked.entries()].map(([id, r]) => [
        id,
        { ...r, onHandBefore: r.onHand, reservedBefore: r.reserved, changed: false },
      ]),
    );
  }

  static async open(
    tx: Queryable,
    variantIds: readonly string[],
    now: Date,
    options: StockOptions & { createMissing?: boolean } = {},
  ): Promise<StockWorkbench> {
    const locked = await lockInventoryRows(tx, variantIds, {
      createMissing: options.createMissing ?? false,
    });
    return new StockWorkbench(tx, locked, now, options.actorUserId ?? null);
  }

  get(variantId: string): Readonly<WorkingRow> | undefined {
    return this.rows.get(variantId);
  }

  availableOf(variantId: string): number {
    const row = this.rows.get(variantId);
    return row === undefined ? 0 : available(row.onHand, row.reserved);
  }

  /** Applies deltas, enforcing `0 ≤ reserved ≤ on_hand`; returns the ledger entry. */
  apply(
    variantId: string,
    type: InventoryTxnType,
    onHandDelta: number,
    reservedDelta: number,
    extras: LedgerExtras = {},
  ): LedgerEntry {
    const row = this.rows.get(variantId);
    if (row === undefined) {
      throw new AppError('CONFLICT', 'Inventory record missing for variant.', {
        details: [{ code: 'INVENTORY_MISSING', message: 'No inventory row.', meta: { variantId } }],
      });
    }
    const onHandAfter = row.onHand + onHandDelta;
    const reservedAfter = row.reserved + reservedDelta;
    if (onHandAfter < 0 || reservedAfter < 0 || reservedAfter > onHandAfter) {
      throw new AppError('CONFLICT', 'Inventory invariant would be violated.', {
        details: [
          {
            code: 'INVENTORY_INVARIANT',
            message: 'on_hand ≥ reserved ≥ 0 must hold.',
            meta: { variantId, onHand: row.onHand, reserved: row.reserved, type },
          },
        ],
      });
    }
    const entry = {
      id: randomUUID(),
      variantId,
      type,
      onHandDelta,
      reservedDelta,
      onHandBefore: row.onHand,
      onHandAfter,
      reservedAfter,
      ...extras,
    };
    row.onHand = onHandAfter;
    row.reserved = reservedAfter;
    row.changed = true;
    this.ledger.push(entry);
    return entry;
  }

  async flush(): Promise<StockOutcome> {
    const changed = [...this.rows.values()].filter((r) => r.changed);
    if (changed.length === 0) return { ledger: [], lowStock: [] };
    const globalDefault = await loadLowStockDefault(this.tx);
    const lowStock: LowStockCrossing[] = [];
    for (const row of changed) {
      const threshold = effectiveThreshold(row.lowStockThreshold, globalDefault);
      const avail = available(row.onHand, row.reserved);
      const evaluation = evaluateLowStock(avail, threshold, row.lowStockAlertedAt, this.now);
      if (evaluation.crossed)
        lowStock.push({ variantId: row.variantId, available: avail, threshold });
      await this.tx.inventory.update({
        where: { variantId: row.variantId },
        data: {
          quantityOnHand: row.onHand,
          quantityReserved: row.reserved,
          lastMovementAt: this.now,
          version: { increment: 1 },
          ...(this.actorUserId === null ? {} : { updatedById: this.actorUserId }),
          ...(evaluation.alertedAt === undefined
            ? {}
            : { lowStockAlertedAt: evaluation.alertedAt }),
        },
      });
    }
    await this.tx.inventoryTransaction.createMany({
      data: this.ledger.map((e) => ({
        id: e.id,
        variantId: e.variantId,
        type: e.type,
        onHandDelta: e.onHandDelta,
        reservedDelta: e.reservedDelta,
        onHandAfter: e.onHandAfter,
        reservedAfter: e.reservedAfter,
        reasonCode: e.reasonCode ?? null,
        note: e.note ?? null,
        unitCost: e.unitCost ?? null,
        orderId: e.orderId ?? null,
        stockReservationId: e.stockReservationId ?? null,
        batchId: e.batchId ?? null,
        createdById: this.actorUserId,
        createdAt: this.now,
      })),
    });
    await refreshProductStockFlags(
      this.tx,
      changed.map((r) => r.variantId),
    );
    return {
      ledger: this.ledger.map(
        ({
          id,
          variantId,
          type,
          onHandDelta,
          reservedDelta,
          onHandBefore,
          onHandAfter,
          reservedAfter,
        }) => ({
          id,
          variantId,
          type,
          onHandDelta,
          reservedDelta,
          onHandBefore,
          onHandAfter,
          reservedAfter,
        }),
      ),
      lowStock,
    };
  }
}

function insufficient(details: ErrorDetail[]): AppError {
  return new AppError('INSUFFICIENT_STOCK', 'The requested quantity is not available.', {
    details,
  });
}

function mergeLines(lines: readonly StockLine[]): StockLine[] {
  const merged = new Map<string, StockLine>();
  for (const line of lines) {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new AppError('VALIDATION_ERROR', undefined, {
        details: [{ field: 'quantity', message: 'Quantity must be a positive integer.' }],
      });
    }
    const prev = merged.get(line.variantId);
    merged.set(line.variantId, {
      variantId: line.variantId,
      quantity: (prev?.quantity ?? 0) + line.quantity,
      sku: line.sku ?? prev?.sku,
    });
  }
  return [...merged.values()].sort((a, b) => (a.variantId < b.variantId ? -1 : 1));
}

function checkAvailability(bench: StockWorkbench, lines: readonly StockLine[]): void {
  const details: ErrorDetail[] = [];
  for (const line of lines) {
    const avail = bench.availableOf(line.variantId);
    if (line.quantity > avail) {
      details.push({
        field: 'quantity',
        code: 'INSUFFICIENT_STOCK',
        message: 'Requested quantity exceeds available stock.',
        meta: {
          variantId: line.variantId,
          ...(line.sku === undefined ? {} : { sku: line.sku }),
          requested: line.quantity,
          available: Math.max(0, avail),
        },
      });
    }
  }
  if (details.length > 0) throw insufficient(details);
}

export interface InventoryServiceDeps {
  readonly clock: () => Date;
  /** `config.integrations.reservationTtlMinutes` (PROVISIONAL OQ-17). */
  readonly reservationTtlMinutes: number;
}

/** Public stock API for checkout, payments, cancellations (all inside the caller's tx). */
export interface InventoryService {
  /** `now + TTL` for new reservations. */
  reservationExpiry(now?: Date): Date;
  /** ONLINE placement: reserve stock (ACTIVE reservations + RESERVATION ledger rows). */
  reserve(
    tx: Queryable,
    lines: readonly StockLine[],
    orderId: string,
    expiresAt: Date,
    options?: StockOptions,
  ): Promise<ReservationOutcome>;
  /** Payment captured: ACTIVE → COMMITTED, on_hand −q, reserved −q (ORDER_DEDUCTION). Idempotent. */
  commitReservation(tx: Queryable, orderId: string, options?: StockOptions): Promise<StockOutcome>;
  /** Payment failed / expiry / cancel before capture: ACTIVE → RELEASED|EXPIRED. Idempotent. */
  releaseReservation(
    tx: Queryable,
    orderId: string,
    reason: ReleaseReason,
    options?: StockOptions,
  ): Promise<StockOutcome>;
  /** Cancellation: release ACTIVE reservations and restore net deducted quantities. Idempotent. */
  restoreCancellation(
    tx: Queryable,
    orderId: string,
    options?: StockOptions,
  ): Promise<StockOutcome>;
  /** COD placement / late capture without reservation: on_hand −q (ORDER_DEDUCTION). */
  deductDirect(
    tx: Queryable,
    lines: readonly StockLine[],
    orderId: string,
    options?: StockOptions,
  ): Promise<StockOutcome>;
}

export function createInventoryService(deps: InventoryServiceDeps): InventoryService {
  const { clock } = deps;

  async function activeReservations(tx: Queryable, orderId: string) {
    return tx.stockReservation.findMany({
      where: { orderId, status: 'ACTIVE' },
      select: { id: true, variantId: true, quantity: true },
      orderBy: { variantId: 'asc' },
    });
  }

  async function releaseWith(
    tx: Queryable,
    bench: StockWorkbench,
    reservations: readonly { id: string; variantId: string; quantity: number }[],
    orderId: string,
    reason: ReleaseReason,
    now: Date,
  ): Promise<void> {
    for (const r of reservations) {
      const result = await tx.stockReservation.updateMany({
        where: { id: r.id, status: 'ACTIVE' },
        data: {
          status: reason === 'EXPIRED' ? 'EXPIRED' : 'RELEASED',
          releasedAt: now,
          releaseReason: reason,
        },
      });
      if (result.count === 0) continue; // concurrently handled
      bench.apply(r.variantId, 'RESERVATION_RELEASE', 0, -r.quantity, {
        orderId,
        stockReservationId: r.id,
        reasonCode: reason,
      });
    }
  }

  return {
    reservationExpiry(now = clock()) {
      return addMinutes(now, deps.reservationTtlMinutes);
    },

    async reserve(tx, lines, orderId, expiresAt, options = {}) {
      const merged = mergeLines(lines);
      const now = clock();
      const existing = await tx.stockReservation.findMany({
        where: { orderId, variantId: { in: merged.map((l) => l.variantId) } },
        select: { id: true, variantId: true, status: true },
      });
      const active = existing.filter((e) => e.status === 'ACTIVE');
      if (active.length > 0) {
        throw new AppError('CONFLICT', 'Stock is already reserved for this order.', {
          details: active.map((a) => ({
            code: 'ALREADY_RESERVED',
            message: 'Active reservation exists.',
            meta: { variantId: a.variantId },
          })),
        });
      }
      const bench = await StockWorkbench.open(
        tx,
        merged.map((l) => l.variantId),
        now,
        options,
      );
      checkAvailability(bench, merged);

      const previous = new Map(existing.map((e) => [e.variantId, e.id]));
      const reservations: ReservationOutcome['reservations'][number][] = [];
      for (const line of merged) {
        const prevId = previous.get(line.variantId);
        let id: string;
        if (prevId === undefined) {
          id = randomUUID();
          await tx.stockReservation.create({
            data: {
              id,
              orderId,
              variantId: line.variantId,
              quantity: line.quantity,
              status: 'ACTIVE',
              expiresAt,
            },
          });
        } else {
          // Payment retry re-activates the (orderId, variantId) row (unique key) — OQ-58.
          id = prevId;
          await tx.stockReservation.update({
            where: { id },
            data: {
              quantity: line.quantity,
              status: 'ACTIVE',
              expiresAt,
              committedAt: null,
              releasedAt: null,
              releaseReason: null,
            },
          });
        }
        bench.apply(line.variantId, 'RESERVATION', 0, line.quantity, {
          orderId,
          stockReservationId: id,
        });
        reservations.push({ id, variantId: line.variantId, quantity: line.quantity, expiresAt });
      }
      const outcome = await bench.flush();
      return { ...outcome, reservations };
    },

    async commitReservation(tx, orderId, options = {}) {
      const now = clock();
      const reservations = await activeReservations(tx, orderId);
      if (reservations.length === 0) return { ledger: [], lowStock: [] };
      const bench = await StockWorkbench.open(
        tx,
        reservations.map((r) => r.variantId),
        now,
        options,
      );
      for (const r of reservations) {
        const result = await tx.stockReservation.updateMany({
          where: { id: r.id, status: 'ACTIVE' },
          data: { status: 'COMMITTED', committedAt: now },
        });
        if (result.count === 0) continue;
        bench.apply(r.variantId, 'ORDER_DEDUCTION', -r.quantity, -r.quantity, {
          orderId,
          stockReservationId: r.id,
        });
      }
      return bench.flush();
    },

    async releaseReservation(tx, orderId, reason, options = {}) {
      const now = clock();
      const reservations = await activeReservations(tx, orderId);
      if (reservations.length === 0) return { ledger: [], lowStock: [] };
      const bench = await StockWorkbench.open(
        tx,
        reservations.map((r) => r.variantId),
        now,
        options,
      );
      await releaseWith(tx, bench, reservations, orderId, reason, now);
      return bench.flush();
    },

    async restoreCancellation(tx, orderId, options = {}) {
      const now = clock();
      const [reservations, movements] = await Promise.all([
        activeReservations(tx, orderId),
        tx.inventoryTransaction.findMany({
          where: { orderId, type: { in: ['ORDER_DEDUCTION', 'CANCELLATION_RESTORE'] } },
          select: { variantId: true, type: true, onHandDelta: true },
        }),
      ]);
      // Net quantity deducted and not yet restored, per variant (never restores more).
      const net = new Map<string, number>();
      for (const m of movements) net.set(m.variantId, (net.get(m.variantId) ?? 0) - m.onHandDelta);
      const toRestore = [...net.entries()].filter(([, qty]) => qty > 0);
      if (reservations.length === 0 && toRestore.length === 0) return { ledger: [], lowStock: [] };

      const bench = await StockWorkbench.open(
        tx,
        [...reservations.map((r) => r.variantId), ...toRestore.map(([id]) => id)],
        now,
        options,
      );
      await releaseWith(tx, bench, reservations, orderId, 'CANCELLED', now);
      for (const [variantId, qty] of toRestore) {
        bench.apply(variantId, 'CANCELLATION_RESTORE', qty, 0, { orderId });
      }
      return bench.flush();
    },

    async deductDirect(tx, lines, orderId, options = {}) {
      const merged = mergeLines(lines);
      const bench = await StockWorkbench.open(
        tx,
        merged.map((l) => l.variantId),
        clock(),
        options,
      );
      checkAvailability(bench, merged);
      for (const line of merged) {
        bench.apply(line.variantId, 'ORDER_DEDUCTION', -line.quantity, 0, { orderId });
      }
      return bench.flush();
    },
  };
}

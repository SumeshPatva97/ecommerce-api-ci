/**
 * Admin inventory use-cases — API_DOCUMENTATION.md §4.5, PRODUCT_VARIANT_AND_INVENTORY_WORKFLOWS
 * §13, §15–§17. Stock mutations go through `StockWorkbench` (row locks, invariants, ledger).
 */
import { randomUUID } from 'node:crypto';

import { Prisma } from '../../generated/prisma/client.js';
import type { DbClient } from '../../core/db/transaction.js';
import { withTransaction } from '../../core/db/transaction.js';
import { AppError, type ErrorDetail } from '../../core/errors/AppError.js';
import type { Logger } from '../../core/logger/logger.js';
import { toSkipTake } from '../../core/http/pagination.js';
import { dec, toMoneyString } from '../../lib/money.js';
import { istDayRange } from '../../lib/time.js';
import type { AuditActor, AuditService } from '../audit/audit.service.js';
import {
  available,
  decodeNote,
  effectiveThreshold,
  encodeNote,
  escapeLike,
  isDecrease,
  isLowStock,
  maxRemovable,
  onHandDeltaFor,
} from './inventory.rules.js';
import type { ListInventoryInput, MovementInput, TransactionsInput } from './inventory.schemas.js';
import { StockWorkbench, loadLowStockDefault, type LowStockCrossing } from './inventory.stock.js';

export interface InventoryAdminDeps {
  readonly db: DbClient;
  readonly audit: AuditService;
  readonly clock: () => Date;
  readonly logger: Logger;
  /** LOW_STOCK_ALERT delivery (inventory.alerts.ts); called after the movement has committed. */
  readonly notifyLowStock?: (crossings: readonly LowStockCrossing[]) => Promise<number>;
}

type Dto = Record<string, unknown>;

export interface InventoryAdminService {
  list(
    query: ListInventoryInput,
    options: { includeCost: boolean },
  ): Promise<{ items: Dto[]; total: number }>;
  lookup(code: string): Promise<Dto>;
  recordMovement(actor: AuditActor, input: MovementInput): Promise<Dto>;
  transactions(
    variantId: string,
    query: TransactionsInput,
  ): Promise<{ items: Dto[]; total: number }>;
  updateThreshold(actor: AuditActor, variantId: string, threshold: number | null): Promise<Dto>;
}

interface ListRow {
  variantId: string;
  sku: string;
  barcode: string | null;
  variantName: string;
  status: string;
  productId: string;
  productName: string;
  costPrice: unknown;
  onHand: number | bigint | string;
  reserved: number | bigint | string;
  lowStockThreshold: number | bigint | string | null;
  updatedAt: Date | string | null;
}

const int = (v: number | bigint | string): number => Number(v);

function toDecimal(value: unknown): Prisma.Decimal | null {
  if (value instanceof Prisma.Decimal) return value;
  if (typeof value === 'string' || typeof value === 'number') return dec(value);
  return null;
}

function inventoryBlock(
  onHand: number,
  reserved: number,
  override: number | null,
  globalDefault: number,
): Dto {
  const avail = available(onHand, reserved);
  const threshold = effectiveThreshold(override, globalDefault);
  return {
    onHand,
    reserved,
    available: avail,
    lowStockThreshold: override,
    effectiveThreshold: threshold,
    isLowStock: isLowStock(avail, threshold),
  };
}

function userName(user: { firstName: string; lastName: string | null } | undefined): string | null {
  if (user === undefined) return null;
  return user.lastName === null ? user.firstName : `${user.firstName} ${user.lastName}`;
}

export function createInventoryAdminService(deps: InventoryAdminDeps): InventoryAdminService {
  const { db, audit, clock, logger } = deps;

  async function requireVariant(variantId: string): Promise<{ id: string; sku: string }> {
    const variant = await db.productVariant.findFirst({
      where: { id: variantId, deletedAt: null },
      select: { id: true, sku: true },
    });
    if (variant === null) throw new AppError('NOT_FOUND', 'Variant not found.');
    return variant;
  }

  function logLowStock(crossings: readonly LowStockCrossing[]): void {
    // One crossing per new low-stock episode (inventory.low_stock_alerted_at, OQ-47). Logged, then
    // delivered as LOW_STOCK_ALERT by the notifications module; delivery failure never fails the movement.
    for (const c of crossings) logger.info({ event: 'LOW_STOCK_ALERT', ...c }, 'low stock');
    if (crossings.length > 0 && deps.notifyLowStock !== undefined) {
      deps.notifyLowStock(crossings).catch((error: unknown) => {
        logger.error({ err: error }, 'low stock alert could not be queued');
      });
    }
  }

  return {
    async list(query, options) {
      const globalDefault = await loadLowStockDefault(db);
      const avail = Prisma.sql`(COALESCE(i.quantity_on_hand, 0) - COALESCE(i.quantity_reserved, 0))`;
      const threshold = Prisma.sql`COALESCE(i.low_stock_threshold, ${globalDefault})`;
      const conditions: Prisma.Sql[] = [
        Prisma.sql`v.deleted_at IS NULL`,
        Prisma.sql`p.deleted_at IS NULL`,
      ];
      if (query.sku !== undefined) {
        conditions.push(Prisma.sql`v.sku LIKE ${`${escapeLike(query.sku)}%`}`);
      }
      if (query.q !== undefined) {
        const like = `%${escapeLike(query.q)}%`;
        conditions.push(
          Prisma.sql`(p.name LIKE ${like} OR v.name LIKE ${like} OR v.sku LIKE ${`${escapeLike(query.q.toUpperCase())}%`} OR v.barcode = ${query.q.toUpperCase()})`,
        );
      }
      if (query.categoryId !== undefined)
        conditions.push(Prisma.sql`p.category_id = ${query.categoryId}`);
      if (query.brandId !== undefined) conditions.push(Prisma.sql`p.brand_id = ${query.brandId}`);
      if (query.lowStock === true) conditions.push(Prisma.sql`${avail} <= ${threshold}`);
      if (query.stock === 'out_of_stock') conditions.push(Prisma.sql`${avail} <= 0`);
      if (query.stock === 'low_stock') {
        conditions.push(Prisma.sql`${avail} > 0 AND ${avail} <= ${threshold}`);
      }
      if (query.stock === 'in_stock') conditions.push(Prisma.sql`${avail} > 0`);
      const where = Prisma.join(conditions, ' AND ');
      const orderBy =
        query.sort === 'available'
          ? Prisma.sql`${avail} ASC, v.sku ASC`
          : query.sort === '-available'
            ? Prisma.sql`${avail} DESC, v.sku ASC`
            : query.sort === '-sku'
              ? Prisma.sql`v.sku DESC`
              : Prisma.sql`v.sku ASC`;
      const { skip, take } = toSkipTake(query.page, query.limit);
      const from = Prisma.sql`FROM product_variants v
        JOIN products p ON p.id = v.product_id
        LEFT JOIN inventory i ON i.variant_id = v.id`;
      const [rows, counts] = await Promise.all([
        db.$queryRaw<ListRow[]>(Prisma.sql`
          SELECT v.id AS variantId, v.sku AS sku, v.barcode AS barcode, v.name AS variantName,
                 v.status AS status, p.id AS productId, p.name AS productName,
                 v.cost_price AS costPrice,
                 COALESCE(i.quantity_on_hand, 0) AS onHand, COALESCE(i.quantity_reserved, 0) AS reserved,
                 i.low_stock_threshold AS lowStockThreshold, i.updated_at AS updatedAt
          ${from} WHERE ${where} ORDER BY ${orderBy} LIMIT ${take} OFFSET ${skip}`),
        db.$queryRaw<{ total: number | bigint }[]>(
          Prisma.sql`SELECT COUNT(*) AS total ${from} WHERE ${where}`,
        ),
      ]);
      const items = rows.map((row) => {
        const onHand = int(row.onHand);
        const override = row.lowStockThreshold === null ? null : int(row.lowStockThreshold);
        const block = inventoryBlock(onHand, int(row.reserved), override, globalDefault);
        const cost = toDecimal(row.costPrice);
        return {
          variantId: row.variantId,
          sku: row.sku,
          barcode: row.barcode,
          productId: row.productId,
          productName: row.productName,
          variantName: row.variantName,
          status: row.status,
          ...block,
          ...(options.includeCost
            ? {
                costPrice: cost === null ? null : toMoneyString(cost),
                stockValue: cost === null ? null : toMoneyString(cost.times(onHand)),
              }
            : {}),
          updatedAt: row.updatedAt === null ? null : new Date(row.updatedAt).toISOString(),
        };
      });
      return { items, total: Number(counts[0]?.total ?? 0) };
    },

    async lookup(code) {
      const variant = await db.productVariant.findFirst({
        where: { deletedAt: null, OR: [{ sku: code }, { barcode: code }] },
        select: {
          id: true,
          sku: true,
          barcode: true,
          name: true,
          status: true,
          productId: true,
          product: {
            select: {
              id: true,
              name: true,
              status: true,
              images: {
                where: { variantId: null },
                orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }],
                take: 1,
                select: { url: true },
              },
            },
          },
          images: { orderBy: { sortOrder: 'asc' }, take: 1, select: { url: true } },
          inventory: {
            select: { quantityOnHand: true, quantityReserved: true, lowStockThreshold: true },
          },
        },
      });
      if (variant === null)
        throw new AppError('NOT_FOUND', 'No variant matches this SKU or barcode.');
      const [globalDefault, recent] = await Promise.all([
        loadLowStockDefault(db),
        db.inventoryTransaction.findMany({
          where: { variantId: variant.id },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 5,
          select: {
            id: true,
            type: true,
            onHandDelta: true,
            reservedDelta: true,
            onHandAfter: true,
            reservedAfter: true,
            createdAt: true,
          },
        }),
      ]);
      const inv = variant.inventory;
      return {
        variantId: variant.id,
        sku: variant.sku,
        barcode: variant.barcode,
        productId: variant.productId,
        productName: variant.product.name,
        productStatus: variant.product.status,
        variantName: variant.name,
        status: variant.status,
        imageUrl: variant.images[0]?.url ?? variant.product.images[0]?.url ?? null,
        inventory: inventoryBlock(
          inv?.quantityOnHand ?? 0,
          inv?.quantityReserved ?? 0,
          inv?.lowStockThreshold ?? null,
          globalDefault,
        ),
        recentTransactions: recent.map((t) => ({
          id: t.id,
          type: t.type,
          quantity: t.onHandDelta === 0 ? t.reservedDelta : t.onHandDelta,
          onHandAfter: t.onHandAfter,
          reservedAfter: t.reservedAfter,
          createdAt: t.createdAt.toISOString(),
        })),
      };
    },

    async recordMovement(actor, input) {
      // 1. Resolve items → variants (each variant once).
      const ids = input.items.map((i) => i.variantId).filter((v): v is string => v !== undefined);
      const skus = input.items.map((i) => i.sku).filter((s): s is string => s !== undefined);
      const variants = await db.productVariant.findMany({
        where: {
          deletedAt: null,
          OR: [
            ...(ids.length > 0 ? [{ id: { in: ids } }] : []),
            ...(skus.length > 0 ? [{ sku: { in: skus } }] : []),
          ],
        },
        select: { id: true, sku: true },
      });
      const byId = new Map(variants.map((v) => [v.id, v]));
      const bySku = new Map(variants.map((v) => [v.sku, v]));
      const details: ErrorDetail[] = [];
      const seen = new Set<string>();
      const lines = input.items.map((item, index) => {
        const variant =
          item.variantId !== undefined ? byId.get(item.variantId) : bySku.get(item.sku ?? '');
        if (variant === undefined) {
          details.push({
            field: `items[${String(index)}].${item.variantId === undefined ? 'sku' : 'variantId'}`,
            message: 'Variant not found.',
          });
          return undefined;
        }
        if (seen.has(variant.id)) {
          details.push({
            field: `items[${String(index)}]`,
            message: 'Each variant may appear only once per movement.',
          });
        }
        seen.add(variant.id);
        return { index, variant, quantity: item.quantity, unitCost: item.unitCost };
      });
      if (details.length > 0) throw new AppError('VALIDATION_ERROR', undefined, { details });
      const resolved = lines.filter((l): l is NonNullable<typeof l> => l !== undefined);

      const movementGroupId = randomUUID();
      const note = encodeNote(input.note, input.reference);
      const now = clock();

      const result = await withTransaction(
        db,
        async ({ tx }) => {
          // 2. Lock rows ascending (inside StockWorkbench), check, apply.
          const bench = await StockWorkbench.open(
            tx,
            resolved.map((l) => l.variant.id),
            now,
            { actorUserId: actor.userId ?? null, createMissing: true },
          );
          if (isDecrease(input.type)) {
            const short: ErrorDetail[] = [];
            for (const line of resolved) {
              const row = bench.get(line.variant.id);
              const onHand = row?.onHand ?? 0;
              const reserved = row?.reserved ?? 0;
              const removable = maxRemovable(onHand, reserved);
              if (line.quantity > removable) {
                short.push({
                  field: `items[${String(line.index)}].quantity`,
                  code: 'INSUFFICIENT_STOCK',
                  message: `Cannot remove ${String(line.quantity)} units of ${line.variant.sku}: only ${String(removable)} are unreserved.`,
                  meta: {
                    variantId: line.variant.id,
                    sku: line.variant.sku,
                    onHand,
                    reserved,
                    requested: line.quantity,
                    maxRemovable: removable,
                  },
                });
              }
            }
            if (short.length > 0) {
              throw new AppError('INSUFFICIENT_STOCK', short[0]?.message, { details: short });
            }
          }
          const entries = resolved.map((line) => ({
            line,
            entry: bench.apply(
              line.variant.id,
              input.type,
              onHandDeltaFor(input.type, line.quantity),
              0,
              {
                reasonCode: input.reasonCode,
                note,
                unitCost: line.unitCost ?? null,
                batchId: movementGroupId,
              },
            ),
          }));
          const outcome = await bench.flush();
          for (const { line, entry } of entries) {
            await audit.record(tx, actor, {
              action: 'STOCK_ADJUST',
              module: 'inventory',
              entityType: 'Inventory',
              entityId: line.variant.id,
              before: { quantityOnHand: entry.onHandBefore },
              after: { quantityOnHand: entry.onHandAfter },
              metadata: {
                entityLabel: line.variant.sku,
                movementGroupId,
                type: input.type,
                reasonCode: input.reasonCode,
                quantity: line.quantity,
                reference: input.reference ?? null,
                ledgerId: entry.id,
              },
            });
          }
          const user =
            actor.userId === undefined
              ? null
              : await tx.user.findUnique({
                  where: { id: actor.userId },
                  select: { firstName: true, lastName: true },
                });
          return { entries, outcome, user };
        },
        { retryOnDeadlock: true },
      );
      logLowStock(result.outcome.lowStock);

      return {
        movementGroupId,
        type: input.type,
        reasonCode: input.reasonCode,
        reference: input.reference ?? null,
        transactions: result.entries.map(({ line, entry }) => ({
          id: entry.id,
          variantId: line.variant.id,
          sku: line.variant.sku,
          quantity: line.quantity,
          onHandBefore: entry.onHandBefore,
          onHandAfter: entry.onHandAfter,
          reservedAfter: entry.reservedAfter,
          availableAfter: available(entry.onHandAfter, entry.reservedAfter),
        })),
        lowStock: result.outcome.lowStock,
        createdAt: now.toISOString(),
        createdBy:
          actor.userId === undefined
            ? null
            : { id: actor.userId, name: userName(result.user ?? undefined) },
      };
    },

    async transactions(variantId, query) {
      await requireVariant(variantId);
      const createdAt: { gte?: Date; lt?: Date } = {};
      if (query.from !== undefined) createdAt.gte = istDayRange(query.from).start;
      if (query.to !== undefined) createdAt.lt = istDayRange(query.to).end;
      const where = {
        variantId,
        ...(query.type === undefined ? {} : { type: { in: query.type } }),
        ...(query.actorId === undefined ? {} : { createdById: query.actorId }),
        ...(Object.keys(createdAt).length === 0 ? {} : { createdAt }),
      };
      const [rows, total] = await Promise.all([
        db.inventoryTransaction.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          ...toSkipTake(query.page, query.limit),
          select: {
            id: true,
            type: true,
            onHandDelta: true,
            reservedDelta: true,
            onHandAfter: true,
            reservedAfter: true,
            reasonCode: true,
            note: true,
            unitCost: true,
            batchId: true,
            createdById: true,
            createdAt: true,
            order: { select: { orderNumber: true } },
          },
        }),
        db.inventoryTransaction.count({ where }),
      ]);
      const userIds = [
        ...new Set(rows.map((r) => r.createdById).filter((id): id is string => id !== null)),
      ];
      const users =
        userIds.length === 0
          ? []
          : await db.user.findMany({
              where: { id: { in: userIds } },
              select: { id: true, firstName: true, lastName: true },
            });
      const userById = new Map(users.map((u) => [u.id, u]));
      const items = rows.map((r) => {
        const { note, reference } = decodeNote(r.note);
        return {
          id: r.id,
          type: r.type,
          quantity: r.onHandDelta === 0 ? r.reservedDelta : r.onHandDelta,
          onHandDelta: r.onHandDelta,
          reservedDelta: r.reservedDelta,
          onHandAfter: r.onHandAfter,
          reservedAfter: r.reservedAfter,
          reasonCode: r.reasonCode,
          note,
          reference,
          unitCost: r.unitCost === null ? null : toMoneyString(r.unitCost),
          movementGroupId: r.batchId,
          orderNumber: r.order?.orderNumber ?? null,
          createdAt: r.createdAt.toISOString(),
          createdBy:
            r.createdById === null
              ? 'SYSTEM'
              : { id: r.createdById, name: userName(userById.get(r.createdById)) },
        };
      });
      return { items, total };
    },

    async updateThreshold(actor, variantId, threshold) {
      const variant = await requireVariant(variantId);
      return withTransaction(db, async ({ tx }) => {
        const before = await tx.inventory.findUnique({
          where: { variantId },
          select: { lowStockThreshold: true },
        });
        const row = await tx.inventory.upsert({
          where: { variantId },
          create: { variantId, lowStockThreshold: threshold, updatedById: actor.userId ?? null },
          // A new threshold starts a fresh low-stock episode (re-armed alert).
          update: {
            lowStockThreshold: threshold,
            lowStockAlertedAt: null,
            updatedById: actor.userId ?? null,
          },
          select: {
            quantityOnHand: true,
            quantityReserved: true,
            lowStockThreshold: true,
            updatedAt: true,
          },
        });
        await audit.record(tx, actor, {
          action: 'UPDATE',
          module: 'inventory',
          entityType: 'Inventory',
          entityId: variantId,
          before: { lowStockThreshold: before?.lowStockThreshold ?? null },
          after: { lowStockThreshold: threshold },
          metadata: { entityLabel: variant.sku },
        });
        const globalDefault = await loadLowStockDefault(tx);
        return {
          variantId,
          sku: variant.sku,
          ...inventoryBlock(
            row.quantityOnHand,
            row.quantityReserved,
            row.lowStockThreshold,
            globalDefault,
          ),
          updatedAt: row.updatedAt.toISOString(),
        };
      });
    },
  };
}

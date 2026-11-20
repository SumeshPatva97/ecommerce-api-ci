/**
 * Pure cart rules — API_DOCUMENTATION.md §3.4 (line issues, availability, merge rule R-04) and the
 * error shapes of §2.3 (`INSUFFICIENT_STOCK`, `MAX_QTY_PER_LINE`).
 *
 * PROVISIONAL (OQ-57): `checkout.max_qty_per_line` default 5. PROVISIONAL (OQ-47): low-stock
 * threshold per variant, else 5. PROVISIONAL (OQ-17): adding to cart never reserves stock.
 */
import { AppError } from '../../core/errors/AppError.js';
import type { Decimal } from '../../lib/money.js';
import { toMoneyString } from '../../lib/money.js';

export const DEFAULT_MAX_QTY_PER_LINE = 5;
export const MAX_QTY_SETTING_KEY = 'checkout.max_qty_per_line';

/**
 * RD-08 option B (approved 2026-11-20; USER_WORKFLOWS §9.3, DATABASE_DESIGN §20): an ACTIVE cart
 * idle for `cart.abandon_after_days` (default 30) becomes ABANDONED; ABANDONED carts are purged 90
 * days after `abandoned_at`. The purge period is the approved fixed value (no setting key exists).
 */
export const ABANDON_AFTER_DAYS_SETTING_KEY = 'cart.abandon_after_days';
export const DEFAULT_ABANDON_AFTER_DAYS = 30;
export const MAX_ABANDON_AFTER_DAYS = 365;
export const ABANDONED_CART_PURGE_DAYS = 90;
const DEFAULT_LOW_STOCK_THRESHOLD = 5;

export type AvailabilityStatus = 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK';

export interface LineIssue {
  readonly code:
    | 'OUT_OF_STOCK'
    | 'QUANTITY_REDUCED'
    | 'PRICE_CHANGED'
    | 'VARIANT_UNAVAILABLE'
    | 'PRODUCT_UNAVAILABLE';
  readonly meta?: Record<string, unknown>;
}

export interface CartWarning {
  readonly code: string;
  readonly meta?: Record<string, unknown>;
}

interface InventoryLike {
  readonly quantityOnHand: number;
  readonly quantityReserved: number;
  readonly lowStockThreshold?: number | null;
}

export interface SellableLike {
  readonly status: string;
  readonly deletedAt: Date | null;
  readonly inventory: InventoryLike | null;
  readonly product: {
    readonly status: string;
    readonly deletedAt: Date | null;
    readonly publishedAt: Date | null;
  };
}

/** on_hand − reserved, never negative (OQ-18: no backorders). */
export function availableQuantity(inventory: InventoryLike | null): number {
  if (inventory === null) return 0;
  return Math.max(0, inventory.quantityOnHand - inventory.quantityReserved);
}

export function isProductSellable(p: SellableLike['product'], now: Date): boolean {
  return (
    p.status === 'ACTIVE' &&
    p.deletedAt === null &&
    p.publishedAt !== null &&
    p.publishedAt.getTime() <= now.getTime()
  );
}

export function isVariantSellable(v: SellableLike, now: Date): boolean {
  return v.status === 'ACTIVE' && v.deletedAt === null && isProductSellable(v.product, now);
}

export function availability(
  inventory: InventoryLike | null,
  maxQtyPerLine: number,
): { status: AvailabilityStatus; maxPurchasable: number } {
  const available = availableQuantity(inventory);
  const threshold = inventory?.lowStockThreshold ?? DEFAULT_LOW_STOCK_THRESHOLD;
  const status: AvailabilityStatus =
    available <= 0 ? 'OUT_OF_STOCK' : available <= threshold ? 'LOW_STOCK' : 'IN_STOCK';
  return { status, maxPurchasable: Math.min(available, maxQtyPerLine) };
}

export interface LineState {
  /** Can be priced and checked out (product + variant sellable, stock > 0). */
  readonly purchasable: boolean;
  /** Quantity after an automatic reduction to `maxPurchasable` (equals stored qty otherwise). */
  readonly quantity: number;
  readonly issues: LineIssue[];
}

/**
 * Flags a stored line against the current catalogue. A quantity above what can be bought now is
 * reduced to `maxPurchasable` (reported as `QUANTITY_REDUCED`); unavailable lines are kept and
 * flagged, never silently removed.
 */
export function evaluateLine(
  line: {
    readonly quantity: number;
    readonly unitPriceAtAdd: Decimal;
    readonly variant: SellableLike & { readonly sellingPrice: Decimal };
  },
  now: Date,
  maxQtyPerLine: number,
): LineState {
  const v = line.variant;
  const issues: LineIssue[] = [];
  let purchasable = false;
  let quantity = line.quantity;
  if (!isProductSellable(v.product, now)) issues.push({ code: 'PRODUCT_UNAVAILABLE' });
  else if (v.status !== 'ACTIVE' || v.deletedAt !== null) {
    issues.push({ code: 'VARIANT_UNAVAILABLE' });
  } else {
    const { maxPurchasable } = availability(v.inventory, maxQtyPerLine);
    if (maxPurchasable <= 0) issues.push({ code: 'OUT_OF_STOCK' });
    else {
      purchasable = true;
      if (quantity > maxPurchasable) {
        issues.push({
          code: 'QUANTITY_REDUCED',
          meta: { requested: quantity, applied: maxPurchasable },
        });
        quantity = maxPurchasable;
      }
    }
  }
  if (!line.unitPriceAtAdd.eq(v.sellingPrice)) {
    issues.push({
      code: 'PRICE_CHANGED',
      meta: { old: toMoneyString(line.unitPriceAtAdd), new: toMoneyString(v.sellingPrice) },
    });
  }
  return { purchasable, quantity, issues };
}

/** R-04: `min(max(serverQty, guestQty), maxQtyPerLine, available)`. */
export function mergedQuantity(
  serverQty: number,
  guestQty: number,
  maxQtyPerLine: number,
  available: number,
): { wanted: number; applied: number } {
  const wanted = Math.max(serverQty, guestQty);
  return { wanted, applied: Math.max(0, Math.min(wanted, maxQtyPerLine, available)) };
}

// ── Errors ────────────────────────────────────────────────────────────────────────────────────

export function insufficientStockError(args: {
  readonly variantId: string;
  readonly sku: string;
  readonly label: string;
  readonly requested: number;
  readonly inCart: number;
  readonly available: number;
}): AppError {
  const units = args.available === 1 ? 'unit' : 'units';
  const verb = args.available === 1 ? 'is' : 'are';
  const message =
    args.available <= 0
      ? `${args.label} is out of stock.`
      : `Only ${args.available} ${units} of ${args.label} ${verb} available.`;
  return new AppError('INSUFFICIENT_STOCK', message, {
    details: [
      {
        field: 'quantity',
        code: 'INSUFFICIENT_STOCK',
        message: `Requested ${args.requested}, available ${Math.max(0, args.available - args.inCart)}.`,
        meta: {
          variantId: args.variantId,
          sku: args.sku,
          requested: args.requested,
          inCart: args.inCart,
          available: args.available,
        },
      },
    ],
  });
}

export function maxQtyError(max: number, inCart: number): AppError {
  const message = `You can buy at most ${max} of this item.`;
  return new AppError('VALIDATION_ERROR', message, {
    details: [{ field: 'quantity', code: 'MAX_QTY_PER_LINE', message, meta: { max, inCart } }],
  });
}

export function lineLimitError(max: number): AppError {
  const message = `Your cart can hold at most ${max} different items.`;
  return new AppError('VALIDATION_ERROR', message, {
    details: [{ field: 'variantId', code: 'CART_LINE_LIMIT', message, meta: { max } }],
  });
}

/** `Meera Kundan Jhumka (Gold / Medium)`; the variant name is omitted when equal to the product. */
export function itemLabel(productName: string, variantName: string): string {
  return variantName === productName || variantName === ''
    ? productName
    : `${productName} (${variantName})`;
}

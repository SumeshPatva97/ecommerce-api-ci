/**
 * Pure inventory rules — INVENTORY_AND_STOCK_DATABASE_DESIGN.md §3–§6, §9;
 * PRODUCT_VARIANT_AND_INVENTORY_WORKFLOWS.md §15–§17. No I/O.
 *
 * - available = on_hand − reserved; never negative (`reserved ≤ on_hand`, both ≥ 0).
 * - PROVISIONAL (OQ-18): no backorders — every decrease is checked against available stock.
 * - PROVISIONAL (OQ-19): single location (one `inventory` row per variant).
 * - PROVISIONAL (OQ-47): low-stock threshold = per-variant override, else global default 5;
 *   edge-triggered alert (episode starts when available drops to ≤ threshold, re-arms above it).
 */
export const MANUAL_MOVEMENT_TYPES = [
  'STOCK_IN',
  'STOCK_OUT',
  'ADJUSTMENT_INCREASE',
  'ADJUSTMENT_DECREASE',
] as const;
export type ManualMovementType = (typeof MANUAL_MOVEMENT_TYPES)[number];

/** API_DOCUMENTATION.md §4.5 reason codes. */
export const MOVEMENT_REASON_CODES = [
  'PURCHASE',
  'RETURN_TO_VENDOR',
  'DAMAGED',
  'LOST',
  'FOUND',
  'CYCLE_COUNT',
  'INITIAL_STOCK',
  'OTHER',
] as const;
export type MovementReasonCode = (typeof MOVEMENT_REASON_CODES)[number];

/** PROVISIONAL (OQ-47): global low-stock default when neither setting nor override exists. */
export const DEFAULT_LOW_STOCK_THRESHOLD = 5;
export const LOW_STOCK_SETTING_KEY = 'inventory.low_stock_threshold_default';

export function isDecrease(type: ManualMovementType): boolean {
  return type === 'STOCK_OUT' || type === 'ADJUSTMENT_DECREASE';
}

/** Signed on-hand delta of a manual movement. */
export function onHandDeltaFor(type: ManualMovementType, quantity: number): number {
  return isDecrease(type) ? -quantity : quantity;
}

export function available(onHand: number, reserved: number): number {
  return onHand - reserved;
}

/** Largest quantity a STOCK_OUT/ADJUSTMENT_DECREASE may remove (keeps reserved ≤ on_hand). */
export function maxRemovable(onHand: number, reserved: number): number {
  return Math.max(0, Math.min(onHand, onHand - reserved));
}

export function effectiveThreshold(override: number | null, globalDefault: number): number {
  return override ?? globalDefault;
}

export function isLowStock(availableQty: number, threshold: number): boolean {
  return availableQty <= threshold;
}

export interface LowStockEvaluation {
  /** New `low_stock_alerted_at` value, or `undefined` when unchanged. */
  readonly alertedAt: Date | null | undefined;
  /** True when a new low-stock episode starts (→ LOW_STOCK_ALERT). */
  readonly crossed: boolean;
}

/** Edge-triggered low-stock state machine (§17). */
export function evaluateLowStock(
  availableAfter: number,
  threshold: number,
  alertedAt: Date | null,
  now: Date,
): LowStockEvaluation {
  const low = isLowStock(availableAfter, threshold);
  if (low && alertedAt === null) return { alertedAt: now, crossed: true };
  if (!low && alertedAt !== null) return { alertedAt: null, crossed: false };
  return { alertedAt: undefined, crossed: false };
}

/**
 * The approved ledger has no `reference` column; a movement reference (GRN / supplier invoice no.)
 * is stored as a `[ref:…]` prefix of `note` and split again on read.
 */
const REF_PREFIX = /^\[ref:([^\]]{1,64})\](?: (.*))?$/s;

export function encodeNote(note: string | undefined, reference: string | undefined): string | null {
  if (reference === undefined) return note ?? null;
  return note === undefined ? `[ref:${reference}]` : `[ref:${reference}] ${note}`;
}

export function decodeNote(stored: string | null): {
  note: string | null;
  reference: string | null;
} {
  if (stored === null) return { note: null, reference: null };
  const match = REF_PREFIX.exec(stored);
  if (match === null) return { note: stored, reference: null };
  return { note: match[2] ?? null, reference: match[1] ?? null };
}

/** Escapes `%`, `_` and `\` for a SQL LIKE prefix (SKUs may contain `_`). */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

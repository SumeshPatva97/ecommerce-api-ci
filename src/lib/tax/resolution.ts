/**
 * Pure tax-master helpers: effective-date windows, assignment precedence and component-rate
 * derivation — TAX_AND_GST_WORKFLOWS.md §3.2, §3.4, §5, §23.3. No I/O.
 *
 * Effective dates are IST calendar dates. They are stored as the UTC instant of 00:00 IST of the
 * date (`effective_from`, `effective_to`); `effective_to` is INCLUSIVE, so a window covers
 * `[from, to + 1 day)` in instants. `effective_to = null` is open-ended.
 */
import { dec, type Decimal, type DecimalInput } from '../money.js';
import { addDays, istParts, startOfIstDay } from '../time.js';

export interface EffectiveWindow {
  readonly effectiveFrom: Date;
  readonly effectiveTo: Date | null;
}

/** Exclusive end instant of a window (`null` = open-ended). */
export function windowEnd(window: EffectiveWindow): Date | null {
  return window.effectiveTo === null ? null : addDays(startOfIstDay(window.effectiveTo), 1);
}

export function isEffectiveOn(window: EffectiveWindow, at: Date): boolean {
  if (at.getTime() < window.effectiveFrom.getTime()) return false;
  const end = windowEnd(window);
  return end === null || at.getTime() < end.getTime();
}

export function windowsOverlap(a: EffectiveWindow, b: EffectiveWindow): boolean {
  const aEnd = windowEnd(a);
  const bEnd = windowEnd(b);
  const aStartsBeforeBEnds = bEnd === null || a.effectiveFrom.getTime() < bEnd.getTime();
  const bStartsBeforeAEnds = aEnd === null || b.effectiveFrom.getTime() < aEnd.getTime();
  return aStartsBeforeBEnds && bStartsBeforeAEnds;
}

/** `YYYY-MM-DD` (IST calendar date) of a stored instant. */
export function toIstDateString(date: Date): string {
  const { year, month, day } = istParts(date);
  return `${String(year)}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export interface AssignmentCandidate extends EffectiveWindow {
  readonly id: string;
  readonly targetType: 'PRODUCT' | 'CATEGORY';
  readonly productId: string | null;
  readonly categoryId: string | null;
  readonly taxRateId: string;
  readonly hsnCode: string | null;
  readonly taxRate: {
    readonly id: string;
    readonly rate: DecimalInput;
    readonly isActive: boolean;
  };
}

export type AssignmentSource = 'PRODUCT' | 'CATEGORY';

export interface SelectedAssignment<T extends AssignmentCandidate> {
  readonly assignment: T;
  readonly source: AssignmentSource;
  /** Category that supplied the assignment (`null` for product-level). */
  readonly categoryId: string | null;
}

export type SelectionFailure = 'NO_ASSIGNMENT' | 'RATE_INACTIVE';

/**
 * Precedence: product assignment → nearest category → ancestor categories (`categoryChain` is
 * ordered nearest first). Only windows effective at `at` count. A matching assignment whose rate
 * is inactive fails closed (`RATE_INACTIVE`) rather than falling through to a less specific level.
 */
export function selectAssignment<T extends AssignmentCandidate>(
  candidates: readonly T[],
  productId: string,
  categoryChain: readonly string[],
  at: Date,
): SelectedAssignment<T> | SelectionFailure {
  const effective = candidates.filter((c) => isEffectiveOn(c, at));
  const pick = (
    match: T | undefined,
    source: AssignmentSource,
    categoryId: string | null,
  ): SelectedAssignment<T> | SelectionFailure | undefined => {
    if (match === undefined) return undefined;
    if (!match.taxRate.isActive) return 'RATE_INACTIVE';
    return { assignment: match, source, categoryId };
  };
  const product = pick(
    effective.find((c) => c.targetType === 'PRODUCT' && c.productId === productId),
    'PRODUCT',
    null,
  );
  if (product !== undefined) return product;
  for (const categoryId of categoryChain) {
    const category = pick(
      effective.find((c) => c.targetType === 'CATEGORY' && c.categoryId === categoryId),
      'CATEGORY',
      categoryId,
    );
    if (category !== undefined) return category;
  }
  return 'NO_ASSIGNMENT';
}

export interface ComponentRates {
  readonly rate: Decimal;
  readonly cgstRate: Decimal;
  readonly sgstRate: Decimal;
  readonly utgstRate: Decimal;
  readonly igstRate: Decimal;
}

/**
 * Component split stored on `tax_rates` (§3.2): CGST = SGST = UTGST = rate / 2, IGST = rate.
 * Returns `undefined` when the half rate is not representable in DECIMAL(5,2) (e.g. 0.25 %).
 */
export function deriveComponentRates(ratePercent: DecimalInput): ComponentRates | undefined {
  const rate = dec(ratePercent);
  if (rate.isNegative() || rate.greaterThan(100) || rate.decimalPlaces() > 2) return undefined;
  const half = rate.dividedBy(2);
  if (half.decimalPlaces() > 2) return undefined;
  return { rate, cgstRate: half, sgstRate: half, utgstRate: half, igstRate: rate };
}

/**
 * Promotion rules (pure) — API_DOCUMENTATION.md §4.9 (Promotions), DATABASE_DESIGN §11.4.
 *
 * Status model: DRAFT and PAUSED are manual; SCHEDULED/ACTIVE/EXPIRED follow the dates. The stored
 * status is maintained on writes; reads always report the effective status for `now` (no
 * scheduler job is required for correctness).
 */
import { Decimal, dec } from '../../lib/money.js';

export type PromotionStatusValue = 'DRAFT' | 'SCHEDULED' | 'ACTIVE' | 'PAUSED' | 'EXPIRED';

export interface PromotionRuleInput {
  readonly scope: 'PRODUCT' | 'CATEGORY' | 'BRAND' | 'COLLECTION';
  readonly discountType: 'PERCENTAGE' | 'FIXED_AMOUNT';
  readonly discountValue: string | Decimal;
  readonly maxDiscountAmount?: string | Decimal | null | undefined;
  readonly startsAt?: Date | null | undefined;
  readonly endsAt?: Date | null | undefined;
  readonly includeDescendants?: boolean | undefined;
}

export interface FieldIssue {
  readonly field: string;
  readonly message: string;
}

const HUNDRED = new Decimal(100);

export function promotionRuleIssues(v: PromotionRuleInput): FieldIssue[] {
  const issues: FieldIssue[] = [];
  const value = dec(v.discountValue);
  if (v.discountType === 'PERCENTAGE') {
    if (value.lte(0) || value.gt(HUNDRED)) {
      issues.push({ field: 'discountValue', message: 'Percentage must be between 0.01 and 100.' });
    }
  } else if (value.lte(0)) {
    issues.push({ field: 'discountValue', message: 'Must be greater than 0.' });
  }
  if (v.maxDiscountAmount !== null && v.maxDiscountAmount !== undefined) {
    if (v.discountType !== 'PERCENTAGE') {
      issues.push({
        field: 'maxDiscountAmount',
        message: 'Maximum discount applies to percentage promotions only.',
      });
    } else if (dec(v.maxDiscountAmount).lte(0)) {
      issues.push({ field: 'maxDiscountAmount', message: 'Must be greater than 0.' });
    }
  }
  if (
    v.startsAt !== null &&
    v.startsAt !== undefined &&
    v.endsAt !== null &&
    v.endsAt !== undefined &&
    v.endsAt.getTime() <= v.startsAt.getTime()
  ) {
    issues.push({ field: 'endsAt', message: 'End must be after the start date.' });
  }
  if (v.includeDescendants !== undefined && v.scope !== 'CATEGORY') {
    issues.push({
      field: 'includeDescendants',
      message: 'Only category promotions can include descendants.',
    });
  }
  return issues;
}

/** Date-driven status of a published (non-draft, non-paused) promotion. */
export function scheduleStatus(
  startsAt: Date | null,
  endsAt: Date | null,
  now: Date,
): 'SCHEDULED' | 'ACTIVE' | 'EXPIRED' {
  if (endsAt !== null && now.getTime() >= endsAt.getTime()) return 'EXPIRED';
  if (startsAt !== null && now.getTime() < startsAt.getTime()) return 'SCHEDULED';
  return 'ACTIVE';
}

export function effectiveStatus(
  p: { status: PromotionStatusValue; startsAt: Date | null; endsAt: Date | null },
  now: Date,
): PromotionStatusValue {
  if (p.status === 'SCHEDULED' || p.status === 'ACTIVE') {
    return scheduleStatus(p.startsAt, p.endsAt, now);
  }
  return p.status;
}

/** `ACTIVE|SCHEDULED → PAUSED`. */
export function canPause(status: PromotionStatusValue): boolean {
  return status === 'ACTIVE' || status === 'SCHEDULED';
}

/** DELETE only for DRAFT / SCHEDULED / EXPIRED promotions never applied to an order. */
export function canDelete(status: PromotionStatusValue, appliedToOrders: number): boolean {
  return (
    (status === 'DRAFT' || status === 'SCHEDULED' || status === 'EXPIRED') && appliedToOrders === 0
  );
}

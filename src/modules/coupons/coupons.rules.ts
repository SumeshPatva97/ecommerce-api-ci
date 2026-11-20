/**
 * Coupon business rules (pure) — API_DOCUMENTATION.md §4.9 validation table, DATABASE_DESIGN §11.1
 * checks. Shared by the create schema (zod superRefine) and PATCH (rules re-run on the merged row).
 *
 * PROVISIONAL (OQ-51): `maxDiscountAmount` optional for PERCENTAGE coupons.
 * PROVISIONAL (OQ-16): `perCustomerLimit` optional (≥ 1); first-order flag supported.
 */
import { Decimal, dec } from '../../lib/money.js';

export interface CouponRuleInput {
  readonly discountType: 'PERCENTAGE' | 'FIXED_AMOUNT';
  readonly discountValue: string | Decimal;
  readonly maxDiscountAmount?: string | Decimal | null | undefined;
  readonly startsAt?: Date | null | undefined;
  readonly expiresAt?: Date | null | undefined;
  readonly usageLimitEnabled: boolean;
  readonly usageLimit?: number | null | undefined;
}

export interface FieldIssue {
  readonly field: string;
  readonly message: string;
}

export const MESSAGES = {
  percentRange: 'Percentage must be between 0.01 and 100.',
  positive: 'Must be greater than 0.',
  maxForPercentOnly: 'Maximum discount applies to percentage coupons only.',
  expiryAfterStart: 'Expiry must be after the start date.',
  usageRequired: 'Usage limit is required when usage limit is enabled.',
  usageZero: 'Must be at least 1 when usage limit is enabled.',
  wholeNumber: 'Must be a whole number of at least 1.',
  removeUsage: 'Remove the usage limit or enable it.',
  code: 'Use 3–32 letters, numbers, hyphens or underscores.',
} as const;

const HUNDRED = new Decimal(100);

export function couponRuleIssues(v: CouponRuleInput): FieldIssue[] {
  const issues: FieldIssue[] = [];
  const value = dec(v.discountValue);
  if (v.discountType === 'PERCENTAGE') {
    if (value.lte(0) || value.gt(HUNDRED)) {
      issues.push({ field: 'discountValue', message: MESSAGES.percentRange });
    }
  } else if (value.lte(0)) {
    issues.push({ field: 'discountValue', message: MESSAGES.positive });
  }
  if (v.maxDiscountAmount !== null && v.maxDiscountAmount !== undefined) {
    if (v.discountType !== 'PERCENTAGE') {
      issues.push({ field: 'maxDiscountAmount', message: MESSAGES.maxForPercentOnly });
    } else if (dec(v.maxDiscountAmount).lte(0)) {
      issues.push({ field: 'maxDiscountAmount', message: MESSAGES.positive });
    }
  }
  if (
    v.startsAt !== null &&
    v.startsAt !== undefined &&
    v.expiresAt !== null &&
    v.expiresAt !== undefined &&
    v.expiresAt.getTime() <= v.startsAt.getTime()
  ) {
    issues.push({ field: 'expiresAt', message: MESSAGES.expiryAfterStart });
  }
  const limit = v.usageLimit;
  if (v.usageLimitEnabled) {
    if (limit === null || limit === undefined) {
      issues.push({ field: 'usageLimit', message: MESSAGES.usageRequired });
    } else if (limit === 0) {
      issues.push({ field: 'usageLimit', message: MESSAGES.usageZero });
    } else if (!Number.isInteger(limit) || limit < 1) {
      issues.push({ field: 'usageLimit', message: MESSAGES.wholeNumber });
    }
  } else if (limit !== null && limit !== undefined) {
    issues.push({ field: 'usageLimit', message: MESSAGES.removeUsage });
  }
  return issues;
}

/** Validity bucket used by the admin list filter and DTO (`validity=active|scheduled|expired`). */
export type CouponValidity = 'ACTIVE' | 'SCHEDULED' | 'EXPIRED' | 'INACTIVE';

export function couponValidity(
  c: { status: string; startsAt: Date | null; expiresAt: Date | null },
  now: Date,
): CouponValidity {
  if (c.status !== 'ACTIVE') return 'INACTIVE';
  if (c.expiresAt !== null && c.expiresAt.getTime() <= now.getTime()) return 'EXPIRED';
  if (c.startsAt !== null && c.startsAt.getTime() > now.getTime()) return 'SCHEDULED';
  return 'ACTIVE';
}

/** Remaining redemptions (`null` = unlimited). */
export function remainingUses(c: {
  usageLimitEnabled: boolean;
  usageLimit: number | null;
  usedCount: number;
}): number | null {
  if (!c.usageLimitEnabled || c.usageLimit === null) return null;
  return Math.max(0, c.usageLimit - c.usedCount);
}

export type UsageReleaseReason =
  'PAYMENT_FAILED' | 'RESERVATION_EXPIRED' | 'ORDER_CANCELLED_BEFORE_SHIPMENT';

/**
 * DATABASE_DESIGN §17.2 lifecycle. RESERVED → RELEASED for any reason; REDEEMED → RELEASED only
 * for a cancellation before shipment while the coupon is still valid (PROVISIONAL OQ-15).
 */
export function releaseDecision(
  usageStatus: 'RESERVED' | 'REDEEMED' | 'RELEASED',
  reason: UsageReleaseReason,
  couponStillValid: boolean,
): 'RELEASE' | 'KEEP' | 'NOOP' {
  if (usageStatus === 'RELEASED') return 'NOOP';
  if (usageStatus === 'RESERVED') return 'RELEASE';
  return reason === 'ORDER_CANCELLED_BEFORE_SHIPMENT' && couponStillValid ? 'RELEASE' : 'KEEP';
}

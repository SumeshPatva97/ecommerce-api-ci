/**
 * Customer-facing texts for `COUPON_INVALID` sub-reasons — API_DOCUMENTATION.md §3.4 reason →
 * message table. Pure (dates rendered in IST, money as 2-dp strings).
 */
import { toMoneyString } from '../money.js';
import type { CouponFailure } from './types.js';

const IST_DATE = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/** `2026-10-31T18:29:59.999Z` → `31 Oct 2026` (IST calendar day). */
export function formatIstDate(date: Date): string {
  return IST_DATE.format(date);
}

export interface CouponFailureText {
  /** Top-level `error.message`. */
  readonly message: string;
  /** `error.details[0].message`. */
  readonly detail: string;
  readonly meta?: Record<string, string>;
}

export function couponFailureText(failure: CouponFailure): CouponFailureText {
  switch (failure.reason) {
    case 'COUPON_NOT_FOUND':
      return { message: 'This coupon code is not valid.', detail: 'Unknown coupon code.' };
    case 'COUPON_INACTIVE':
      return { message: 'This coupon is not active.', detail: 'The coupon is not active.' };
    case 'COUPON_NOT_STARTED': {
      const date =
        failure.startsAt === undefined ? 'a later date' : formatIstDate(failure.startsAt);
      return {
        message: `This coupon is valid from ${date}.`,
        detail: `Valid from ${date}.`,
        ...(failure.startsAt === undefined
          ? {}
          : { meta: { startsAt: failure.startsAt.toISOString() } }),
      };
    }
    case 'COUPON_EXPIRED':
      return {
        message: 'This coupon has expired.',
        detail:
          failure.expiresAt === undefined
            ? 'The coupon has expired.'
            : `Expired on ${formatIstDate(failure.expiresAt)}.`,
        ...(failure.expiresAt === undefined
          ? {}
          : { meta: { expiresAt: failure.expiresAt.toISOString() } }),
      };
    case 'COUPON_USAGE_LIMIT_REACHED':
      return {
        message: 'This coupon has reached its usage limit.',
        detail: 'No redemptions remaining.',
      };
    case 'COUPON_CUSTOMER_LIMIT_REACHED':
      return {
        message: 'You have already used this coupon the maximum number of times.',
        detail: 'Per-customer limit reached.',
      };
    case 'COUPON_FIRST_ORDER_ONLY':
      return {
        message: 'This coupon is valid on your first order only.',
        detail: 'First order only.',
      };
    case 'COUPON_NOT_APPLICABLE':
      return {
        message: "This coupon doesn't apply to the items in your cart.",
        detail: 'No eligible items in the cart.',
      };
    case 'COUPON_NOT_COMBINABLE':
      return {
        message: "This coupon can't be combined with items already on promotion.",
        detail: 'All eligible items carry an active promotion.',
      };
    case 'COUPON_MIN_ORDER_NOT_MET': {
      const shortfall = toMoneyString(failure.shortfall ?? 0);
      const min = toMoneyString(failure.minOrderValue ?? 0);
      return {
        message: `Add items worth ₹${shortfall} more to use this coupon.`,
        detail: `Minimum eligible order value is ₹${min}.`,
        meta: {
          minOrderValue: min,
          eligibleSubtotal: toMoneyString(failure.eligibleSubtotal ?? 0),
          shortfall,
        },
      };
    }
  }
}

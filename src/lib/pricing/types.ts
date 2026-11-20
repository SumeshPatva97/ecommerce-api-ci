/**
 * Pricing engine input/output types — BACKEND_STRUCTURE.md §8, API_DOCUMENTATION.md §3.4/§3.9.
 * Pure data: no Prisma rows, no I/O. Money is `Decimal` (never float).
 */
import type { Decimal } from '../money.js';

export type DiscountKind = 'PERCENTAGE' | 'FIXED_AMOUNT';
export type TargetScope = 'PRODUCT' | 'CATEGORY' | 'BRAND' | 'COLLECTION';
export type PromotionLifecycle = 'DRAFT' | 'SCHEDULED' | 'ACTIVE' | 'PAUSED' | 'EXPIRED';

/** One cart / order line as the engine sees it. */
export interface PricingLineInput {
  /** Caller's line id (cart item id, order line key) — echoed in the result. */
  readonly lineId: string;
  readonly variantId: string;
  readonly productId: string;
  /** The product's own category. */
  readonly categoryId: string;
  /** Own category followed by its ancestors (max depth 3), nearest first. */
  readonly categoryPath: readonly string[];
  readonly brandId: string | null;
  readonly collectionIds: readonly string[];
  readonly quantity: number;
  readonly mrp: Decimal;
  /** Current variant selling price (variant-level discount already applied vs MRP). */
  readonly sellingPrice: Decimal;
}

export interface PromotionTarget {
  readonly id: string;
  /** CATEGORY scope only: also match products of descendant categories (default true). */
  readonly includeDescendants?: boolean | undefined;
}

/** Promotion snapshot (loaded by the service; the engine re-checks status + window). */
export interface PromotionSnapshot {
  readonly id: string;
  readonly name: string;
  readonly scope: TargetScope;
  readonly discountType: DiscountKind;
  readonly discountValue: Decimal;
  /** PERCENTAGE only: cap per unit. */
  readonly maxDiscountAmount: Decimal | null;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  readonly status: PromotionLifecycle;
  readonly deleted: boolean;
  /** Lower number wins a tie (BACKEND_STRUCTURE §8.2). */
  readonly priority: number;
  readonly createdAt: Date;
  readonly targets: readonly PromotionTarget[];
}

export interface CouponRule {
  readonly ruleType: 'INCLUDE' | 'EXCLUDE';
  readonly targetType: TargetScope;
  readonly targetId: string;
}

export interface CouponSnapshot {
  readonly id: string;
  readonly code: string;
  readonly description: string | null;
  readonly status: 'ACTIVE' | 'INACTIVE';
  readonly deleted: boolean;
  readonly discountType: DiscountKind;
  readonly discountValue: Decimal;
  readonly maxDiscountAmount: Decimal | null;
  readonly minOrderValue: Decimal | null;
  readonly startsAt: Date | null;
  readonly expiresAt: Date | null;
  readonly usageLimitEnabled: boolean;
  readonly usageLimit: number | null;
  /** RESERVED + REDEEMED usages. */
  readonly usedCount: number;
  readonly perCustomerLimit: number | null;
  readonly isFirstOrderOnly: boolean;
  readonly isCombinableWithPromotions: boolean;
  readonly rules: readonly CouponRule[];
}

export interface CustomerPricingContext {
  /** No previous non-cancelled order (OQ-16 first-order coupons). */
  readonly isFirstOrder: boolean;
  /** RESERVED + REDEEMED usages of THIS coupon by the customer. */
  readonly couponUsesByCustomer: number;
}

export interface PricingInput {
  readonly lines: readonly PricingLineInput[];
  readonly promotions: readonly PromotionSnapshot[];
  readonly coupon?: CouponSnapshot | null | undefined;
  readonly customer: CustomerPricingContext;
  /** Injected clock — the engine never reads the system time. */
  readonly now: Date;
}

/** API_DOCUMENTATION §2.3 `COUPON_INVALID` sub-reasons. */
export type CouponFailureReason =
  | 'COUPON_NOT_FOUND'
  | 'COUPON_INACTIVE'
  | 'COUPON_NOT_STARTED'
  | 'COUPON_EXPIRED'
  | 'COUPON_USAGE_LIMIT_REACHED'
  | 'COUPON_CUSTOMER_LIMIT_REACHED'
  | 'COUPON_FIRST_ORDER_ONLY'
  | 'COUPON_NOT_APPLICABLE'
  | 'COUPON_NOT_COMBINABLE'
  | 'COUPON_MIN_ORDER_NOT_MET';

export interface CouponFailure {
  readonly reason: CouponFailureReason;
  readonly startsAt?: Date | undefined;
  readonly expiresAt?: Date | undefined;
  readonly minOrderValue?: Decimal | undefined;
  readonly eligibleSubtotal?: Decimal | undefined;
  readonly shortfall?: Decimal | undefined;
}

export interface AppliedPromotion {
  readonly id: string;
  readonly name: string;
  readonly scope: TargetScope;
  readonly unitDiscount: Decimal;
  /** `unitDiscount × quantity`. */
  readonly discount: Decimal;
}

export interface PricedLine {
  readonly lineId: string;
  readonly variantId: string;
  readonly productId: string;
  readonly quantity: number;
  readonly mrp: Decimal;
  readonly unitPrice: Decimal;
  /** `unitPrice × quantity`. */
  readonly lineBase: Decimal;
  readonly promotion: AppliedPromotion | null;
  readonly promotionDiscount: Decimal;
  /** `lineBase − promotionDiscount`. */
  readonly postPromotionValue: Decimal;
  /** Part of the coupon's eligible base. */
  readonly couponEligible: boolean;
  readonly couponDiscount: Decimal;
  /** `postPromotionValue − couponDiscount` (value the tax engine works on). */
  readonly netLineValue: Decimal;
}

export interface AppliedCoupon {
  readonly status: 'APPLIED';
  readonly couponId: string;
  readonly code: string;
  readonly description: string | null;
  readonly discountType: DiscountKind;
  readonly discountValue: Decimal;
  readonly maxDiscountAmount: Decimal | null;
  readonly eligibleBase: Decimal;
  /** Before the OQ-51 cap. */
  readonly computed: Decimal;
  readonly applied: Decimal;
  readonly capped: boolean;
  readonly allocation: 'PRO_RATA_BY_NET_LINE_VALUE';
}

export interface RejectedCoupon {
  readonly status: 'REJECTED';
  readonly couponId: string;
  readonly code: string;
  readonly failure: CouponFailure;
}

export type CouponOutcome = AppliedCoupon | RejectedCoupon;

export interface PricingTotals {
  /** Σ MRP × qty (display: "you save"). */
  readonly mrpTotal: Decimal;
  /** Σ lineBase. */
  readonly subtotal: Decimal;
  readonly itemDiscountTotal: Decimal;
  readonly couponDiscountTotal: Decimal;
  /** Σ netLineValue (before shipping and tax). */
  readonly netItemTotal: Decimal;
}

export interface PricingResult {
  readonly lines: readonly PricedLine[];
  /** `null` when no coupon was supplied. */
  readonly coupon: CouponOutcome | null;
  readonly totals: PricingTotals;
  readonly now: Date;
}

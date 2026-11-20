/**
 * Pricing engine (pure) — BACKEND_STRUCTURE.md §8, API_DOCUMENTATION.md §3.4 / §3.9.
 *
 * PROVISIONAL (OQ-14): best single promotion per line (no promotion stacking) + at most one
 * coupon per cart/order, applied on the post-promotion price; a coupon that is not combinable
 * with promotions excludes promoted lines from its eligible base.
 * PROVISIONAL (OQ-51): the PERCENTAGE coupon cap (`maxDiscountAmount`) is optional.
 * PROVISIONAL (OQ-16): per-customer limit optional; first-order-only flag supported.
 *
 * Rounding (OQ-23): every money amount is rounded half-up to ₹0.01. The coupon is allocated to
 * eligible lines pro-rata by post-promotion value; the rounding remainder goes to the line with
 * the largest value (first such line on a tie) so Σ allocations = coupon amount exactly.
 *
 * Shipping is intentionally NOT priced here: the checkout layer adds the shipping charge on top
 * of `PricingResult.totals.netItemTotal` (OQ-07) and then calls the tax engine per line.
 *
 * The engine never reads the clock (`now` is injected) and never touches the database.
 */
import { Decimal, ZERO, roundMoney, sum } from '../money.js';
import type {
  AppliedCoupon,
  AppliedPromotion,
  CouponFailure,
  CouponOutcome,
  CouponRule,
  CouponSnapshot,
  CustomerPricingContext,
  PricedLine,
  PricingInput,
  PricingLineInput,
  PricingResult,
  PromotionSnapshot,
  PromotionTarget,
} from './types.js';

const ONE_PAISA = new Decimal('0.01');
const HUNDRED = new Decimal(100);

// ── Promotions ────────────────────────────────────────────────────────────────────────────────

/** Effective rule (DATABASE_DESIGN §11.4): SCHEDULED/ACTIVE, not deleted, `startsAt ≤ now < endsAt`. */
export function isPromotionEffective(p: PromotionSnapshot, now: Date): boolean {
  if (p.deleted) return false;
  if (p.status !== 'ACTIVE' && p.status !== 'SCHEDULED') return false;
  if (p.startsAt !== null && p.startsAt.getTime() > now.getTime()) return false;
  if (p.endsAt !== null && now.getTime() >= p.endsAt.getTime()) return false;
  return true;
}

function targetMatches(
  scope: PromotionSnapshot['scope'],
  target: PromotionTarget,
  line: PricingLineInput,
): boolean {
  switch (scope) {
    case 'PRODUCT':
      return target.id === line.productId;
    case 'CATEGORY':
      return target.includeDescendants === false
        ? target.id === line.categoryId
        : target.id === line.categoryId || line.categoryPath.includes(target.id);
    case 'BRAND':
      return line.brandId !== null && target.id === line.brandId;
    case 'COLLECTION':
      return line.collectionIds.includes(target.id);
  }
}

export function promotionMatchesLine(p: PromotionSnapshot, line: PricingLineInput): boolean {
  return p.targets.some((t) => targetMatches(p.scope, t, line));
}

/**
 * Discount per unit: PERCENTAGE of the unit price (capped per unit by `maxDiscountAmount`) or a
 * FIXED amount; never negative and the promoted price never drops below ₹0.01.
 */
export function promotionUnitDiscount(p: PromotionSnapshot, unitPrice: Decimal): Decimal {
  let discount =
    p.discountType === 'PERCENTAGE'
      ? roundMoney(unitPrice.times(p.discountValue).dividedBy(HUNDRED))
      : roundMoney(p.discountValue);
  if (p.discountType === 'PERCENTAGE' && p.maxDiscountAmount !== null) {
    discount = Decimal.min(discount, p.maxDiscountAmount);
  }
  const ceiling = Decimal.max(ZERO, unitPrice.minus(ONE_PAISA));
  return Decimal.max(ZERO, Decimal.min(discount, ceiling));
}

/** Largest discount wins; tie → lower `priority` number → older `createdAt` → id. */
export function selectBestPromotion(
  line: PricingLineInput,
  promotions: readonly PromotionSnapshot[],
  now: Date,
): AppliedPromotion | null {
  let best: { p: PromotionSnapshot; unit: Decimal } | null = null;
  for (const p of promotions) {
    if (!isPromotionEffective(p, now) || !promotionMatchesLine(p, line)) continue;
    const unit = promotionUnitDiscount(p, line.sellingPrice);
    if (unit.lte(ZERO)) continue;
    if (best === null || isBetter(unit, p, best.unit, best.p)) best = { p, unit };
  }
  if (best === null) return null;
  return {
    id: best.p.id,
    name: best.p.name,
    scope: best.p.scope,
    unitDiscount: best.unit,
    discount: best.unit.times(line.quantity),
  };
}

function isBetter(
  unit: Decimal,
  p: PromotionSnapshot,
  bestUnit: Decimal,
  bestP: PromotionSnapshot,
): boolean {
  const cmp = unit.comparedTo(bestUnit);
  if (cmp !== 0) return cmp > 0;
  if (p.priority !== bestP.priority) return p.priority < bestP.priority;
  const age = p.createdAt.getTime() - bestP.createdAt.getTime();
  if (age !== 0) return age < 0;
  return p.id < bestP.id;
}

// ── Coupons ───────────────────────────────────────────────────────────────────────────────────

function ruleMatches(rule: CouponRule, line: PricingLineInput): boolean {
  // Category rules include descendants (DATABASE_DESIGN §11.2).
  return targetMatches(rule.targetType, { id: rule.targetId }, line);
}

/** No INCLUDE rule → whole catalogue; EXCLUDE always wins over INCLUDE. */
export function isLineCouponApplicable(coupon: CouponSnapshot, line: PricingLineInput): boolean {
  const includes = coupon.rules.filter((r) => r.ruleType === 'INCLUDE');
  const excludes = coupon.rules.filter((r) => r.ruleType === 'EXCLUDE');
  if (excludes.some((r) => ruleMatches(r, line))) return false;
  return includes.length === 0 || includes.some((r) => ruleMatches(r, line));
}

/**
 * Rules that do not depend on cart content, in the documented evaluation order: existence →
 * status → window → usage limit → per-customer limit → first order.
 */
export function couponPreconditionFailure(
  coupon: CouponSnapshot,
  customer: CustomerPricingContext,
  now: Date,
): CouponFailure | null {
  if (coupon.deleted) return { reason: 'COUPON_NOT_FOUND' };
  if (coupon.status !== 'ACTIVE') return { reason: 'COUPON_INACTIVE' };
  if (coupon.startsAt !== null && now.getTime() < coupon.startsAt.getTime()) {
    return { reason: 'COUPON_NOT_STARTED', startsAt: coupon.startsAt };
  }
  if (coupon.expiresAt !== null && now.getTime() >= coupon.expiresAt.getTime()) {
    return { reason: 'COUPON_EXPIRED', expiresAt: coupon.expiresAt };
  }
  if (
    coupon.usageLimitEnabled &&
    coupon.usageLimit !== null &&
    coupon.usedCount >= coupon.usageLimit
  ) {
    return { reason: 'COUPON_USAGE_LIMIT_REACHED' };
  }
  if (
    coupon.perCustomerLimit !== null &&
    customer.couponUsesByCustomer >= coupon.perCustomerLimit
  ) {
    return { reason: 'COUPON_CUSTOMER_LIMIT_REACHED' };
  }
  if (coupon.isFirstOrderOnly && !customer.isFirstOrder)
    return { reason: 'COUPON_FIRST_ORDER_ONLY' };
  return null;
}

/** `eligibleBase × rate` capped by `maxDiscountAmount` (OQ-51), or `min(value, eligibleBase)`. */
export function couponAmount(
  coupon: Pick<CouponSnapshot, 'discountType' | 'discountValue' | 'maxDiscountAmount'>,
  eligibleBase: Decimal,
): { computed: Decimal; applied: Decimal; capped: boolean } {
  if (coupon.discountType === 'PERCENTAGE') {
    // discountValue ≤ 100 (DB check), so the amount never exceeds the eligible base.
    const computed = roundMoney(eligibleBase.times(coupon.discountValue).dividedBy(HUNDRED));
    const cap = coupon.maxDiscountAmount;
    if (cap !== null && computed.gt(cap)) return { computed, applied: cap, capped: true };
    return { computed, applied: computed, capped: false };
  }
  const computed = roundMoney(coupon.discountValue);
  const applied = Decimal.min(computed, eligibleBase);
  return { computed, applied, capped: applied.lt(computed) };
}

/**
 * Splits `total` over `weights` pro-rata, half-up to ₹0.01 each; the remainder goes to the entry
 * with the largest weight (first on a tie). Zero total weight → all shares zero.
 */
export function allocateLargestRemainder(total: Decimal, weights: readonly Decimal[]): Decimal[] {
  const weightSum = sum(weights);
  if (weightSum.lte(ZERO)) return weights.map(() => ZERO);
  const amount = roundMoney(total);
  const shares = weights.map((w) => roundMoney(amount.times(w).dividedBy(weightSum)));
  const remainder = amount.minus(sum(shares));
  if (!remainder.isZero()) {
    let largest = 0;
    weights.forEach((w, i) => {
      const current = weights[largest] ?? ZERO;
      if (w.gt(current)) largest = i;
    });
    shares[largest] = (shares[largest] ?? ZERO).plus(remainder);
  }
  return shares;
}

// ── Engine ────────────────────────────────────────────────────────────────────────────────────

interface WorkingLine {
  readonly input: PricingLineInput;
  readonly lineBase: Decimal;
  readonly promotion: AppliedPromotion | null;
  readonly promotionDiscount: Decimal;
  readonly postPromotionValue: Decimal;
}

function evaluateCoupon(
  coupon: CouponSnapshot,
  lines: readonly WorkingLine[],
  customer: CustomerPricingContext,
  now: Date,
): { outcome: CouponOutcome; eligible: ReadonlySet<string>; shares: ReadonlyMap<string, Decimal> } {
  const reject = (failure: CouponFailure) => ({
    outcome: { status: 'REJECTED', couponId: coupon.id, code: coupon.code, failure } as const,
    eligible: new Set<string>(),
    shares: new Map<string, Decimal>(),
  });

  const pre = couponPreconditionFailure(coupon, customer, now);
  if (pre !== null) return reject(pre);

  const applicable = lines.filter((l) => isLineCouponApplicable(coupon, l.input));
  if (applicable.length === 0) return reject({ reason: 'COUPON_NOT_APPLICABLE' });
  const eligibleLines = coupon.isCombinableWithPromotions
    ? applicable
    : applicable.filter((l) => l.promotion === null);
  if (eligibleLines.length === 0) return reject({ reason: 'COUPON_NOT_COMBINABLE' });

  const eligibleBase = sum(eligibleLines.map((l) => l.postPromotionValue));
  if (coupon.minOrderValue !== null && eligibleBase.lt(coupon.minOrderValue)) {
    return reject({
      reason: 'COUPON_MIN_ORDER_NOT_MET',
      minOrderValue: coupon.minOrderValue,
      eligibleSubtotal: eligibleBase,
      shortfall: coupon.minOrderValue.minus(eligibleBase),
    });
  }

  const { computed, applied, capped } = couponAmount(coupon, eligibleBase);
  const allocation = allocateLargestRemainder(
    applied,
    eligibleLines.map((l) => l.postPromotionValue),
  );
  const shares = new Map<string, Decimal>();
  eligibleLines.forEach((l, i) => shares.set(l.input.lineId, allocation[i] ?? ZERO));

  const outcome: AppliedCoupon = {
    status: 'APPLIED',
    couponId: coupon.id,
    code: coupon.code,
    description: coupon.description,
    discountType: coupon.discountType,
    discountValue: coupon.discountValue,
    maxDiscountAmount: coupon.maxDiscountAmount,
    eligibleBase,
    computed,
    applied,
    capped,
    allocation: 'PRO_RATA_BY_NET_LINE_VALUE',
  };
  return { outcome, eligible: new Set(eligibleLines.map((l) => l.input.lineId)), shares };
}

export function priceCart(input: PricingInput): PricingResult {
  const working: WorkingLine[] = input.lines.map((line) => {
    const lineBase = roundMoney(line.sellingPrice.times(line.quantity));
    const promotion = selectBestPromotion(line, input.promotions, input.now);
    const promotionDiscount = promotion === null ? ZERO : promotion.discount;
    return {
      input: line,
      lineBase,
      promotion,
      promotionDiscount,
      postPromotionValue: lineBase.minus(promotionDiscount),
    };
  });

  const coupon =
    input.coupon === undefined || input.coupon === null
      ? null
      : evaluateCoupon(input.coupon, working, input.customer, input.now);

  const lines: PricedLine[] = working.map((w) => {
    const couponDiscount = coupon?.shares.get(w.input.lineId) ?? ZERO;
    return {
      lineId: w.input.lineId,
      variantId: w.input.variantId,
      productId: w.input.productId,
      quantity: w.input.quantity,
      mrp: w.input.mrp,
      unitPrice: w.input.sellingPrice,
      lineBase: w.lineBase,
      promotion: w.promotion,
      promotionDiscount: w.promotionDiscount,
      postPromotionValue: w.postPromotionValue,
      couponEligible: coupon?.eligible.has(w.input.lineId) ?? false,
      couponDiscount,
      netLineValue: w.postPromotionValue.minus(couponDiscount),
    };
  });

  return {
    lines,
    coupon: coupon?.outcome ?? null,
    totals: {
      mrpTotal: sum(lines.map((l) => l.mrp.times(l.quantity))),
      subtotal: sum(lines.map((l) => l.lineBase)),
      itemDiscountTotal: sum(lines.map((l) => l.promotionDiscount)),
      couponDiscountTotal: sum(lines.map((l) => l.couponDiscount)),
      netItemTotal: sum(lines.map((l) => l.netLineValue)),
    },
    now: input.now,
  };
}

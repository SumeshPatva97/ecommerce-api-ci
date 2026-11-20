/**
 * Checkout quote — API_DOCUMENTATION.md §3.9 `POST /checkout/summary` (worked example), computed
 * identically for `POST /checkout/orders` (inside the placement transaction) so the `quoteHash`
 * detects any drift. Pipeline (BACKEND_STRUCTURE.md §8–§9): cart lines → pricing engine
 * (`priceCart`, promotions + coupon via `createPricingInputLoader`) → shipping charge
 * (`computeShippingCharge`) → GST engine (`computeTax`, rates from `resolveRates`; a missing rate
 * FAILS the quote, never 0 %).
 *
 * - PROVISIONAL (OQ-06): COD only when `checkout.cod_enabled` (default false), the method supports
 *   it and the pincode allows it. The COD fee is taxed with the shipping treatment (OQ-22).
 * - PROVISIONAL (OQ-57): `checkout.max_qty_per_line` enforced again here.
 * - PROVISIONAL (OQ-07): when no method is chosen the cheapest active method is used.
 * - Place of supply = shipping address state (B2C, to be verified with a CA).
 */
import { createHash } from 'node:crypto';

import { AppError, type ErrorDetail } from '../../core/errors/AppError.js';
import type { Queryable } from '../../core/db/transaction.js';
import { canonicalJson } from '../../core/middleware/idempotency.js';
import { ZERO, toMoneyString, toMoneyStringOrNull } from '../../lib/money.js';
import {
  priceCart,
  type AppliedCoupon,
  type PricedLine,
  type PricingResult,
} from '../../lib/pricing/index.js';
import {
  computeTax,
  TaxEngineError,
  toRateString,
  toTaxBlockDto,
  type LineTaxResult,
  type TaxResult,
} from '../../lib/tax/index.js';
import { availableQuantity, isVariantSellable, itemLabel } from '../cart/cart.rules.js';
import { loadMaxQtyPerLine } from '../cart/index.js';
import { couponInvalidError } from '../coupons/index.js';
import type { AddressDto } from '../me-addresses/index.js';
import type { PricingInputLoader } from '../promotions/index.js';
import {
  computeShippingCharge,
  loadFreeShippingThreshold,
  type ShippingQuote,
} from '../shipping/index.js';
import type { ShippingMethodsService } from '../shipping/index.js';
import {
  loadTaxSettings,
  resolveRates,
  type RateResolution,
  type TaxSettings,
} from '../tax/index.js';
import type {
  CheckoutCartItem,
  CheckoutCartRow,
  CheckoutRepository,
  ShippingMethodRow,
} from './checkout.repository.js';

export type PaymentMethodInput = 'ONLINE' | 'COD';
export type ServiceabilityDto = Awaited<ReturnType<ShippingMethodsService['serviceability']>>;
type ResolvedRate = Extract<RateResolution, { ok: true }>;

export interface QuoteRequest {
  readonly shippingAddressId: string;
  readonly billingAddressId?: string | undefined;
  readonly shippingMethodId?: string | undefined;
  readonly paymentMethod: PaymentMethodInput;
  readonly buyerGstin?: string | null | undefined;
}

/** Inputs resolved OUTSIDE any transaction (address lookup, courier serviceability call). */
export interface PreparedCheckout {
  readonly userId: string;
  readonly request: QuoteRequest;
  readonly shippingAddress: AddressDto;
  readonly billingAddress: AddressDto;
  readonly serviceability: ServiceabilityDto;
}

export interface QuoteLine {
  readonly item: CheckoutCartItem;
  readonly priced: PricedLine;
  readonly tax: LineTaxResult;
  readonly rate: ResolvedRate;
}

export interface CodAvailability {
  readonly available: boolean;
  readonly reason?: 'COD_DISABLED' | 'COD_NOT_SUPPORTED' | 'COD_NOT_SERVICEABLE';
}

export interface ComputedQuote {
  readonly hash: string;
  readonly quotedAt: Date;
  readonly cart: CheckoutCartRow;
  readonly lines: readonly QuoteLine[];
  readonly pricing: PricingResult;
  readonly coupon: AppliedCoupon | null;
  readonly tax: TaxResult;
  readonly method: ShippingMethodRow;
  readonly shipping: ShippingQuote;
  readonly settings: TaxSettings & { sellerStateCode: string };
  readonly placeOfSupply: { readonly code: string; readonly name: string };
  readonly cod: CodAvailability;
  readonly dto: CheckoutSummaryDto;
}

export interface QuoteDeps {
  readonly repo: CheckoutRepository;
  readonly loader: PricingInputLoader;
}

// ── Errors ────────────────────────────────────────────────────────────────────────────────────

export function checkoutValidation(code: string, message: string, field?: string): AppError {
  return new AppError('VALIDATION_ERROR', message, {
    details: [{ ...(field === undefined ? {} : { field }), code, message }],
  });
}

function taxSettingsIncomplete(message: string): AppError {
  return new AppError('SERVICE_UNAVAILABLE', 'Checkout is temporarily unavailable.', {
    details: [{ code: 'TAX_SETTINGS_INCOMPLETE', message }],
  });
}

// ── DTO ───────────────────────────────────────────────────────────────────────────────────────

export interface CheckoutSummaryDto {
  quoteHash: string;
  quotedAt: string;
  currency: 'INR';
  pricesIncludeTax: boolean;
  supplyType: string;
  placeOfSupply: { stateCode: string; stateName: string };
  seller: { stateCode: string; gstin: string | null };
  lines: Record<string, unknown>[];
  coupon: Record<string, unknown> | null;
  shipping: Record<string, unknown>;
  totals: Record<string, string>;
  paymentMethods: { method: PaymentMethodInput; available: boolean; reason?: string }[];
  issues: { code: string }[];
}

function couponDto(coupon: AppliedCoupon | null): Record<string, unknown> | null {
  if (coupon === null) return null;
  return {
    code: coupon.code,
    discountType: coupon.discountType,
    discountValue: toMoneyString(coupon.discountValue),
    maxDiscountAmount: toMoneyStringOrNull(coupon.maxDiscountAmount),
    eligibleBase: toMoneyString(coupon.eligibleBase),
    computed: toMoneyString(coupon.computed),
    applied: toMoneyString(coupon.applied),
    capped: coupon.capped,
    allocation: coupon.allocation,
  };
}

function lineDto(line: QuoteLine): Record<string, unknown> {
  const { item, priced, tax } = line;
  return {
    cartItemId: item.id,
    variantId: item.variantId,
    sku: item.variant.sku,
    productName: item.variant.product.name,
    variantName: item.variant.name,
    hsnCode: line.rate.hsnCode,
    quantity: priced.quantity,
    mrp: toMoneyString(priced.mrp),
    unitPrice: toMoneyString(priced.unitPrice),
    lineBase: toMoneyString(priced.lineBase),
    promotion:
      priced.promotion === null
        ? null
        : {
            id: priced.promotion.id,
            label: priced.promotion.name,
            scope: priced.promotion.scope,
            discount: toMoneyString(priced.promotion.discount),
          },
    couponAllocation: toMoneyString(priced.couponDiscount),
    netLineValue: toMoneyString(priced.netLineValue),
    tax: toTaxBlockDto(tax),
    lineTotal: toMoneyString(tax.total),
  };
}

/** Deterministic fingerprint of everything the customer is charged (excludes `quotedAt`). */
export function quoteHashOf(material: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(material)).digest('hex')}`;
}

// ── Computation ───────────────────────────────────────────────────────────────────────────────

function assertLinesPurchasable(cart: CheckoutCartRow, now: Date, maxQty: number): void {
  const stock: ErrorDetail[] = [];
  const limits: ErrorDetail[] = [];
  for (const item of cart.items) {
    const v = item.variant;
    const avail = isVariantSellable(v, now) ? availableQuantity(v.inventory) : 0;
    if (item.quantity > avail) {
      stock.push({
        field: 'quantity',
        code: 'INSUFFICIENT_STOCK',
        message:
          avail <= 0
            ? `${itemLabel(v.product.name, v.name)} is out of stock.`
            : `Only ${String(avail)} of ${itemLabel(v.product.name, v.name)} available.`,
        meta: { variantId: v.id, sku: v.sku, requested: item.quantity, available: avail },
      });
    } else if (item.quantity > maxQty) {
      limits.push({
        field: 'quantity',
        code: 'MAX_QTY_PER_LINE',
        message: `You can buy at most ${String(maxQty)} of this item.`,
        meta: { variantId: v.id, max: maxQty },
      });
    }
  }
  if (stock.length > 0) {
    throw new AppError('INSUFFICIENT_STOCK', 'Some items in your cart are not available.', {
      details: stock,
    });
  }
  if (limits.length > 0) {
    throw new AppError('VALIDATION_ERROR', limits[0]?.message, { details: limits });
  }
}

function pickMethod(
  methods: readonly ShippingMethodRow[],
  quotes: readonly ShippingQuote[],
  requested: string | undefined,
): { method: ShippingMethodRow; quote: ShippingQuote } {
  const paired = methods.flatMap((method, i) => {
    const quote = quotes[i];
    return quote === undefined ? [] : [{ method, quote }];
  });
  if (requested !== undefined) {
    const chosen = paired.find((p) => p.method.id === requested);
    if (chosen === undefined) {
      throw checkoutValidation(
        'SHIPPING_METHOD_UNAVAILABLE',
        'The selected delivery method is not available.',
        'shippingMethodId',
      );
    }
    return chosen;
  }
  let best = paired[0];
  for (const p of paired) {
    if (best !== undefined && p.quote.payable.lessThan(best.quote.payable)) best = p;
  }
  if (best === undefined) {
    throw checkoutValidation(
      'SHIPPING_METHOD_UNAVAILABLE',
      'No delivery method is available.',
      'shippingMethodId',
    );
  }
  return best;
}

export async function computeQuote(
  deps: QuoteDeps,
  q: Queryable,
  prepared: PreparedCheckout,
  now: Date,
): Promise<ComputedQuote> {
  const { repo, loader } = deps;
  const { request } = prepared;
  const cart = await repo.findActiveCart(q, prepared.userId);
  if (cart === null || cart.items.length === 0) {
    throw checkoutValidation('CART_EMPTY', 'Your cart is empty.');
  }
  assertLinesPurchasable(cart, now, await loadMaxQtyPerLine(q));

  // 1. Pricing (promotions + coupon) — client prices are never used.
  const input = await loader.load(q, {
    items: cart.items.map((item) => ({
      lineId: item.id,
      variantId: item.variantId,
      productId: item.variant.productId,
      quantity: item.quantity,
      mrp: item.variant.mrp,
      sellingPrice: item.variant.sellingPrice,
    })),
    userId: prepared.userId,
    coupon: cart.couponId === null ? null : { id: cart.couponId },
    now,
  });
  const pricing = priceCart(input);
  let coupon: AppliedCoupon | null = null;
  if (cart.couponId !== null) {
    const outcome = pricing.coupon;
    if (outcome?.status !== 'APPLIED') {
      throw couponInvalidError(
        outcome === null || input.couponMissing ? { reason: 'COUPON_NOT_FOUND' } : outcome.failure,
      );
    }
    coupon = outcome;
  }

  // 2. Tax configuration (fail closed).
  const settings = await loadTaxSettings(q);
  const sellerStateCode = settings.sellerStateCode;
  if (sellerStateCode === null) {
    throw taxSettingsIncomplete('Seller GST state is not configured.');
  }
  const rates = await resolveRates(
    q,
    pricing.lines.map((l) => l.productId),
    now,
  );
  const itemById = new Map(cart.items.map((i) => [i.id, i]));
  const missing: ErrorDetail[] = [];
  const resolved: { item: CheckoutCartItem; priced: PricedLine; rate: ResolvedRate }[] = [];
  for (const priced of pricing.lines) {
    const item = itemById.get(priced.lineId);
    const rate = rates.get(priced.productId);
    if (item === undefined) continue;
    if (rate?.ok !== true) {
      missing.push({
        field: 'lines',
        code: 'TAX_NOT_CONFIGURED',
        message: `${itemLabel(item.variant.product.name, item.variant.name)} cannot be sold right now.`,
        meta: {
          variantId: item.variantId,
          reason: rate?.ok === false ? rate.reason : 'NO_ASSIGNMENT',
        },
      });
      continue;
    }
    resolved.push({ item, priced, rate });
  }
  if (missing.length > 0 || resolved.length !== cart.items.length) {
    throw new AppError('VALIDATION_ERROR', 'Some items cannot be checked out right now.', {
      details:
        missing.length > 0 ? missing : [{ code: 'TAX_NOT_CONFIGURED', message: 'Unpriced line.' }],
    });
  }

  // 3. Place of supply + shipping.
  const state = await repo.findState(q, prepared.shippingAddress.stateCode);
  if (state === null) {
    throw checkoutValidation(
      'UNKNOWN_STATE',
      'The delivery address state is invalid.',
      'shippingAddressId',
    );
  }
  const [methods, threshold, codEnabled] = await Promise.all([
    repo.listActiveMethods(q),
    loadFreeShippingThreshold(q),
    repo.codEnabled(q),
  ]);
  const quotes = methods.map((m) =>
    computeShippingCharge(m, {
      cartValue: pricing.totals.netItemTotal,
      paymentMethod: request.paymentMethod,
      globalFreeShippingThreshold: threshold,
    }),
  );
  const { method, quote: shipping } = pickMethod(methods, quotes, request.shippingMethodId);

  const cod: CodAvailability = !codEnabled
    ? { available: false, reason: 'COD_DISABLED' }
    : !method.codSupported
      ? { available: false, reason: 'COD_NOT_SUPPORTED' }
      : !prepared.serviceability.codAvailable
        ? { available: false, reason: 'COD_NOT_SERVICEABLE' }
        : { available: true };
  if (request.paymentMethod === 'COD' && !cod.available) {
    throw checkoutValidation(
      'COD_NOT_AVAILABLE',
      'Cash on delivery is not available for this order.',
      'paymentMethod',
    );
  }

  // 4. GST.
  let fixedRatePercent: string | undefined;
  if (settings.shippingTaxTreatment === 'FIXED_RATE') {
    const fixed = await repo.fixedShippingRate(q, settings.shippingFixedTaxRateId);
    if (fixed === null) throw taxSettingsIncomplete('Shipping tax rate is not configured.');
    fixedRatePercent = fixed;
  }
  let tax: TaxResult;
  try {
    tax = computeTax({
      lines: resolved.map(({ item, priced, rate }) => ({
        lineId: item.id,
        hsnCode: rate.hsnCode,
        ratePercent: rate.ratePercent,
        netLineValue: priced.netLineValue,
      })),
      shipping: {
        netCharge: shipping.payable.plus(shipping.codCharge),
        treatment: settings.shippingTaxTreatment,
        fixedRatePercent,
      },
      pricesIncludeTax: settings.pricesIncludeTax,
      seller: { stateCode: sellerStateCode },
      placeOfSupply: {
        stateCode: state.code,
        isUnionTerritoryWithoutLegislature: state.isUnionTerritory && !state.hasLegislature,
      },
      rounding: { mode: settings.roundingMode, invoiceRoundOffToRupee: settings.invoiceRoundOff },
      now,
    });
  } catch (error) {
    if (error instanceof TaxEngineError) {
      throw taxSettingsIncomplete(`Tax computation failed (${error.code}).`);
    }
    throw error;
  }
  const taxByLine = new Map(tax.lines.map((l) => [l.lineId, l]));
  const lines: QuoteLine[] = resolved.flatMap((r) => {
    const lineTax = taxByLine.get(r.item.id);
    return lineTax === undefined ? [] : [{ ...r, tax: lineTax }];
  });

  // 5. Hash + DTO.
  const t = tax.totals;
  const hash = quoteHashOf({
    v: 1,
    cartId: cart.id,
    shippingAddressId: request.shippingAddressId,
    billingAddressId: prepared.billingAddress.id,
    paymentMethod: request.paymentMethod,
    buyerGstin: request.buyerGstin ?? null,
    shippingMethodId: method.id,
    supplyType: tax.supplyType,
    coupon: coupon === null ? null : { code: coupon.code, applied: toMoneyString(coupon.applied) },
    lines: lines.map((l) => ({
      variantId: l.item.variantId,
      quantity: l.priced.quantity,
      unitPrice: toMoneyString(l.priced.unitPrice),
      promotionId: l.priced.promotion?.id ?? null,
      promotionDiscount: toMoneyString(l.priced.promotionDiscount),
      couponDiscount: toMoneyString(l.priced.couponDiscount),
      ratePercent: toRateString(l.tax.ratePercent),
      taxAmount: toMoneyString(l.tax.taxAmount),
      lineTotal: toMoneyString(l.tax.total),
    })),
    shipping: {
      charge: toMoneyString(shipping.charge),
      discount: toMoneyString(shipping.discount),
      codCharge: toMoneyString(shipping.codCharge),
    },
    totals: {
      taxTotal: toMoneyString(t.taxTotal),
      roundOff: toMoneyString(t.roundOff),
      grandTotal: toMoneyString(t.grandTotal),
    },
  });

  const youSave = pricing.totals.mrpTotal
    .minus(pricing.totals.netItemTotal)
    .plus(shipping.discount);
  const estimated =
    prepared.serviceability.estimatedDelivery ??
    (method.etaMinDays !== null && method.etaMaxDays !== null
      ? { minDays: method.etaMinDays, maxDays: method.etaMaxDays }
      : null);
  const issues: { code: string }[] = [];
  if (prepared.serviceability.serviceable === null)
    issues.push({ code: 'SERVICEABILITY_UNVERIFIED' });

  const totals: Record<string, string> = {
    subtotal: toMoneyString(pricing.totals.subtotal),
    itemDiscountTotal: toMoneyString(pricing.totals.itemDiscountTotal),
    couponDiscountTotal: toMoneyString(pricing.totals.couponDiscountTotal),
    shippingCharge: toMoneyString(shipping.charge),
    shippingDiscount: toMoneyString(shipping.discount),
    ...(shipping.codCharge.isZero() ? {} : { codCharge: toMoneyString(shipping.codCharge) }),
    taxableTotal: toMoneyString(t.taxableTotal),
    cgstTotal: toMoneyString(t.cgstTotal),
    sgstTotal: toMoneyString(t.sgstTotal),
    utgstTotal: toMoneyString(t.utgstTotal),
    igstTotal: toMoneyString(t.igstTotal),
    taxTotal: toMoneyString(t.taxTotal),
    totalBeforeRoundOff: toMoneyString(t.totalBeforeRoundOff),
    roundOff: toMoneyString(t.roundOff),
    grandTotal: toMoneyString(t.grandTotal),
    youSave: toMoneyString(youSave.isNegative() ? ZERO : youSave),
  };

  const dto: CheckoutSummaryDto = {
    quoteHash: hash,
    quotedAt: now.toISOString(),
    currency: 'INR',
    pricesIncludeTax: settings.pricesIncludeTax,
    supplyType: tax.supplyType,
    placeOfSupply: { stateCode: state.code, stateName: state.name },
    seller: { stateCode: sellerStateCode, gstin: settings.sellerGstin },
    lines: lines.map(lineDto),
    coupon: couponDto(coupon),
    shipping: {
      methodId: method.id,
      methodName: method.name,
      charge: toMoneyString(shipping.charge),
      discount: toMoneyString(shipping.discount),
      freeAbove: toMoneyStringOrNull(shipping.freeAbove),
      amountToFreeShipping: toMoneyStringOrNull(shipping.amountToFreeShipping),
      tax: {
        treatment: tax.shipping.treatment,
        taxableValue: toMoneyString(tax.shipping.taxableValue),
        components: tax.shipping.components.map((c) => ({
          component: c.component,
          amount: toMoneyString(c.amount),
        })),
        taxAmount: toMoneyString(tax.shipping.taxAmount),
      },
      estimatedDelivery: estimated,
    },
    totals,
    paymentMethods: [
      { method: 'ONLINE', available: true },
      {
        method: 'COD',
        available: cod.available,
        ...(cod.reason === undefined ? {} : { reason: cod.reason }),
      },
    ],
    issues,
  };

  return {
    hash,
    quotedAt: now,
    cart,
    lines,
    pricing,
    coupon,
    tax,
    method,
    shipping,
    settings: { ...settings, sellerStateCode },
    placeOfSupply: { code: state.code, name: state.name },
    cod,
    dto,
  };
}

/** Per-variant unit prices of a quote (kept briefly to explain a later PRICE_CHANGED). */
export interface QuoteFingerprint {
  readonly lines: readonly { variantId: string; unitPrice: string }[];
  readonly grandTotal: string;
}

export function fingerprintOf(quote: ComputedQuote): QuoteFingerprint {
  return {
    lines: quote.lines.map((l) => ({
      variantId: l.item.variantId,
      unitPrice: toMoneyString(l.priced.unitPrice),
    })),
    grandTotal: toMoneyString(quote.tax.totals.grandTotal),
  };
}

/** 409 PRICE_CHANGED with per-line `{ old, new }` when the previous quote is known (API §3.9). */
export function priceChangedError(
  previous: QuoteFingerprint | undefined,
  current: ComputedQuote,
): AppError {
  const details: ErrorDetail[] = [];
  if (previous !== undefined) {
    const old = new Map(previous.lines.map((l) => [l.variantId, l.unitPrice]));
    current.lines.forEach((l, index) => {
      const before = old.get(l.item.variantId);
      const now = toMoneyString(l.priced.unitPrice);
      if (before !== undefined && before !== now) {
        details.push({
          field: `lines[${String(index)}].unitPrice`,
          code: 'PRICE_CHANGED',
          message: 'The price of this item has changed.',
          meta: { variantId: l.item.variantId, old: before, new: now },
        });
      }
    });
  }
  if (details.length === 0) {
    details.push({
      field: 'quoteHash',
      code: 'PRICE_CHANGED',
      message: 'The order total has changed.',
      meta: {
        ...(previous === undefined ? {} : { oldGrandTotal: previous.grandTotal }),
        newGrandTotal: toMoneyString(current.tax.totals.grandTotal),
      },
    });
  }
  return new AppError(
    'PRICE_CHANGED',
    'Prices in your cart have changed. Please review the updated summary.',
    { details },
  );
}

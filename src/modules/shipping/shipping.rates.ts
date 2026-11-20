/**
 * Shipping charge rules — PROVISIONAL (OQ-07): domestic only; flat charge per method, free when the
 * cart value reaches the method's `free_above_amount` (or, for `FREE_ABOVE` methods without their
 * own threshold, the `shipping.free_shipping_threshold` setting). `WEIGHT_BASED` / `ZONE_BASED`
 * rate types are not implemented in v1 and price as `FLAT` (base charge).
 *
 * Exported for checkout: `computeShippingCharge` is pure (Decimal money, never float). The
 * checkout/orders module stores `charge` as `orders.shipping_charge` and `discount` as
 * `orders.shipping_discount`; `codCharge` → `orders.cod_charge` for COD orders.
 */
import type { Queryable } from '../../core/db/transaction.js';
import type { ShippingRateType } from '../../generated/prisma/enums.js';
import {
  dec,
  roundMoney,
  toMoneyString,
  toMoneyStringOrNull,
  ZERO,
  type Decimal,
  type DecimalInput,
} from '../../lib/money.js';

export interface RateMethod {
  readonly rateType: ShippingRateType;
  readonly baseCharge: DecimalInput;
  readonly freeAboveAmount: DecimalInput | null;
  readonly codSupported: boolean;
  readonly codCharge: DecimalInput;
}

export interface RateContext {
  /** Cart value the threshold is compared against (after item discounts, before shipping). */
  readonly cartValue: DecimalInput;
  readonly paymentMethod?: 'ONLINE' | 'COD' | undefined;
  /** `shipping.free_shipping_threshold` setting (used only by FREE_ABOVE methods without their own). */
  readonly globalFreeShippingThreshold?: DecimalInput | null | undefined;
}

export interface ShippingQuote {
  readonly charge: Decimal;
  readonly discount: Decimal;
  readonly payable: Decimal;
  readonly isFree: boolean;
  readonly freeAbove: Decimal | null;
  /** Amount still needed for free shipping (null when already free or no threshold). */
  readonly amountToFreeShipping: Decimal | null;
  readonly codAllowed: boolean;
  /** COD fee when `paymentMethod = COD` and allowed, else zero. */
  readonly codCharge: Decimal;
}

export function effectiveFreeAbove(
  method: RateMethod,
  globalThreshold: DecimalInput | null | undefined,
): Decimal | null {
  if (method.freeAboveAmount !== null) return dec(method.freeAboveAmount);
  if (
    method.rateType === 'FREE_ABOVE' &&
    globalThreshold !== null &&
    globalThreshold !== undefined
  ) {
    return dec(globalThreshold);
  }
  return null;
}

export function computeShippingCharge(method: RateMethod, ctx: RateContext): ShippingQuote {
  const charge = roundMoney(method.baseCharge);
  const cartValue = dec(ctx.cartValue);
  if (cartValue.isNegative()) throw new RangeError('cartValue must be ≥ 0');
  const freeAbove = effectiveFreeAbove(method, ctx.globalFreeShippingThreshold);
  const isFree = charge.isZero() || (freeAbove !== null && cartValue.gte(freeAbove));
  const discount = isFree ? charge : ZERO;
  const codAllowed = method.codSupported;
  return {
    charge,
    discount: roundMoney(discount),
    payable: roundMoney(charge.minus(discount)),
    isFree,
    freeAbove,
    amountToFreeShipping:
      isFree || freeAbove === null ? null : roundMoney(freeAbove.minus(cartValue)),
    codAllowed,
    codCharge: ctx.paymentMethod === 'COD' && codAllowed ? roundMoney(method.codCharge) : ZERO,
  };
}

export interface ShippingQuoteDto {
  readonly charge: string;
  readonly discount: string;
  readonly payable: string;
  readonly isFree: boolean;
  readonly freeAbove: string | null;
  readonly amountToFreeShipping: string | null;
}

export function toQuoteDto(quote: ShippingQuote): ShippingQuoteDto {
  return {
    charge: toMoneyString(quote.charge),
    discount: toMoneyString(quote.discount),
    payable: toMoneyString(quote.payable),
    isFree: quote.isFree,
    freeAbove: toMoneyStringOrNull(quote.freeAbove),
    amountToFreeShipping: toMoneyStringOrNull(quote.amountToFreeShipping),
  };
}

const MONEY = /^\d{1,10}(\.\d{1,2})?$/;

/** Reads `shipping.free_shipping_threshold` (decimal string); null when unset/invalid. */
export async function loadFreeShippingThreshold(db: Queryable): Promise<Decimal | null> {
  const row = await db.setting.findUnique({
    where: { settingKey: 'shipping.free_shipping_threshold' },
    select: { value: true },
  });
  const value = row?.value;
  return typeof value === 'string' && MONEY.test(value) ? dec(value) : null;
}

/** Reads a boolean setting; `fallback` when missing or not boolean. */
export async function loadBooleanSetting(
  db: Queryable,
  key: string,
  fallback: boolean,
): Promise<boolean> {
  const row = await db.setting.findUnique({ where: { settingKey: key }, select: { value: true } });
  return typeof row?.value === 'boolean' ? row.value : fallback;
}

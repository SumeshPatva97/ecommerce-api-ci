/**
 * Cart DTO — API_DOCUMENTATION.md §3.4 (every cart endpoint returns it). Money as 2-dp strings;
 * exact stock is never exposed (status + `maxPurchasable` only).
 *
 * Lines that cannot be bought right now (product/variant unavailable, out of stock) are shown with
 * their issues but excluded from the totals and from coupon evaluation.
 */
import { ZERO, toMoneyString, type Decimal } from '../../lib/money.js';
import type { AppliedCoupon, PricedLine, PricingTotals } from '../../lib/pricing/index.js';
import { IMAGE_WIDTHS, deliveryUrl, type MediaDelivery } from '../media/cloudinary.js';
import type { CartItemRow } from './cart.repository.js';
import { availability, type CartWarning, type LineState } from './cart.rules.js';

export interface TaxEstimate {
  readonly amount: Decimal;
  readonly pricesIncludeTax: boolean;
}

export interface CartView {
  readonly cartId: string;
  readonly items: readonly { readonly row: CartItemRow; readonly state: LineState }[];
  readonly priced: ReadonlyMap<string, PricedLine>;
  readonly totals: PricingTotals;
  readonly coupon: AppliedCoupon | null;
  readonly tax: TaxEstimate;
  readonly warnings: readonly CartWarning[];
  readonly maxQtyPerLine: number;
}

function image(
  delivery: MediaDelivery,
  row: CartItemRow,
): { thumbUrl: string; altText: string | null } | null {
  const img = row.variant.images[0] ?? row.variant.product.images[0];
  if (img === undefined) return null;
  return {
    thumbUrl: deliveryUrl(delivery, img.cloudinaryPublicId, IMAGE_WIDTHS.thumb),
    altText: img.altText,
  };
}

export function toCartDto(view: CartView, delivery: MediaDelivery) {
  const items = view.items.map(({ row, state }) => {
    const v = row.variant;
    const priced = view.priced.get(row.id);
    const lineBase = priced?.lineBase ?? v.sellingPrice.times(state.quantity);
    const promotion = priced?.promotion ?? null;
    return {
      id: row.id,
      variantId: row.variantId,
      productId: v.product.id,
      productSlug: v.product.slug,
      productName: v.product.name,
      variantName: v.name,
      sku: v.sku,
      image: image(delivery, row),
      quantity: state.quantity,
      mrp: toMoneyString(v.mrp),
      unitPrice: toMoneyString(v.sellingPrice),
      lineBase: toMoneyString(lineBase),
      promotion:
        promotion === null
          ? null
          : {
              id: promotion.id,
              label: promotion.name,
              discount: toMoneyString(promotion.discount),
            },
      couponDiscount: toMoneyString(priced?.couponDiscount ?? ZERO),
      lineNet: toMoneyString(priced?.netLineValue ?? lineBase),
      availability: availability(v.inventory, view.maxQtyPerLine),
      issues: state.issues,
    };
  });
  const t = view.totals;
  const estimatedTotal = view.tax.pricesIncludeTax
    ? t.netItemTotal
    : t.netItemTotal.plus(view.tax.amount);
  return {
    id: view.cartId,
    items,
    coupon:
      view.coupon === null
        ? null
        : {
            code: view.coupon.code,
            discount: toMoneyString(view.coupon.applied),
            description: view.coupon.description,
          },
    totals: {
      subtotal: toMoneyString(t.subtotal),
      itemDiscountTotal: toMoneyString(t.itemDiscountTotal),
      couponDiscountTotal: toMoneyString(t.couponDiscountTotal),
      // Shipping and final tax appear only in POST /checkout/summary (needs an address).
      shippingCharge: null,
      estimatedTaxIncluded: toMoneyString(view.tax.amount),
      estimatedTotal: toMoneyString(estimatedTotal),
      pricesIncludeTax: view.tax.pricesIncludeTax,
    },
    itemCount: items.reduce((n, i) => n + i.quantity, 0),
    warnings: view.warnings,
  };
}

export type CartDto = ReturnType<typeof toCartDto>;

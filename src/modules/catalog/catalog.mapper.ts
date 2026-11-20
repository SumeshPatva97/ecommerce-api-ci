/**
 * Public DTOs — API_DOCUMENTATION.md §3.3. Money as 2-dp strings; exact stock is never exposed
 * (only status + `maxPurchasable` capped at the per-line max); never `costPrice`.
 *
 * PROVISIONAL: no promotion engine exists yet (OQ-14 pricing engine is a later increment), so the
 * effective price equals the variant selling price and `promotion`/`promotionLabel` are null.
 */
import { Decimal, toMoneyString } from '../../lib/money.js';
import { IMAGE_WIDTHS, deliveryUrl, imageUrls, type MediaDelivery } from '../media/cloudinary.js';
import {
  DEFAULT_LOW_STOCK_THRESHOLD,
  MAX_QTY_PER_LINE,
  discountPercent,
} from '../products/products.rules.js';
import type { CardRow, PublicVariantRow } from './catalog.repository.js';

export type AvailabilityStatus = 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK';

export function variantAvailability(v: Pick<PublicVariantRow, 'inventory'>): {
  status: AvailabilityStatus;
  maxPurchasable: number;
} {
  const inv = v.inventory;
  const available = inv === null ? 0 : inv.quantityOnHand - inv.quantityReserved;
  // PROVISIONAL (OQ-47): per-variant threshold, else global default 5.
  const threshold = inv?.lowStockThreshold ?? DEFAULT_LOW_STOCK_THRESHOLD;
  const status: AvailabilityStatus =
    available <= 0 ? 'OUT_OF_STOCK' : available <= threshold ? 'LOW_STOCK' : 'IN_STOCK';
  // PROVISIONAL (OQ-57): maxQtyPerLine default 5.
  return { status, maxPurchasable: Math.max(0, Math.min(available, MAX_QTY_PER_LINE)) };
}

/** SIMPLE → default variant; VARIABLE → first in-stock by sort order, else the first. */
export function defaultVariantId(
  productType: string,
  variants: readonly Pick<PublicVariantRow, 'id' | 'isDefault' | 'inventory'>[],
): string | null {
  if (productType === 'SIMPLE')
    return (variants.find((v) => v.isDefault) ?? variants[0])?.id ?? null;
  const inStock = variants.find((v) => variantAvailability(v).status !== 'OUT_OF_STOCK');
  return (inStock ?? variants[0])?.id ?? null;
}

/**
 * FR-AD-008 / OQ-50: the new-arrival window is the `catalog.new_arrival_days` setting (int 1–365);
 * 30 days when the setting is missing or invalid (`loadNewArrivalDays`, catalog.repository.ts).
 */
export const DEFAULT_NEW_ARRIVAL_DAYS = 30;
export const MAX_NEW_ARRIVAL_DAYS = 365;
export const NEW_ARRIVAL_DAYS_SETTING_KEY = 'catalog.new_arrival_days';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Start of the new-arrival window: products published at or after it count as new. */
export function newArrivalCutoff(now: Date, newArrivalDays: number): Date {
  return new Date(now.getTime() - newArrivalDays * DAY_MS);
}

export function isNewArrival(
  p: Pick<CardRow, 'isNewArrival' | 'publishedAt'>,
  now: Date,
  newArrivalDays: number = DEFAULT_NEW_ARRIVAL_DAYS,
): boolean {
  if (p.isNewArrival) return true;
  return (
    p.publishedAt !== null &&
    p.publishedAt.getTime() >= newArrivalCutoff(now, newArrivalDays).getTime()
  );
}

export function mapCard(
  p: CardRow,
  delivery: MediaDelivery,
  now: Date,
  matchVariantIds?: ReadonlySet<string>,
  newArrivalDays: number = DEFAULT_NEW_ARRIVAL_DAYS,
) {
  const prices = p.variants.map((v) => v.sellingPrice);
  const mrps = p.variants.map((v) => v.mrp);
  const min = prices.length > 0 ? Decimal.min(...prices) : null;
  const max = prices.length > 0 ? Decimal.max(...prices) : null;
  const availabilities = p.variants.map((v) => variantAvailability(v));
  const inStockStatuses = availabilities.filter((a) => a.status !== 'OUT_OF_STOCK');
  const swatches = new Map<
    string,
    { attribute: string; value: string; label: string; hex: string | null }
  >();
  for (const v of p.variants) {
    for (const link of v.variantValues) {
      if (link.attribute.displayType !== 'SWATCH') continue;
      const key = `${link.attribute.code}:${link.attributeValue.slug}`;
      if (!swatches.has(key)) {
        swatches.set(key, {
          attribute: link.attribute.code,
          value: link.attributeValue.slug,
          label: link.attributeValue.value,
          hex: link.attributeValue.swatchHex,
        });
      }
    }
  }
  const image = (i: { cloudinaryPublicId: string; altText: string | null } | undefined) =>
    i === undefined
      ? null
      : { url: deliveryUrl(delivery, i.cloudinaryPublicId, IMAGE_WIDTHS.card), altText: i.altText };
  const badges: string[] = [];
  if (isNewArrival(p, now, newArrivalDays)) badges.push('NEW_ARRIVAL');
  // PROVISIONAL (OQ-50): best seller = admin pin (90-day unit ranking needs order analytics).
  if (p.isBestSellerPinned) badges.push('BEST_SELLER');

  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    productType: p.productType,
    brand: p.brand,
    category: p.category,
    primaryImage: image(p.images[0]),
    hoverImage: image(p.images[1]),
    price: {
      min: min === null ? null : toMoneyString(min),
      max: max === null ? null : toMoneyString(max),
      mrpMin: mrps.length > 0 ? toMoneyString(Decimal.min(...mrps)) : null,
      mrpMax: mrps.length > 0 ? toMoneyString(Decimal.max(...mrps)) : null,
      hasRange: min !== null && max !== null && !min.eq(max),
      discountPercentMax: p.variants.reduce(
        (best, v) => Math.max(best, discountPercent(v.mrp, v.sellingPrice)),
        0,
      ),
      promotionLabel: null,
    },
    availability: {
      inStock: inStockStatuses.length > 0,
      lowStock:
        inStockStatuses.length > 0 && inStockStatuses.every((a) => a.status === 'LOW_STOCK'),
    },
    badges,
    rating: { average: p.avgRating.toFixed(2), count: p.reviewCount },
    swatches: [...swatches.values()],
    defaultVariantId: defaultVariantId(p.productType, p.variants),
    ...(matchVariantIds === undefined
      ? {}
      : {
          matchedVariants: p.variants
            .filter((v) => matchVariantIds.has(v.id))
            .map((v) => ({
              variantId: v.id,
              sku: v.sku,
              variantName: v.name,
              mrp: toMoneyString(v.mrp),
              unitPrice: toMoneyString(v.sellingPrice),
              availability: variantAvailability(v),
            })),
        }),
  };
}
export type ProductCardDto = ReturnType<typeof mapCard>;

export function mapImageDto(
  delivery: MediaDelivery,
  img: {
    id: string;
    variantId: string | null;
    cloudinaryPublicId: string;
    altText: string | null;
    sortOrder: number;
  },
) {
  return {
    id: img.id,
    variantId: img.variantId,
    publicId: img.cloudinaryPublicId,
    ...imageUrls(delivery, img.cloudinaryPublicId),
    altText: img.altText,
    sortOrder: img.sortOrder,
  };
}

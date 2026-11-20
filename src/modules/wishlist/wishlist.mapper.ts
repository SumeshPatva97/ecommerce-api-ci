/**
 * Wishlist item DTO — API_DOCUMENTATION.md §3.5 (`{ id, productId, productSlug, name, image,
 * price{min,max}, availability, variantId?, addedAt }`). Reuses the public listing-card mapper so
 * prices/availability match the catalogue; never exposes exact stock or cost.
 */
import { mapCard } from '../catalog/catalog.mapper.js';
import { isProductSellable } from '../cart/cart.rules.js';
import type { MediaDelivery } from '../media/cloudinary.js';
import type { WishlistItemRow } from './wishlist.repository.js';

export function toWishlistItemDto(row: WishlistItemRow, delivery: MediaDelivery, now: Date) {
  const card = mapCard(row.product, delivery, now);
  const isAvailable = isProductSellable(row.product, now) && row.product.variants.length > 0;
  return {
    id: row.id,
    productId: row.productId,
    productSlug: card.slug,
    name: card.name,
    image: card.primaryImage,
    price: { min: card.price.min, max: card.price.max },
    availability: { ...card.availability, isAvailable },
    variantId: row.variantId,
    addedAt: row.createdAt.toISOString(),
  };
}

export type WishlistItemDto = ReturnType<typeof toWishlistItemDto>;
